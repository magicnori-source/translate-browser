// ブラウザ内蔵AI（Translator / Summarizer / LanguageModel）の準備と判定（ブラウザ用）
// どのAPIもないブラウザで読み込んでも例外で落ちないようにしている。
import { buildSystemPrompt, buildRefinePrompt, cleanRefineOutput } from './prompt.js';
import {
  SUMMARY_SCHEMA, buildSummarySystemPrompt, buildSummaryPrompt, formatSummary, SUMMARIZER_SHARED_CONTEXT,
} from './summary-prompt.js';

const noop = () => {};
const hasApi = name => typeof self !== 'undefined' && name in self;

// ダウンロードの進み具合を onStatus で知らせる monitor を作る
function progressMonitor(onStatus) {
  return m => m.addEventListener('downloadprogress', e => {
    onStatus('warn', `ダウンロード中 ${Math.round((e.loaded || 0) * 100)}%`);
  });
}

function errMessage(e) {
  return e?.message || String(e);
}

// ---------- 翻訳（英→日） ----------
// 認識言語が en-US でも en-GB でも、翻訳元は 'en' に統一する
const TR_OPTS = { sourceLanguage: 'en', targetLanguage: 'ja' };
let translator = null;
let translatorCreating = null;

export async function ensureTranslator(userClick, onStatus = noop) {
  if (!hasApi('Translator')) { onStatus('err', 'このブラウザ非対応（原文のみ表示）'); return null; }
  if (translator) return translator;
  if (translatorCreating) return translatorCreating.catch(() => null);
  try {
    const av = await Translator.availability(TR_OPTS);
    if (av === 'unavailable') { onStatus('err', 'この言語の組み合わせは非対応'); return null; }
    if (av !== 'available' && !userClick) { onStatus('warn', '「AIを準備」を押してください'); return null; }
    onStatus('warn', 'AIを準備中…');
    translatorCreating = Translator.create({ ...TR_OPTS, monitor: progressMonitor(onStatus) });
    translator = await translatorCreating;
    onStatus('ok', '利用可（PC内で処理）');
    return translator;
  } catch (e) {
    onStatus('err', '準備失敗: ' + errMessage(e));
    return null;
  } finally {
    translatorCreating = null;
  }
}

// ---------- 要約（Summarizer API。内蔵LLMで要約できないときの切り替え先） ----------
// 入力は英語の原文、出力は日本語
const SUM_OPTS = {
  type: 'key-points', format: 'plain-text', length: 'medium',
  expectedInputLanguages: ['en'], outputLanguage: 'ja', sharedContext: SUMMARIZER_SHARED_CONTEXT,
};
let summarizer = null;
let summarizerCreating = null;

export async function ensureSummarizer(userClick, onStatus = noop) {
  if (!hasApi('Summarizer')) { onStatus('err', 'このブラウザ非対応'); return null; }
  if (summarizer) return summarizer;
  if (summarizerCreating) return summarizerCreating.catch(() => null);
  try {
    const av = await Summarizer.availability(SUM_OPTS);
    if (av === 'unavailable') { onStatus('err', 'PCの性能不足で利用不可'); return null; }
    if (av !== 'available' && !userClick) { onStatus('warn', '「AIを準備」を押してください'); return null; }
    onStatus('warn', 'AIを準備中…');
    summarizerCreating = Summarizer.create({ ...SUM_OPTS, monitor: progressMonitor(onStatus) });
    summarizer = await summarizerCreating;
    onStatus('ok', '利用可（PC内で処理）');
    return summarizer;
  } catch (e) {
    onStatus('err', '準備失敗: ' + errMessage(e));
    return null;
  } finally {
    summarizerCreating = null;
  }
}

// ---------- 仕上げ訳（内蔵LLM / Prompt API） ----------
const LM_IO = {
  expectedInputs: [{ type: 'text', languages: ['en', 'ja'] }],
  expectedOutputs: [{ type: 'text', languages: ['ja'] }],
};
let baseSession = null;    // システムプロンプトだけを入れた土台。段落ごとに clone して使う
let baseCreating = null;
let refiner = null;
let refinerOpts = {};

function abortError(signal) {
  const r = signal?.reason;
  if (r instanceof Error || (typeof DOMException !== 'undefined' && r instanceof DOMException)) return r;
  return typeof DOMException !== 'undefined' ? new DOMException('中断しました', 'AbortError') : new Error('中断しました');
}

