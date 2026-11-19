// 音声認識（Web Speech API）を包む。ブラウザ用。
// 画面・タブ音声の取得（getDisplayMedia）は app 側で行い、その音声トラックを audioTrack で受け取る。
// イベントの出し方は playback.js と同じ（interim / final / state / end）。
//
// 方針: 音声はPCの中だけで認識し、外部（クラウドの認識サービス）には送らない。
// PC内で認識できないときは、クラウド認識に切り替えずに「認識できない」と知らせて止める。

const LOCAL_STATES = ['available', 'downloadable', 'downloading', 'unavailable'];
const NO_LOCAL_MESSAGE = 'このブラウザはPC内の音声認識に対応していません（このアプリは音声を外部に送らないため、認識できません）';

function getSR() {
  const g = typeof self !== 'undefined' ? self : globalThis;
  return g.SpeechRecognition || g.webkitSpeechRecognition || null;
}

// このブラウザに「PC内で認識する」設定（processLocally）があるか
function supportsProcessLocally(SR) {
  return !!SR && !!SR.prototype && 'processLocally' in SR.prototype;
}

/**
 * PC内の音声認識が使えるかを調べる。何もダウンロードしない。
 * @param {string} lang 例 'en-US'
 * @returns {Promise<'available'|'downloadable'|'downloading'|'unavailable'|'unsupported'>}
 */
