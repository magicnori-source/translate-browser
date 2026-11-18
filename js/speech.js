// 音声認識（Web Speech API）を包む。ブラウザ用。
// 画面・タブ音声の取得（getDisplayMedia）は app 側で行い、その音声トラックを audioTrack で受け取る。
// イベントの出し方は playback.js と同じ（interim / final / state / end）。

/**
 * @param {object} opts
 * @param {string} opts.lang 認識する言語（例 'en-US'）
 * @param {MediaStreamTrack|null} [opts.audioTrack] 画面・タブ音声のトラック。なければマイク
 */
export function createSpeechSource({ lang, audioTrack = null } = {}) {
  const handlers = { interim: [], final: [], state: [], end: [] };
  let running = false;
  let rec = null;
  let gen = 0;            // 認識インスタンスの世代。古いインスタンスのイベントを無視するため
  let restartTimer = null;

  function emit(name, arg) {
    for (const fn of handlers[name].slice()) {
      try { fn(arg); } catch (e) { console.error(e); }
    }
  }
  function getSR() {
    const g = typeof self !== 'undefined' ? self : globalThis;
    return g.SpeechRecognition || g.webkitSpeechRecognition || null;
  }

  function newRecognition(SR, myGen) {
    const r = new SR();
    r.lang = lang; r.continuous = true; r.interimResults = true;
    r.onresult = ev => {
      if (myGen !== gen || !running) return;
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i], txt = res[0].transcript.trim();
        if (res.isFinal) { if (txt) emit('final', txt); }
        else if (txt) interim += (interim ? ' ' : '') + txt;
      }
      if (interim) emit('interim', interim);
    };
    r.onerror = e => {
      if (myGen !== gen || !running) return;
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        emit('state', { kind: 'err', message: 'マイク／音声の利用が許可されていません' });
        stopInternal();
        return;
      }
      emit('state', { kind: 'err', message: 'エラー: ' + e.error });
    };
    // 無音などで止まっても、動作中なら自動で再開する
    r.onend = () => {
      if (myGen !== gen || !running) return;
      clearTimeout(restartTimer);
      restartTimer = setTimeout(startRecognition, 250);
    };
    return r;
  }

  function startRecognition() {
    restartTimer = null;
    if (!running) return;
    const SR = getSR();
    const myGen = ++gen;
    rec = newRecognition(SR, myGen);
    try {
      if (audioTrack) rec.start(audioTrack); else rec.start();
      emit('state', { kind: 'ok', message: audioTrack ? '取り込み中（画面・タブ音声）' : '取り込み中（マイク）' });
    } catch (e) {
      if (audioTrack) emit('state', { kind: 'err', message: 'このブラウザは画面音声の直接取り込みに未対応。マイクを使ってください' });
      else emit('state', { kind: 'err', message: '開始失敗: ' + (e && e.message ? e.message : e) });
      stopInternal();
    }
  }

  function stopInternal() {
    if (!running) return;
    running = false;
    gen++; // これ以降、古いインスタンスのイベントは無視する
    clearTimeout(restartTimer); restartTimer = null;
    const r = rec; rec = null;
    if (r) { try { r.abort(); } catch (e) { /* 止まっていれば無視 */ } }
    emit('end');
  }

  return {
    start() {
      if (running) return;
      if (!getSR()) {
        emit('state', { kind: 'err', message: 'このブラウザは音声認識に対応していません（Chrome／Edgeを使ってください）' });
        emit('end');
        return;
      }
      running = true;
      startRecognition();
    },
    // 止める。止めたあとは自動再開しない
    stop() {
      if (!running) return;
      emit('state', { kind: 'ok', message: '停止' });
      stopInternal();
    },
    // イベントの登録。戻り値は登録解除の関数
    on(event, fn) {
      if (!handlers[event] || typeof fn !== 'function') return () => {};
      handlers[event].push(fn);
      return () => { const i = handlers[event].indexOf(fn); if (i >= 0) handlers[event].splice(i, 1); };
    },
  };
}
