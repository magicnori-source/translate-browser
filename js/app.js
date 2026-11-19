// 本体の処理：各部品をつなぐ（音声 → 区切り → 段落データと表示 → 翻訳の順番待ち → 表示）
// 第1段階：文・段落の区切り、3段階の翻訳（速報／段落訳／仕上げ訳）、テスト再生
import { createSegmenter } from './segmenter.js';
import { createTranscript } from './transcript.js';
import { createTranslateQueue } from './translate-queue.js';
import { ensureTranslator, ensureSummarizer, ensureRefiner, resetRefiner, ensureSummaryLM, resetSummaryLM, isEdge } from './ai.js';
import { createSpeechSource, checkLocalSpeech, installLocalSpeech } from './speech.js';
import { isFiller, stripFillerEdges } from './filler.js';
import { createPlayback } from './playback.js';
import { createView } from './view.js';

const $ = id => document.getElementById(id);

// ---------- 設定（このブラウザに保存） ----------
const SETTINGS_KEY = 'lt-settings-v2';
const OLD_SETTINGS_KEY = 'lt-settings-v1';
// 1段落の最大文数は、仕上げ訳を速くするため4から3に変更（v1で4のままの人は3に移す）
const DEFAULTS = { sentenceGapMs: 1200, paragraphGapMs: 3000, maxSentences: 3, flash: true };
const LIMITS = { sentenceGapMs: [300, 5000], paragraphGapMs: [1000, 15000], maxSentences: [1, 10] };

function clamp(key, v) { const [lo, hi] = LIMITS[key]; return Math.min(hi, Math.max(lo, Math.round(v))); }
function loadSettings() {
  const s = { ...DEFAULTS };
  try {
    let saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (!saved) {
      saved = JSON.parse(localStorage.getItem(OLD_SETTINGS_KEY) || '{}');
      if (saved.maxSentences === 4) delete saved.maxSentences; // 旧初期値のままなら新しい初期値にする
    }
    for (const key of Object.keys(LIMITS)) if (Number.isFinite(saved[key])) s[key] = clamp(key, saved[key]);
    if (typeof saved.flash === 'boolean') s.flash = saved.flash;
  } catch {}
  return s;
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}
let settings = loadSettings();
const segOptions = () => ({ sentenceGapMs: settings.sentenceGapMs, paragraphGapMs: settings.paragraphGapMs, maxSentences: settings.maxSentences });

// ---------- 状態 ----------
const transcript = createTranscript();
const view = createView({ listEl: $('list'), flashEl: $('interim'), logEl: $('log'), backBtn: $('backToLatest') });
let segmenter = createSegmenter(segOptions());
let translator = null, refiner = null, summarizer = null, summaryLM = null;
let summarizing = false;
let lastRecError = '';                      // 音声認識が止まった理由（停止後も表示に残す）
let source = null, displayStream = null;
let running = false, starting = false, stopping = false;
let clockNow = () => Date.now();          // 区切りの判定に使う時計（テスト再生の早送りでは速く進める）
let tickTimer = null, clockTimer = null, sumTimer = null, startAt = 0;
let lastSumIdx = 0;                         // 要約済みの段落数
let lateRefines = 0, failedRefines = 0, refineErrorsInRow = 0;
let hasInterim = false;                     // 話している途中の文があるか（古い速報を出さないため）
const waitingRefine = new Map();            // 段落が閉じて、最終の段落訳を待っている段落 → 保険のタイマー
const translatedVersion = new Map();        // 段落ごとに、段落訳が届いた最新の版

// ---------- 表示の小物 ----------
function toast(t, ms = 4000) {
  const m = $('msg'); m.textContent = t; m.style.display = 'block';
  clearTimeout(m._t); m._t = setTimeout(() => (m.style.display = 'none'), ms);
}
function setStat(dot, el, cls, text) { $(dot).className = 'dot ' + (cls || ''); $(el).textContent = text; }
const statTr = (s, t) => setStat('dTr', 'sTr', s, t);
const statRef = (s, t) => setStat('dRef', 'sRef', s, t);
const statSum = (s, t) => setStat('dSum', 'sSum', s, t);
const statRec = (s, t) => setStat('dRec', 'sRec', s, t);
function hhmm(ms) { return new Date(ms).toTimeString().slice(0, 5); }