// 中断されたら即座に失敗する Promise と組み合わせる（prompt() が中断に反応しない実装への保険）
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v); },
      e => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

function makeRefiner() {
  return {
    /**
     * 1段落を仕上げ訳する。訳として使えない出力なら null。中断・時間切れでは AbortError で失敗する。
     * contextParas: [{src, ja}]（直前の段落。古い順）
     */
    async refine(paraId, src, contextParas = [], signal) {
      if (signal?.aborted) throw abortError(signal);
      if (!baseSession) throw new Error('内蔵LLMが準備されていません');
      const ja = String(refinerOpts.getJa?.(paraId) ?? '');
      const glossary = refinerOpts.getGlossary?.() ?? [];
      let session = null;
      // clone が中断のあとで遅れて終わった場合も、作られたセッションは必ず破棄する
      let abandoned = false;
      const cloning = baseSession.clone({ signal });
      cloning.then(s => { if (abandoned) try { s?.destroy?.(); } catch {} }, noop);
      try {
        session = await raceAbort(cloning, signal);
        const text = buildRefinePrompt({ target: { src, ja }, context: contextParas, glossary });
        const raw = await raceAbort(session.prompt(text, { signal }), signal);
        const out = cleanRefineOutput(raw, { src, ja });
        if (out.ok) return out.text;
        // 失敗の理由を app 側で記録できるように知らせる（知らせ先の例外は無視する）
        try { refinerOpts.onReject?.({ paraId, reason: out.reason, raw, src, ja }); } catch {}
        return null;
      } catch (e) {
        // 土台のセッションが壊れていたら、次回作り直せるように捨てる
        if (!signal?.aborted && /destroy/i.test(errMessage(e))) resetRefiner();
        throw e;
      } finally {
        abandoned = true;
        try { session?.destroy?.(); } catch {}
      }
    },
  };
}

// 仕上げ訳の土台を捨てて、次の ensureRefiner で作り直させる（失敗が続いたときに app から呼ぶ）
export function resetRefiner() {
  try { baseSession?.destroy?.(); } catch {}
  baseSession = null;
  refiner = null;
}

/**
 * 仕上げ訳の準備。使えなければ null（段落訳のまま動かす）。
 * options（任意・設計メモからの追加）:
 *   getJa(paraId) -> string     その段落の段落訳（「参考の機械訳」と長さ判定に使う）
 *   getGlossary() -> [{en, ja}] 用語集
 *   onReject({ paraId, reason, raw, src, ja })  仕上げ訳の出力が使えなかったとき
 *                               reason: 'empty' | 'too-long' | 'not-japanese'
 */
export async function ensureRefiner(userClick, onStatus = noop, options = {}) {
  refinerOpts = options || {};
  if (!hasApi('LanguageModel')) { onStatus('err', 'このブラウザ非対応（段落訳まで）'); return null; }
  if (refiner) return refiner;
  if (baseCreating) { await baseCreating.catch(noop); return refiner; }
  try {
    const av = await LanguageModel.availability(LM_IO);
    if (av === 'unavailable') { onStatus('err', 'PCの性能不足で利用不可（段落訳まで）'); return null; }
    if (av !== 'available' && !userClick) { onStatus('warn', '「AIを準備」を押してください（段落訳まで）'); return null; }
    onStatus('warn', 'AIを準備中…');
    baseCreating = LanguageModel.create({
      initialPrompts: [{ role: 'system', content: buildSystemPrompt() }],
      ...LM_IO,
      monitor: progressMonitor(onStatus),
    });
    baseSession = await baseCreating;
    refiner = makeRefiner();
    onStatus('ok', '利用可（PC内で処理）');
    return refiner;
  } catch (e) {
    onStatus('err', '準備失敗: ' + errMessage(e) + '（段落訳まで）');
    return null;
  } finally {
    baseCreating = null;
  }
}

// ---------- 要約（内蔵LLM / Prompt API） ----------
const SUMMARY_MAX_CHARS = 6000;   // 入力上限が分からないときの原文の字数
const SUMMARY_MIN_CHARS = 500;    // 入力上限に合わせて縮めるときの下限
let summaryBase = null;           // 要約用のシステムプロンプトだけを入れた土台（仕上げ訳とは別）
let summaryCreating = null;
let summaryLM = null;

function isAbort(e, signal) {
  return !!signal?.aborted || e?.name === 'AbortError';
}

