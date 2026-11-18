// 本体の処理：各部品をつなぐ（音声 → 区切り → 段落データと表示 → 翻訳の順番待ち → 表示）
// 第1段階：文・段落の区切り、3段階の翻訳（速報／段落訳／仕上げ訳）、テスト再生
import { createSegmenter } from './segmenter.js';
import { createTranscript } from './transcript.js';
import { createTranslateQueue } from './translate-queue.js';
import { ensureTranslator, ensureSummarizer, ensureRefiner, resetRefiner, isEdge } from './ai.js';
import { createSpeechSource } from './speech.js';
import { createPlayback } from './playback.js';
import { createView } from './view.js';

const $ = id => document.getElementById(id);

// ---------- 設定（このブラウザに保存） ----------
const SETTINGS_KEY = 'lt-settings-v1';
const DEFAULTS = { sentenceGapMs: 1200, paragraphGapMs: 3000, maxSentences: 4, flash: true };
const LIMITS = { sentenceGapMs: [300, 5000], paragraphGapMs: [1000, 15000], maxSentences: [1, 10] };

function clamp(key, v) { const [lo, hi] = LIMITS[key]; return Math.min(hi, Math.max(lo, Math.round(v))); }
function loadSettings() {
  const s = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
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
let translator = null, refiner = null, summarizer = null;
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

const refinerOptions = { getJa: id => transcript.get(id)?.ja || '', getGlossary: () => [] };

async function prepareAI(userClick) {
  // 3つを同時に始める（ボタン操作の直後でないとダウンロードを始められないため）。
  // 一度使えた機能は、後の確認が「応答なし」でも手放さない。
  const tasks = [
    limited(ensureTranslator(userClick, statTr), userClick, statTr, () => !!translator).then(t => { if (t) translator = t; }),
    limited(ensureRefiner(userClick, statRef, refinerOptions), userClick, statRef, () => !!refiner).then(r => { if (r) { refiner = r; refineErrorsInRow = 0; } }),
  ];
  if (userClick || $('sumEvery').value !== '0') {
    tasks.push(limited(ensureSummarizer(userClick, statSum), userClick, statSum, () => !!summarizer).then(s => { if (s) summarizer = s; }));
  }
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
queue.on('refine-skipped', ({ reason }) => {
  // 間に合わなかった（待ちあふれ・時間切れ）と、失敗（使えない出力・エラー）を分けて数える
  if (reason === 'backlog' || reason === 'timeout') lateRefines++; else failedRefines++;
  statRef('warn', `段落訳のまま（間に合わず ${lateRefines}件・失敗 ${failedRefines}件）`);
  // 仕上げ訳の失敗や時間切れが続いたら、内蔵LLMを準備し直す（2時間の利用中に壊れても戻れるように）
  if ((reason === 'error' || reason === 'timeout') && ++refineErrorsInRow >= 3) {
    refiner = null; refineErrorsInRow = 0;
    resetRefiner();
    prepareAI(false);
  }
});
queue.on('error', ({ lane, error }) => console.warn('[翻訳]', lane, error));
queue.on('stats', s => { window.__ltStats = s; });
// 動作確認用：URLの末尾に ?debug を付けたときだけ、コンソールから中身を見られるようにする
if (new URLSearchParams(location.search).has('debug')) window.__lt = { transcript, queue, get translator() { return translator; }, get refiner() { return refiner; } };

function sendRefine(paraId) {
  if (!waitingRefine.has(paraId)) return;
  clearTimeout(waitingRefine.get(paraId));
  waitingRefine.delete(paraId);
  const p = transcript.get(paraId);
  if (!p || !refiner) return;
  const context = transcript.recent(3, paraId).map(c => ({ src: c.src, ja: c.ja }));
  queue.requestRefine(paraId, p.src, context);
}

// 段落が閉じてから3秒たっても最終の段落訳が来ない場合の保険
function refineFallback(paraId) {
  const p = transcript.get(paraId);
  // 最後の文まで入った段落訳が失敗・破棄されていたら、1回だけ訳し直しを頼む
  if (p && p.stage !== 'refined' && translator && translatedVersion.get(paraId) !== p.version) queue.requestParagraph(paraId, p.src, p.version);
  sendRefine(paraId);
}

// ---------- 区切りのイベントを処理する ----------
function handle(events) {
  if (!events.length) return;
  for (const e of events) {
    switch (e.type) {
      case 'interim':
        hasInterim = !!e.text;
        if (!e.text) { view.setFlash(''); break; }
        if (translator && settings.flash) queue.requestFlash(e.text);
        break;
      case 'paragraph-open':
        transcript.openParagraph(e.paraId, Date.now()); // 表示用の時刻は実際の時刻
        view.ensureParagraph(transcript.get(e.paraId));
        break;
      case 'sentence': {
        const version = transcript.addSentence(e.paraId, e.text);
        const p = transcript.get(e.paraId);
        view.updateParagraph(p);
        if (translator && version != null) queue.requestParagraph(e.paraId, p.src, version);
        break;
      }
      case 'paragraph-close': {
        transcript.close(e.paraId);
        const p = transcript.get(e.paraId);
        view.updateParagraph(p);
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
    if (kind === 'display') {
      try { displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); }
      catch { toast('画面共有がキャンセルされました'); return; }
      audioTrack = displayStream.getAudioTracks()[0] || null;
      displayStream.getVideoTracks().forEach(t => t.stop()); // 映像は使わない（保存・送信もしない）
      if (!audioTrack) {
        toast('音声が取得できませんでした。共有するときに「音声も共有する」をオンにしてください', 7000);
        displayStream.getTracks().forEach(t => t.stop()); displayStream = null; return;
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
    source.on('state', ({ kind: k, message }) => { if (message) statRec(k, message); });
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
    queue.setFlashEnabled(false);         // 待ちの速報を捨てる（段落訳・仕上げ訳は最後まで続ける）
    view.setFlash('');
    setRunningButtons('idle');
    statRec('', '停止');
    stopping = false;
  }
}

$('start').onclick = start;
$('stop').onclick = stop;
$('prep').onclick = async () => {
  $('prep').disabled = true;
  // ダウンロードは数分かかることがあるが、応答しないブラウザでボタンが戻らなくならないよう30秒で押せるようにする
  const reenable = setTimeout(() => { $('prep').disabled = false; }, 30000);
  try { await prepareAI(true); clearTimeout(reenable); toast('準備が完了しました。使えない機能がないか、上の状態表示で確認してください'); }
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
  const s = summarizer || await limited(ensureSummarizer(!!manual, statSum), !!manual, statSum);
  if (s) summarizer = s;
  if (!s) { if (manual) toast('このPCでは要約機能が使えません'); return; }
  const text = part.map(p => p.ja || p.src).join('\n');
  if (text.length < 80 && !manual) return;
  const from = hhmm(part[0].startedAt), to = hhmm(Date.now());
  lastSumIdx = Math.max(lastSumIdx, closedCount);
  const sums = $('sums'); if (sums.querySelector('.empty')) sums.innerHTML = '';
  const card = document.createElement('div'); card.className = 'sum';
  const h = document.createElement('div'); h.className = 'h'; h.textContent = `${from}〜${to} の要約`;
  const b = document.createElement('div'); b.className = 'b'; b.textContent = '要約中…';
  card.append(h, b); sums.prepend(card);
  try { b.textContent = await s.summarize(text.slice(-12000), { context: '海外の講演・ウェビナーの文字起こし（機械翻訳）です。要点を日本語で簡潔に。' }); }
  catch (e) { b.textContent = '要約に失敗しました: ' + e.message; }
}
$('sumNow').onclick = () => doSummary(true);

// ---------- 保存・クリア・表示 ----------
function localStamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}
$('save').onclick = () => {
  const body = transcript.all().filter(p => p.src).map(p => `[${hhmm(p.startedAt)}] ${p.ja || p.src}\n        (${p.src})`).join('\n')
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

// ---------- 起動時 ----------
prepareAI(false);