// ---------- 仕上げ訳の記録（使えなかった訳と理由。メモリ上に直近50件だけ持ち、保存はしない） ----------
const REFINE_REASON = {
  empty: 'AIの出力が空',
  'too-long': '長すぎる（段落訳の2.5倍超）',
  'not-japanese': '日本語が少なすぎる',
  error: 'エラー',
  timeout: '時間切れ（20秒以内に終わらず、段落訳のまま）',
};
const refineLog = [];
function addRefineLog(reason, src, raw) {
  refineLog.unshift({ at: Date.now(), reason, src: String(src || ''), raw: String(raw || '') });
  if (refineLog.length > 50) refineLog.length = 50;
  const list = $('refineLogList');
  list.textContent = '';
  for (const r of refineLog) {
    const li = document.createElement('li');
    li.textContent = `${hhmm(r.at)} ${REFINE_REASON[r.reason] || r.reason}\n原文: ${r.src.slice(0, 160)}`
      + (r.raw ? `\n${r.reason === 'error' ? 'エラーの内容' : 'AIの出力'}: ${r.raw.slice(0, 240)}` : '');
    list.append(li);
  }
  $('refineLog').querySelector('summary').textContent = `仕上げ訳の記録（使えなかった訳: ${refineLog.length}件。最新50件まで・ページを閉じると消えます）`;
}

const notices = new Map();
function setNotice(key, text) {
  if (text) notices.set(key, text); else notices.delete(key);
  const n = $('notice');
  n.textContent = [...notices.values()].join('　');
  n.hidden = notices.size === 0;
}

// ---------- 内蔵AIの準備 ----------
// ボタン操作なしの確認は、応答がないブラウザでも開始が止まらないよう10秒で打ち切る。
// ボタン操作ありはダウンロードで数分かかるので待つが、開始の処理はその完了を待たない
// （ai.js が作成中・作成済みのものを覚えているので、後の確認で拾える）。
// already(): すでにその機能が使えているか（使えていれば「応答なし」で表示を上書きしない）
function limited(promise, userClick, onStatus, already = () => false) {
  if (userClick) return promise.catch(() => null);
  let timer;
  const limit = new Promise(ok => { timer = setTimeout(() => { if (!already()) onStatus('warn', '応答なし（「AIを準備」を押してください）'); ok(null); }, 10000); });
  return Promise.race([promise.catch(() => null), limit]).finally(() => clearTimeout(timer));
}

const refinerOptions = {
  getJa: id => transcript.get(id)?.ja || '',
  getGlossary: () => [],
  onReject: ({ reason, raw, src }) => addRefineLog(reason, src, raw),
};

// ---------- PC内の音声認識の準備 ----------
const LOCAL_SPEECH_MSG = {
  available: ['ok', '待機中（PC内で認識）'],
  downloadable: ['warn', 'データ未取得（「AIを準備」を押してください）'],
  downloading: ['warn', '音声認識データをダウンロード中…'],
  unavailable: ['err', 'このPCでは使えません'],
  unsupported: ['err', 'このブラウザでは使えません（Chromeで開いてください）'],
};
async function prepareSpeech(userClick) {
  const lang = $('srcLang').value;
  if (userClick) {
    // ボタン操作の直後に呼ぶ必要がある（installLocalSpeech は最初の await より前にダウンロードを始める）
    const installing = installLocalSpeech(lang);
    statRec('warn', '音声認識データを準備中…');
    await installing;
  }
  const st = await checkLocalSpeech(lang);
  if (running || starting) return; // 動作中は「取り込み中」の表示を上書きしない
  const [cls, text] = LOCAL_SPEECH_MSG[st] || ['err', 'PC内の音声認識を確認できません'];
  statRec(cls, text);
  setNotice('speech', st === 'unsupported' ? 'このアプリは音声を外部に送らないため、このブラウザではマイク・画面音声の認識が使えません（テスト再生は使えます）。Chromeで開いてください。' : '');
}

// 要約は内蔵LLM（見出し付きで整理）を優先し、使えなければ Summarizer API（簡易版）を使う
async function prepareSummary(userClick) {
  const m = await limited(ensureSummaryLM(userClick, statSum), userClick, statSum, () => !!summaryLM);
  if (m) { summaryLM = m; return; }
  if (summaryLM) return;
  const s = await limited(ensureSummarizer(userClick, statSum), userClick, statSum, () => !!summarizer);
  if (s) { summarizer = s; statSum('ok', '利用可（簡易版・PC内で処理）'); }
}