export async function checkLocalSpeech(lang) {
  const SR = getSR();
  if (!SR || typeof SR.available !== 'function' || !supportsProcessLocally(SR)) return 'unsupported';
  let timer;
  try {
    const limit = new Promise(ok => { timer = setTimeout(() => ok('unavailable'), 15000); });
    const asking = Promise.resolve().then(() => SR.available({ langs: [lang], processLocally: true }));
    const av = await Promise.race([asking, limit]);
    return LOCAL_STATES.includes(av) ? av : 'unavailable';
  } catch (e) {
    return 'unavailable';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * PC内の音声認識データを入れる。ボタン操作の直後に呼ぶこと（ブラウザが操作直後の呼び出しを求めるため）。
 * @param {string} lang 例 'en-US'
 * @returns {Promise<boolean>} 入った（入っていた）なら true
 */
export async function installLocalSpeech(lang) {
  const SR = getSR();
  if (!SR || typeof SR.install !== 'function') return false;
  let installing;
  // 最初の await より前に install を呼ぶ
  try { installing = SR.install({ langs: [lang], processLocally: true }); }
  catch (e) { return false; }
  try { return (await installing) === true; }
  catch (e) { return false; }
}

// 認識のエラーを利用者向けの文に直す。fatal は「自動再開しても直らない」もの
// （このアプリはPC内の認識だけを使うので、文はすべてPC内の認識を前提にしている）
function describeError(code) {
  switch (code) {
    case 'language-not-supported':
      return { fatal: true, message: 'PC内の音声認識データがありません。「AIを準備」を押してください' };
    case 'service-not-allowed':
      return { fatal: true, message: 'PC内の音声認識が許可されていません（管理者による制限の可能性）。このアプリは音声を外部に送らないため、認識できません' };
    case 'not-allowed':
      return { fatal: true, message: 'マイク／音声の利用が許可されていません' };
    case 'audio-capture':
      return { fatal: true, message: 'マイク（音声の入力）が見つかりません' };
    case 'network':
      // PC内で認識しているのに通信エラーが出るのは、PC内で処理できていないということ
      return { fatal: true, message: 'PC内の音声認識ができない状態です（このアプリは音声を外部に送らないため、認識を止めました）' };
    default:
      return { fatal: false, message: `音声認識でエラーが起きました（${code}）。再開します` };
  }
}

const MAX_ERRORS_IN_ROW = 3;   // エラーがこの回数続いたら止める
const MAX_QUICK_ENDS = 5;      // 何も聞き取らずにすぐ終わる状態がこの回数続いたら止める
const QUICK_END_MS = 1000;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 4000;

/**
 * @param {object} opts
 * @param {string} opts.lang 認識する言語（例 'en-US'）
 * @param {MediaStreamTrack|null} [opts.audioTrack] 画面・タブ音声のトラック。なければマイク
 * 認識は必ずPC内（processLocally = true）で行う。クラウド認識に切り替える道は持たない。
 */
export function createSpeechSource({ lang, audioTrack = null } = {}) {
  const handlers = { interim: [], final: [], state: [], end: [] };
  let running = false;
  let rec = null;
  let gen = 0;            // 認識インスタンスの世代。古いインスタンスのイベントを無視するため
  let restartTimer = null;
  let errorsInRow = 0;    // 聞き取れないまま続いたエラーの数
  let quickEnds = 0;      // 何も聞き取らずにすぐ終わった回数（続けて）
  let lastError = '';

  function emit(name, arg) {
    for (const fn of handlers[name].slice()) {
      try { fn(arg); } catch (e) { console.error(e); }
    }
  }
  function fail(message) {
    emit('state', { kind: 'err', message });
    stopInternal();
  }

  function newRecognition(SR, myGen) {
    const r = new SR();
    r.lang = lang; r.continuous = true; r.interimResults = true;
    r.processLocally = true; // PC内だけで認識する（外部に送らない）
    let startedAt = Date.now();
    let heard = false;
    r.onstart = () => { startedAt = Date.now(); };
    r.onresult = ev => {
      if (myGen !== gen || !running) return;
      heard = true; errorsInRow = 0; quickEnds = 0;
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
      if (e.error === 'no-speech' || e.error === 'aborted') return; // 無音などは普通に再開する
      const { fatal, message } = describeError(e.error);
      if (fatal) { fail(message); return; }
      lastError = e.error;
      errorsInRow++;
      if (errorsInRow >= MAX_ERRORS_IN_ROW) {
        fail(`音声認識のエラーが続いたため止めました（${e.error}）`);
        return;
      }
      emit('state', { kind: 'err', message });
    };
    // 無音などで止まっても、動作中なら自動で再開する。ただし再開ループにはしない
    r.onend = () => {
      if (myGen !== gen || !running) return;
      if (!heard && Date.now() - startedAt < QUICK_END_MS) quickEnds++;
      else quickEnds = 0;
      if (quickEnds >= MAX_QUICK_ENDS) {
        fail(`音声認識がすぐに止まってしまうため、止めました${lastError ? `（${lastError}）` : ''}`);
        return;
      }
      // うまくいっていないときほど、再開までの間を空ける
      const delay = Math.min(BASE_DELAY_MS * 2 ** (errorsInRow + quickEnds), MAX_DELAY_MS);
      clearTimeout(restartTimer);
      restartTimer = setTimeout(startRecognition, delay);
    };
    return r;
  }

  function startRecognition() {
    restartTimer = null;
    if (!running) return;
    const SR = getSR();
    const myGen = ++gen;
    try {
      rec = newRecognition(SR, myGen);
      if (audioTrack) rec.start(audioTrack); else rec.start();
      emit('state', { kind: 'ok', message: audioTrack ? '取り込み中（画面・タブ音声）' : '取り込み中（マイク）' });
    } catch (e) {
      // 例外で始められないときは自動再開しない
      const detail = e && e.message ? e.message : String(e);
      fail(audioTrack
        ? `PC内の音声認識を始められませんでした。このブラウザは画面・タブ音声に対応していない可能性があります。マイクを使ってください（${detail}）`
        : `PC内の音声認識を始められませんでした（${detail}）`);
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
      const SR = getSR();
      if (!SR) {
        emit('state', { kind: 'err', message: 'このブラウザは音声認識に対応していません（Chrome／Edgeを使ってください）' });
        emit('end');
        return;
      }
      if (!supportsProcessLocally(SR)) {
        emit('state', { kind: 'err', message: NO_LOCAL_MESSAGE });
        emit('end');
        return;
      }
      errorsInRow = 0; quickEnds = 0; lastError = '';
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