// 入力上限（inputQuota）を超えないように maxChars を下げながら要約の指示文を作る
async function fitSummaryPrompt(session, srcText, signal) {
  let maxChars = SUMMARY_MAX_CHARS;
  let text = buildSummaryPrompt(srcText, { maxChars });
  const quota = Number(session?.inputQuota);
  if (!(quota > 0) || typeof session.measureInputUsage !== 'function') return text;
  const room = quota - (Number(session.inputUsage) || 0);
  for (let i = 0; i < 6; i++) {
    let usage;
    try {
      usage = await raceAbort(session.measureInputUsage(text, { signal }), signal);
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      return text;   // 測れなければそのまま試す
    }
    // 出力の形の指定（JSONスキーマ）も入力に数えられるので1割の余裕を見る
    if (!(usage > room * 0.9)) return text;
    if (maxChars <= SUMMARY_MIN_CHARS) return text;
    maxChars = Math.max(SUMMARY_MIN_CHARS, Math.floor(maxChars * (room * 0.9) / usage * 0.95));
    text = buildSummaryPrompt(srcText, { maxChars });
  }
  return text;
}

function makeSummaryLM() {
  return {
    /** 英語の原文を日本語で要約する。使える要約にならなければ Error（app 側で Summarizer に切り替える） */
    async summarize(srcText, { signal } = {}) {
      if (signal?.aborted) throw abortError(signal);
      if (!summaryBase) throw new Error('内蔵LLMが準備されていません');
      let session = null;
      let abandoned = false;
      const cloning = summaryBase.clone({ signal });
      cloning.then(s => { if (abandoned) try { s?.destroy?.(); } catch {} }, noop);
      try {
        session = await raceAbort(cloning, signal);
        const text = await fitSummaryPrompt(session, String(srcText ?? ''), signal);
        let raw;
        try {
          raw = await raceAbort(session.prompt(text, { signal, responseConstraint: SUMMARY_SCHEMA }), signal);
        } catch (e) {
          if (isAbort(e, signal)) throw e;
          // 出力の形の指定に対応していない実装では、指定なしでもう一度試す
          raw = await raceAbort(session.prompt(text, { signal }), signal);
        }
        const out = formatSummary(raw);
        if (out == null) throw new Error('要約の出力を読み取れませんでした');
        return out;
      } catch (e) {
        if (!signal?.aborted && /destroy/i.test(errMessage(e))) resetSummaryLM();
        throw e;
      } finally {
        abandoned = true;
        try { session?.destroy?.(); } catch {}
      }
    },
  };
}

// 要約用の土台を捨てて、次の ensureSummaryLM で作り直させる
export function resetSummaryLM() {
  try { summaryBase?.destroy?.(); } catch {}
  summaryBase = null;
  summaryLM = null;
}

/** 要約用の内蔵LLMの準備。使えなければ null（app 側で Summarizer に切り替える） */
export async function ensureSummaryLM(userClick, onStatus = noop) {
  if (!hasApi('LanguageModel')) { onStatus('err', 'このブラウザ非対応'); return null; }
  if (summaryLM) return summaryLM;
  if (summaryCreating) { await summaryCreating.catch(noop); return summaryLM; }
  try {
    const av = await LanguageModel.availability(LM_IO);
    if (av === 'unavailable') { onStatus('err', 'PCの性能不足で利用不可'); return null; }
    if (av !== 'available' && !userClick) { onStatus('warn', '「AIを準備」を押してください'); return null; }
    onStatus('warn', 'AIを準備中…');
    summaryCreating = LanguageModel.create({
      initialPrompts: [{ role: 'system', content: buildSummarySystemPrompt() }],
      ...LM_IO,
      monitor: progressMonitor(onStatus),
    });
    summaryBase = await summaryCreating;
    summaryLM = makeSummaryLM();
    onStatus('ok', '利用可（PC内で処理）');
    return summaryLM;
  } catch (e) {
    onStatus('err', '準備失敗: ' + errMessage(e));
    return null;
  } finally {
    summaryCreating = null;
  }
}

// ---------- ブラウザの判定 ----------
export function isEdge() {
  if (typeof navigator === 'undefined') return false;
  const brands = navigator.userAgentData?.brands;
  if (Array.isArray(brands) && brands.some(b => /edge/i.test(b?.brand || ''))) return true;
  return /\bEdg(?:e|A|iOS)?\//.test(navigator.userAgent || '');
}