async function prepareAI(userClick) {
  // すべてを同時に始める（ボタン操作の直後でないとダウンロードを始められないため）。
  // 一度使えた機能は、後の確認が「応答なし」でも手放さない。
  const tasks = [
    prepareSpeech(userClick).catch(() => {}),
    limited(ensureTranslator(userClick, statTr), userClick, statTr, () => !!translator).then(t => { if (t) translator = t; }),
    limited(ensureRefiner(userClick, statRef, refinerOptions), userClick, statRef, () => !!refiner).then(r => { if (r) { refiner = r; refineErrorsInRow = 0; } }),
  ];
  // 要約は「AIを準備」を押したときか、自動要約を使う設定のときだけ準備する
  if (userClick || $('sumEvery').value !== '0') tasks.push(prepareSummary(userClick));
  await Promise.all(tasks);
  setNotice('translator', !('Translator' in self) ? 'このブラウザでは翻訳が使えないため、英語の原文だけを表示します。' : '');
  setNotice('edge', !('LanguageModel' in self) && isEdge() ? 'Edgeでは仕上げ訳が使えないため、訳は段落訳までになります。Chromeで開けば仕上げ訳まで使えます。' : '');
}

// ---------- 翻訳の順番待ち（ページを開いている間ずっと1つ。翻訳機能があとから使えるようになっても反映される） ----------
const queue = createTranslateQueue({
  translate: text => translator ? translator.translate(text) : Promise.reject(new Error('翻訳機能がありません')),
  refine: (paraId, src, ctx, signal) => refiner ? refiner.refine(paraId, src, ctx, signal) : Promise.resolve(null),
  now: () => performance.now(),
  schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
});
queue.setFlashEnabled(settings.flash);
queue.on('flash', ({ ja }) => { if (settings.flash && running && hasInterim) view.setFlash(ja); });
queue.on('paragraph', ({ paraId, ja, version }) => {
  if (!transcript.setJa(paraId, ja, 'paragraph', version)) return;
  translatedVersion.set(paraId, Math.max(version, translatedVersion.get(paraId) ?? -1));
  const p = transcript.get(paraId);
  view.updateParagraph(p);
  view.scrollIfFollowing();
  // 段落が閉じたあと、最後の文まで入った段落訳が届いたら仕上げ訳へ回す
  if (waitingRefine.has(paraId) && version === p.version) sendRefine(paraId);
});
queue.on('refined', ({ paraId, ja }) => {
  refineErrorsInRow = 0;
  if (lateRefines || failedRefines) statRef('ok', `利用可（間に合わず ${lateRefines}件・失敗 ${failedRefines}件）`);
  if (!transcript.setJa(paraId, ja, 'refined')) return;
  view.updateParagraph(transcript.get(paraId));
  view.markRefined(paraId);
  view.scrollIfFollowing();
});
queue.on('refine-skipped', ({ paraId, reason }) => {
  // 間に合わなかった（待ちあふれ・時間切れ）と、失敗（使えない出力・エラー）を分けて数える
  if (reason === 'backlog' || reason === 'timeout') lateRefines++; else failedRefines++;
  statRef('warn', `段落訳のまま（間に合わず ${lateRefines}件・失敗 ${failedRefines}件）`);
  // 仕上げ訳の失敗や時間切れが続いたら、内蔵LLMを準備し直す（2時間の利用中に壊れても戻れるように）
  // 失敗の記録: エラーは内容を、時間切れは遅さの判断材料として残す
  if (reason === 'error' || reason === 'timeout') {
    addRefineLog(reason, transcript.get(paraId)?.srcForTranslate || '', reason === 'error' ? lastRefineError : '');
  }
  lastRefineError = '';
  // 要約中の時間切れは内蔵LLMの取り合いによるものなので、作り直しの回数には数えない
  if (!summarizing && (reason === 'error' || reason === 'timeout') && ++refineErrorsInRow >= 3) {
    refiner = null; refineErrorsInRow = 0;
    resetRefiner();
    prepareAI(false);
  }
});
let lastRefineError = '';
queue.on('error', ({ lane, error }) => {
  console.warn('[翻訳]', lane, error);
  if (lane === 'refine') lastRefineError = `${error?.name || 'Error'}: ${error?.message || error}`;
});
queue.on('stats', s => { window.__ltStats = s; });
// 動作確認用：URLの末尾に ?debug を付けたときだけ、コンソールから中身を見られるようにする
if (new URLSearchParams(location.search).has('debug')) window.__lt = { transcript, queue, get translator() { return translator; }, get refiner() { return refiner; } };

