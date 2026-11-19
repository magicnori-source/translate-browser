// 翻訳の順番待ち（純粋モジュール）
// - 速報・段落訳: Translator を使う1本の直列レーン（段落訳を優先、速報は間引く）
// - 仕上げ訳: Prompt API を使う別の直列レーン（先着順、待ちあふれと時間切れで捨てる。pauseRefine で一時停止できる）
// 時刻とタイマーは now / schedule で外から受け取る（Date.now や setTimeout は直接使わない）。

const NOOP = () => {};

export function createTranslateQueue({
  translate,
  refine = null,
  now,
  schedule,
  flashIntervalMs = 1000,
  refineTimeoutMs = 20000,
  maxRefineBacklog = 3,
  translateTimeoutMs = 15000,
  maxParagraphBacklog = 5,
} = {}) {
  if (typeof translate !== 'function') throw new TypeError('translate 関数が必要です');
  if (typeof now !== 'function') throw new TypeError('now 関数が必要です');
  if (typeof schedule !== 'function') throw new TypeError('schedule 関数が必要です');

  const listeners = new Map(); // event -> Set<fn>

  // clear() のたびに増やし、古い処理の結果を捨てる
  let generation = 0;

  // ---- 速報・段落訳レーン ----
  let flashEnabled = true;
  let flashSlot = null;         // 待ち中の速報（最新の1件だけ）
  let flashTimer = null;        // 間隔待ちのタイマー解除関数
  let lastFlashAt = null;       // 前回速報を送った時刻
  let paraQueue = [];           // 待ち中の段落訳 [{paraId, src, version}]（同じ段落は差し替え）
  let tTask = null;             // 実行中 {kind:'flash'|'paragraph', cancelTimeout}

  // ---- 仕上げ訳レーン ----
  let refineQueue = [];         // 待ち中 [{paraId, src, contextParas}]
  let rTask = null;             // 実行中 {paraId, controller, cancelTimeout, startedAt}
  let refineRequested = new Set(); // 1段落1回にするための記録
  let refinePaused = false;     // true のあいだ新しい仕上げ訳を始めない（要約などで内蔵LLMを譲る）
  let idleWaiters = [];         // whenRefineIdle() の解決関数

  // ---- 状態 ----
  let dropped = 0;
  let lastRefineMs = null;
  let lastStatsKey = '';

  // ---------------- イベント ----------------
  function on(event, fn) {
    if (typeof fn !== 'function') return NOOP;
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  }

  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (error) {
        // 受け手の例外でキューを止めない
        if (event !== 'error') emit('error', { lane: 'listener', error });
      }
    }
  }

  function stats() {
    return {
      translateQueued: paraQueue.length + (flashSlot ? 1 : 0),
      refineQueued: refineQueue.length,
      dropped,
      lastRefineMs,
      translateBusy: !!tTask,
      refineBusy: !!rTask,
      refinePaused,
    };
  }

  // 状態が変わったときだけ 'stats' を出す
  function emitStats() {
    const s = stats();
    const key = JSON.stringify(s);
    if (key === lastStatsKey) return;
    lastStatsKey = key;
    emit('stats', s);
  }

  // 同期で例外を投げる関数も Promise にそろえる
  function call(fn, ...args) {
    try {
      return Promise.resolve(fn(...args));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  // ---------------- 速報・段落訳レーン ----------------
  function cancelFlashTimer() {
    if (flashTimer) {
      flashTimer();
      flashTimer = null;
    }
  }

  function dropFlashSlot() {
    if (flashSlot) {
      flashSlot = null;
      dropped++;
    }
    cancelFlashTimer();
  }

  function requestFlash(text) {
    if (!flashEnabled) return;
    if (typeof text !== 'string' || !text.trim()) return;
    // 段落訳が待ち中か翻訳中なら速報は捨てる
    if (paraQueue.length > 0 || tTask?.kind === 'paragraph') {
      dropped++;
      emitStats();
      return;
    }
    if (flashSlot) dropped++; // 古い速報を最新で置き換える
    flashSlot = { text };
    pumpTranslate();
    emitStats();
  }

  function requestParagraph(paraId, src, version) {
    if (typeof src !== 'string' || !src.trim()) return;
    const item = { paraId, src, version };
    const i = paraQueue.findIndex((p) => p.paraId === paraId);
    if (i >= 0) {
      // 同じ段落は最新の依頼で差し替える（順番は保つ）
      paraQueue[i] = item;
      dropped++;
    } else {
      paraQueue.push(item);
      // 念のため上限を設ける（古いものから捨てる）
      while (paraQueue.length > maxParagraphBacklog) {
        paraQueue.shift();
        dropped++;
      }
    }
    // 段落訳を優先するため、待ち中の速報は捨てる
    dropFlashSlot();
    pumpTranslate();
    emitStats();
  }

  function pumpTranslate() {
    if (tTask) return;
    if (paraQueue.length > 0) {
      cancelFlashTimer();
      const item = paraQueue.shift();
      runTranslate('paragraph', item.src, (ja) => {
        emit('paragraph', { paraId: item.paraId, ja, version: item.version });
      });
      return;
    }
    if (flashSlot && flashEnabled) {
      const wait = lastFlashAt == null ? 0 : lastFlashAt + flashIntervalMs - now();
      if (wait > 0) {
        if (!flashTimer) {
          flashTimer = schedule(() => {
            flashTimer = null;
            pumpTranslate();
            emitStats();
          }, wait);
        }
        return;
      }
      const { text } = flashSlot;
      flashSlot = null;
      lastFlashAt = now();
      runTranslate('flash', text, (ja) => {
        if (flashEnabled) emit('flash', { text, ja });
      });
    }
  }

  function runTranslate(kind, text, onResult) {
    const gen = generation;
    let done = false;
    const task = { kind, cancelTimeout: NOOP };
    tTask = task;

    const finish = () => {
      if (done) return false;
      done = true;
      task.cancelTimeout();
      if (gen !== generation || tTask !== task) return false; // clear 後の古い結果
      tTask = null;
      return true;
    };

    task.cancelTimeout = schedule(() => {
      if (!finish()) return;
      emit('error', { lane: 'translate', error: new Error('翻訳が時間切れになりました') });
      pumpTranslate();
      emitStats();
    }, translateTimeoutMs) || NOOP;

    call(translate, text).then(
      (ja) => {
        if (!finish()) return;
        if (typeof ja === 'string') onResult(ja);
        else emit('error', { lane: 'translate', error: new Error('翻訳結果が文字列ではありません') });
        pumpTranslate();
        emitStats();
      },
      (error) => {
        if (!finish()) return;
        emit('error', { lane: 'translate', error });
        pumpTranslate();
        emitStats();
      },
    );
  }

  // ---------------- 仕上げ訳レーン ----------------
  function requestRefine(paraId, src, contextParas = []) {
    if (typeof refine !== 'function') return; // Prompt API なし: 段落訳のまま
    if (refineRequested.has(paraId)) return;  // 1段落1回
    refineRequested.add(paraId);
    refineQueue.push({ paraId, src, contextParas });
    // 待ちが上限を超えたら古いものを捨てる
    while (refineQueue.length > maxRefineBacklog) {
      const old = refineQueue.shift();
      dropped++;
      emit('refine-skipped', { paraId: old.paraId, reason: 'backlog' });
    }
    pumpRefine();
    emitStats();
  }

  // 実行中の仕上げ訳がないとき、待っている whenRefineIdle() をすべて解決する
  function resolveIdleWaiters() {
    if (rTask || idleWaiters.length === 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function pumpRefine() {
    if (rTask || refinePaused || refineQueue.length === 0) return;
    const item = refineQueue.shift();
    const gen = generation;
    const controller = new AbortController();
    const task = { paraId: item.paraId, controller, cancelTimeout: NOOP, startedAt: now() };
    rTask = task;
    let done = false;

    const finish = () => {
      if (done) return false;
      done = true;
      task.cancelTimeout();
      if (gen !== generation || rTask !== task) return false;
      rTask = null;
      lastRefineMs = now() - task.startedAt;
      resolveIdleWaiters();
      return true;
    };

    const next = () => {
      pumpRefine();
      emitStats();
    };

    task.cancelTimeout = schedule(() => {
      if (!finish()) return;
      controller.abort();
      emit('refine-skipped', { paraId: item.paraId, reason: 'timeout' });
      next();
    }, refineTimeoutMs) || NOOP;

    call(refine, item.paraId, item.src, item.contextParas, controller.signal).then(
      (ja) => {
        if (!finish()) return;
        if (typeof ja === 'string' && ja.trim()) {
          emit('refined', { paraId: item.paraId, ja });
        } else {
          emit('refine-skipped', { paraId: item.paraId, reason: 'invalid' });
        }
        next();
      },
      (error) => {
        if (!finish()) return;
        emit('error', { lane: 'refine', error });
        emit('refine-skipped', { paraId: item.paraId, reason: 'error' });
        next();
      },
    );
  }

  // 仕上げ訳の一時停止。実行中のものは最後まで続け、依頼は待ちに入れる（上限超えは従来どおり捨てる）
  function pauseRefine(on) {
    refinePaused = !!on;
    if (!refinePaused) pumpRefine();
    emitStats();
  }

  // 実行中の仕上げ訳がなくなったら解決する（なければすぐ解決。clear() でも解決）
  function whenRefineIdle() {
    if (!rTask) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  // ---------------- 操作 ----------------
  function setFlashEnabled(enabled) {
    flashEnabled = !!enabled;
    if (!flashEnabled) {
      if (flashSlot) flashSlot = null; // OFF にしたときの破棄は dropped に数えない
      cancelFlashTimer();
    }
    emitStats();
  }

  function clear() {
    generation++;
    // 速報・段落訳
    cancelFlashTimer();
    flashSlot = null;
    paraQueue = [];
    lastFlashAt = null;
    if (tTask) {
      tTask.cancelTimeout();
      tTask = null;
    }
    // 仕上げ訳
    refineQueue = [];
    if (rTask) {
      rTask.cancelTimeout();
      rTask.controller.abort();
      rTask = null;
    }
    refineRequested = new Set();
    refinePaused = false;
    resolveIdleWaiters();
    dropped = 0;
    lastRefineMs = null;
    emitStats();
  }

  return {
    requestFlash,
    requestParagraph,
    requestRefine,
    pauseRefine,
    whenRefineIdle,
    on,
    setFlashEnabled,
    clear,
    stats,
  };
}
