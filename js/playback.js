// テスト再生器。buildTimeline の列を setTimeout で順に流し、音声認識（speech.js）と同じ形のイベントを出す。
// ブラウザ用だが window・DOM は使わないので Node でも import できる。
import { buildTimeline } from './playback-script.js';

/**
 * @param {object} opts
 * @param {string} opts.text 流す英文（空行で段落を区切る）
 * @param {number} [opts.wpm=150]
 * @param {number} [opts.speed=1] 再生速度の倍率（2 なら2倍速）
 * @param {boolean} [opts.punctuate=true]
 * @param {number} [opts.seed=1]
 */
export function createPlayback({ text, wpm = 150, speed = 1, punctuate = true, seed = 1 } = {}) {
  const handlers = { interim: [], final: [], state: [], end: [] };
  let timeline = [];
  let pos = 0;          // 次に流す要素の位置
  let prevAt = 0;       // 直前に流した要素の at
  let timer = null;
  let running = false;
  let curSpeed = validSpeed(speed) ? speed : 1;

  function validSpeed(n) { return typeof n === 'number' && Number.isFinite(n) && n > 0; }

  function emit(name, arg) {
    for (const fn of handlers[name].slice()) {
      try { fn(arg); } catch (e) { console.error(e); }
    }
  }

  // 次の1件を予約する。待ち時間は「前の要素との差 ÷ 速度」なので、途中で速度を変えても次から効く
  function scheduleNext() {
    if (!running) return;
    if (pos >= timeline.length) { finish('再生が終わりました'); return; }
    const ev = timeline[pos];
    const wait = Math.max(0, (ev.at - prevAt) / curSpeed);
    timer = setTimeout(() => {
      timer = null;
      if (!running) return;
      pos++;
      prevAt = ev.at;
      emit(ev.type, ev.text);
      scheduleNext();
    }, wait);
  }

  function finish(message) {
    if (!running) return;
    running = false;
    if (timer) { clearTimeout(timer); timer = null; }
    emit('state', { kind: 'ok', message });
    emit('end');
  }

  return {
    // 最初から再生する（再生中に呼んだら何もしない）
    start() {
      if (running) return;
      timeline = buildTimeline(text, { wpm, punctuate, seed });
      pos = 0; prevAt = 0;
      running = true;
      if (!timeline.length) {
        emit('state', { kind: 'warn', message: 'テスト再生する英文がありません' });
        running = false;
        emit('end');
        return;
      }
      emit('state', { kind: 'ok', message: `テスト再生中（${curSpeed}倍速）` });
      scheduleNext();
    },
    // 止める。止めたあとは何も流さない
    stop() { finish('停止'); },
    // 再生速度を変える（0以下や数値以外は無視）。予約中の1件は待ち直す
    setSpeed(n) {
      if (!validSpeed(n)) return;
      curSpeed = n;
      if (running && timer) { clearTimeout(timer); timer = null; scheduleNext(); }
    },
    // イベントの登録。戻り値は登録解除の関数
    on(event, fn) {
      if (!handlers[event] || typeof fn !== 'function') return () => {};
      handlers[event].push(fn);
      return () => { const i = handlers[event].indexOf(fn); if (i >= 0) handlers[event].splice(i, 1); };
    },
  };
}