function sendRefine(paraId) {
  if (!waitingRefine.has(paraId)) return;
  clearTimeout(waitingRefine.get(paraId));
  waitingRefine.delete(paraId);
  const p = transcript.get(paraId);
  if (!p || !refiner || p.stage === 'filler' || !p.srcForTranslate) return;
  const context = transcript.recent(3, paraId).filter(c => c.srcForTranslate).map(c => ({ src: c.srcForTranslate, ja: c.ja }));
  queue.requestRefine(paraId, p.srcForTranslate, context);
}

// 段落が閉じてから3秒たっても最終の段落訳が来ない場合の保険
function refineFallback(paraId) {
  const p = transcript.get(paraId);
  // 最後の文まで入った段落訳が失敗・破棄されていたら、1回だけ訳し直しを頼む
  if (p && p.srcForTranslate && p.stage !== 'refined' && p.stage !== 'filler' && translator && translatedVersion.get(paraId) !== p.version) queue.requestParagraph(paraId, p.srcForTranslate, p.version);
  sendRefine(paraId);
}

// ---------- 話している途中の英語（リアルタイム表示） ----------
const liveSrcEl = $('interimSrc');
function setLiveSource(text) {
  if (liveSrcEl.textContent !== text) liveSrcEl.textContent = text;
}

// ---------- 区切りのイベントを処理する ----------
function handle(events) {
  if (!events.length) return;
  for (const e of events) {
    switch (e.type) {
      case 'interim':
        hasInterim = !!e.text;
        setLiveSource(e.text); // 話している途中の英語は、訳を待たずにそのまま出す
        if (!e.text) { view.setFlash(''); break; }
        if (translator && settings.flash) {
          const flashText = stripFillerEdges(e.text); // 速報でも文頭・文末のあいづちは訳さない
          if (flashText && !isFiller(flashText)) queue.requestFlash(flashText);
        }
        break;
      case 'paragraph-open':
        transcript.openParagraph(e.paraId, Date.now()); // 表示用の時刻は実際の時刻
        view.ensureParagraph(transcript.get(e.paraId));
        break;
      case 'sentence': {
        // あいづち・感嘆だけの文（Wow. Um. Okay. など）は訳さない（英語だけ残す）
        // 文頭・文末のあいづちも訳には使わない（句読点のない認識では本文とつながって届くため）
        const translateText = stripFillerEdges(e.text);
        const filler = isFiller(e.text) || !translateText;
        const version = transcript.addSentence(e.paraId, e.text, { filler, translateText });
        const p = transcript.get(e.paraId);
        view.updateParagraph(p);
        if (!filler && translator && version != null && p.srcForTranslate) queue.requestParagraph(e.paraId, p.srcForTranslate, version);
        break;
      }
      case 'paragraph-close': {
        transcript.close(e.paraId);
        const p = transcript.get(e.paraId);
        view.updateParagraph(p);
        if (p.stage === 'filler') break; // あいづちだけの段落は訳さない
        waitingRefine.set(e.paraId, setTimeout(() => refineFallback(e.paraId), 3000));
        // 翻訳機能がない、またはすでに最新の段落訳が届いていれば、すぐ仕上げ訳へ
        if (!translator || translatedVersion.get(e.paraId) === p.version) sendRefine(e.paraId);
        break;
      }
    }
  }
  view.scrollIfFollowing();
}

// ---------- 開始・停止 ----------
let sampleText = null;
async function loadSample() {
  if (sampleText != null) return sampleText;
  const r = await fetch('data/sample-talk.txt');
  if (!r.ok) throw new Error(`サンプルの英文を読み込めませんでした（${r.status}）`);
  return (sampleText = await r.text());
}

function setRunningButtons(state) { // 'idle' | 'starting' | 'running'
  $('start').disabled = state !== 'idle';
  $('stop').disabled = state !== 'running';
  $('source').disabled = state !== 'idle';
  $('start').textContent = state === 'starting' ? '準備中…' : '▶ 開始';
}

async function start() {
  if (running || starting) return;
  starting = true;
  setRunningButtons('starting');
  try {
    const kind = $('source').value;
    let audioTrack = null, text = '';
    // 画面共有の選択はボタン操作の直後でないと開けないので、PC内の認識の確認より先に開く
    if (kind === 'display') {
      try { displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); }
      catch (e) { toast(e?.name === 'NotAllowedError' ? '画面共有がキャンセルされました' : `画面共有を開始できませんでした（${e?.message || e}）`); return; }
      audioTrack = displayStream.getAudioTracks()[0] || null;
      displayStream.getVideoTracks().forEach(t => t.stop()); // 映像は使わない（保存・送信もしない）
      if (!audioTrack) {
        toast('音声が取得できませんでした。共有するときに「音声も共有する」をオンにしてください', 7000);
        return; // 共有は finally で止める
      }
    }
    if (kind !== 'playback') {
      // 音声は外部に送らない。PC内で認識できないときは始めない（クラウド認識には切り替えない）
      const st = await checkLocalSpeech($('srcLang').value);
      if (st !== 'available') {
        const msg = {
          unsupported: 'このブラウザではマイク・画面音声の認識が使えません（このアプリは音声を外部に送らないため）。Chromeで開いてください',
          downloadable: '英語の音声認識データがまだありません。「AIを準備」を押してください',
          downloading: '英語の音声認識データをダウンロード中です。終わってから開始してください',
        }[st] || 'このPCではPC内の音声認識が使えません';
        toast(msg, 8000);
        statRec('err', (LOCAL_SPEECH_MSG[st] || [])[1] || '使えません');
        return; // 画面共有を開いていれば finally で止める
      }
    }
    if (kind === 'playback') {
      text = $('pbText').value.trim();
      if (!text) { try { text = await loadSample(); } catch (e) { toast(e.message); return; } }
    }
    await prepareAI(false);

    if (kind === 'playback') {
      const speed = Number($('pbSpeed').value) || 1;
      const t0 = Date.now();
      clockNow = () => t0 + (Date.now() - t0) * speed; // 早送りに合わせて区切りの時計も速める
      source = createPlayback({ text, speed, punctuate: $('pbPunctuate').checked });
    } else {
      clockNow = () => Date.now();
      source = createSpeechSource({ lang: $('srcLang').value, audioTrack });
      if (audioTrack) audioTrack.onended = () => stop();
    }
    // 音声が届いたら、まずその直前の無音で文・段落を区切るべきかを確かめる
    // （0.2秒おきの確認の合間に無音が終わっても、区切りを見逃さないように）
    source.on('interim', t => { const now = clockNow(); handle([...segmenter.tick(now), ...segmenter.interim(t, now)]); });
    source.on('final', t => { const now = clockNow(); handle([...segmenter.tick(now), ...segmenter.final(t, now)]); });
    lastRecError = '';
    source.on('state', ({ kind: k, message }) => {
      if (!message) return;
      statRec(k, message);
      if (k === 'err') { lastRecError = message; toast(message, 8000); } // 止まった理由を見えるように残す
    });
    source.on('end', () => { if (running) stop(); });

    running = true;
    setRunningButtons('running');
    queue.setFlashEnabled(settings.flash);
    startAt = Date.now();
    clockTimer = setInterval(() => {
      const s = Math.floor((Date.now() - startAt) / 1000);
      $('elapsed').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }, 1000);
    tickTimer = setInterval(() => handle(segmenter.tick(clockNow())), 200);
    const n = Number($('sumEvery').value);
    if (n > 0) sumTimer = setInterval(() => doSummary(false), n * 60 * 1000);
    source.start();
  } finally {
    starting = false;
    if (!running) {
      if (displayStream) { displayStream.getTracks().forEach(t => t.stop()); displayStream = null; }
      setRunningButtons('idle');
    }
  }
}

function stop() {
  if (!running || stopping) return;
  stopping = true;
  running = false;
  // タイマーを先に止める（後の処理で例外が出ても止め損ねないように）
  clearInterval(tickTimer); clearInterval(clockTimer); clearInterval(sumTimer);
  try {
    try { source?.stop(); } catch {}
    source = null;
    handle(segmenter.flush(clockNow()));  // 話の途中で止めても、最後の文まで残す
  } finally {
    if (displayStream) { displayStream.getTracks().forEach(t => t.stop()); displayStream = null; }
    hasInterim = false;
    setLiveSource('');
    queue.setFlashEnabled(false);         // 待ちの速報を捨てる（段落訳・仕上げ訳は最後まで続ける）
    view.setFlash('');
    setRunningButtons('idle');
    // 音声認識がエラーで止まったときは、その理由を表示に残す（「停止」で上書きしない）
    if (lastRecError) statRec('err', lastRecError); else statRec('', '停止');
    stopping = false;
  }
}

$('start').onclick = start;
$('stop').onclick = stop;
$('prep').onclick = async () => {
  $('prep').disabled = true;
  // ダウンロードは数分かかることがあるが、応答しないブラウザでボタンが戻らなくならないよう30秒で押せるようにする
  const reenable = setTimeout(() => { $('prep').disabled = false; }, 30000);
  try { await prepareAI(true); clearTimeout(reenable); toast('準備が終わりました。各機能が使えるかは、状態表示の欄で確認してください'); }
  finally { $('prep').disabled = false; }
};

// ---------- 要約（試作版の動きのまま。段落データを読む） ----------
async function doSummary(manual) {
  const paras = transcript.all();
  // 閉じた段落の数。自動の要約は閉じた段落だけを対象にし、次回はその続きから始める
  // （話の途中の段落は、閉じてから次の要約に入る。手動のときは今の段落も含めるが、次回の開始位置は閉じた段落まで）
  const openIdx = paras.findIndex(p => !p.closed);
  const closedCount = openIdx === -1 ? paras.length : openIdx;
  const part = paras.slice(lastSumIdx, manual ? paras.length : closedCount).filter(p => p.src);
  if (!part.length) { if (manual) toast('要約する内容がまだありません'); return; }
  if (summarizing) { if (manual) toast('いま要約を作っています。終わってからもう一度押してください'); return; }
  // 要約の材料は英語の原文（あいづちは除く）。訳文を並べると「訳のまとめ」になってしまうため
  const text = part.map(p => p.srcForTranslate).filter(Boolean).join('\n');
  if (!text) { if (manual) toast('前回の要約のあとは、あいづちだけでした'); lastSumIdx = Math.max(lastSumIdx, closedCount); return; }
  if (text.length < 200 && !manual) return; // 短すぎるときは次回にまとめる
  summarizing = true; // ここから先は二重に走らせない（自動要約とボタンが重なっても1つだけ）
  try {
    // 内蔵LLM（見出し付き）を毎回まず試す。前回失敗して簡易版になっていても、ここで準備し直す
    if (!summaryLM) await prepareSummary(!!manual);
    if (!summaryLM && !summarizer) { if (manual) toast('このPCでは要約機能が使えません'); return; }
    const from = hhmm(part[0].startedAt), to = hhmm(Date.now());
    lastSumIdx = Math.max(lastSumIdx, closedCount);
    const sums = $('sums'); if (sums.querySelector('.empty')) sums.innerHTML = '';
    const card = document.createElement('div'); card.className = 'sum';
    const h = document.createElement('div'); h.className = 'h'; h.textContent = `${from}〜${to} の要約`;
    const b = document.createElement('div'); b.className = 'b'; b.textContent = '要約中…';
    card.append(h, b); sums.prepend(card);
    try {
      const { text: out, simple } = await summarizeText(text);
      b.textContent = out;
      if (simple) h.textContent = `${from}〜${to} の要約（簡易版）`;
    } catch (e) {
      b.textContent = '要約に失敗しました: ' + (e?.message || e);
    }
  } finally {
    summarizing = false;
  }
}

// 応答しない処理で要約が止まったままにならないよう、時間切れを設ける
function withDeadline(promise, ms, message) {
  let timer;
  const limit = new Promise((_, ng) => { timer = setTimeout(() => ng(new Error(message)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// 内蔵LLMで見出し付きの要約を作る。その間は仕上げ訳を止めて、内蔵LLMの取り合いを避ける。
// 内蔵LLMが使えない・失敗したときは Summarizer API（簡易版）で作る。
async function summarizeText(text) {
  if (summaryLM) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    queue.pauseRefine(true);
    try {
      await queue.whenRefineIdle();
      return { text: await summaryLM.summarize(text, { signal: ctrl.signal }), simple: false };
    } catch (e) {
      console.warn('[要約] 内蔵LLMで作れなかったため簡易版に切り替えます', e);
      // 次の要約では内蔵LLMを準備し直す（2時間の利用中に一度壊れても、簡易版のままにしない）
      summaryLM = null;
      resetSummaryLM();
      if (!summarizer) summarizer = await limited(ensureSummarizer(false, () => {}), false, () => {});
      if (!summarizer) throw e;
    } finally {
      clearTimeout(timer);
      queue.pauseRefine(false);
    }
  }
  return { text: await withDeadline(summarizer.summarize(text.slice(-8000)), 120000, '要約が時間内に終わりませんでした'), simple: true };
}
$('sumNow').onclick = () => doSummary(true);

// ---------- 保存・クリア・表示 ----------
function localStamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}
$('save').onclick = () => {
  // あいづちだけの段落は保存しない。訳がない段落は原文（あいづちを除いたもの）を出す
  const body = transcript.all().filter(p => p.src && p.stage !== 'filler').map(p => `[${hhmm(p.startedAt)}] ${p.ja || p.srcForTranslate || p.src}\n        (${p.src})`).join('\n')
    + '\n\n==== 要約 ====\n' + [...document.querySelectorAll('.sum')].reverse().map(c => c.innerText).join('\n\n');
  const a = document.createElement('a');
  // 先頭にBOMを付けて、古いメモ帳でも文字化けしないようにする
  a.href = URL.createObjectURL(new Blob(['﻿' + body], { type: 'text/plain;charset=utf-8' }));
  a.download = `翻訳ノート_${localStamp()}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};

$('clear').onclick = () => {
  if (running || starting) { toast('停止してからクリアしてください'); return; }
  queue.clear();
  for (const t of waitingRefine.values()) clearTimeout(t);
  waitingRefine.clear(); translatedVersion.clear();
  transcript.clear(); view.clear();
  segmenter = createSegmenter(segOptions());
  lastSumIdx = 0; lateRefines = 0; failedRefines = 0;
  $('sums').innerHTML = '<div class="empty">要約はここに表示されます。</div>';
};

let fs = 22;
const setFs = () => document.documentElement.style.setProperty('--fs', fs + 'px');
$('fsUp').onclick = () => { fs = Math.min(40, fs + 2); setFs(); };
$('fsDown').onclick = () => { fs = Math.max(14, fs - 2); setFs(); };
$('toggleSrc').onclick = () => { const h = $('log').classList.toggle('hide-src'); $('toggleSrc').textContent = h ? '原文を表示' : '原文を隠す'; };

// ---------- 設定パネル ----------
function showSettings() {
  $('optFlash').checked = settings.flash;
  $('optSentenceGap').value = settings.sentenceGapMs;
  $('optParagraphGap').value = settings.paragraphGapMs;
  $('optMaxSentences').value = settings.maxSentences;
  view.setFlashVisible(settings.flash);
}
function applySettings() {
  for (const [key, id] of [['sentenceGapMs', 'optSentenceGap'], ['paragraphGapMs', 'optParagraphGap'], ['maxSentences', 'optMaxSentences']]) {
    const v = Number($(id).value);
    if (Number.isFinite(v)) settings[key] = clamp(key, v);
  }
  settings.flash = $('optFlash').checked;
  segmenter.setOptions(segOptions());
  if (running) queue.setFlashEnabled(settings.flash);
  saveSettings(); showSettings();
}
for (const id of ['optFlash', 'optSentenceGap', 'optParagraphGap', 'optMaxSentences']) $(id).onchange = applySettings;
$('optReset').onclick = () => {
  settings = { ...DEFAULTS };
  segmenter.setOptions(segOptions());
  if (running) queue.setFlashEnabled(settings.flash);
  saveSettings(); showSettings();
};
showSettings();
// テスト再生を選んだら、速さや英文を入れる欄が見えるように設定を開く
$('source').addEventListener('change', () => { if ($('source').value === 'playback') $('settingsPanel').open = true; });

// ---------- 最新の文章の位置 ----------
// 最新の文章が画面の一番下ではなく、真ん中よりやや下（ログ欄の上から6割ほど）に来るよう、
// ログ欄の高さの4割を下の余白にする（ウィンドウの大きさが変わっても合わせる）
function fitFollowGap() {
  const log = $('log');
  log.style.setProperty('--follow-gap', Math.round(log.clientHeight * 0.4) + 'px');
  view.scrollIfFollowing(); // 大きさが変わっても、最新を追っているなら位置を合わせ直す
}
if ('ResizeObserver' in self) new ResizeObserver(fitFollowGap).observe($('log'));
fitFollowGap();

// ---------- 起動時 ----------
prepareAI(false);
