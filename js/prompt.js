// 仕上げ訳（内蔵LLM）のプロンプト作成と、出力の後処理（純粋モジュール）
// DOM・ブラウザAPI・時刻・タイマーは使わない。

// 文脈に入れる段落の最大数（直前2〜3段落）
const MAX_CONTEXT_PARAS = 3;

export function buildSystemPrompt() {
  return [
    'あなたは英語の講演を日本語の字幕にする通訳者です。',
    '- 直訳ではなく、意味が伝わる自然で簡潔な日本語にする。要点だけを短く。話す速さで読める長さにする。',
    '- 人名・社名・製品名・薬剤名は英語のまま書く。',
    '- 数字は日本語の単位に直す（1.2 million → 120万、3 billion → 30億、50 percent → 50%）。',
    '- あいづち・感嘆・言いよどみ（um, uh, oh, wow, you know, I mean, like など）は訳さない。',
    '- 「文脈」は理解のためだけに使い、訳さない。訳すのは「訳す段落」だけ。',
    '- 出力は訳文だけ。説明・前置き・引用符・原文は書かない。',
  ].join('\n');
}

// 改行や連続する空白を1つの空白にまとめる（プロンプトの1行に収めるため）
function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function contextLine(p) {
  return `英: ${oneLine(p?.src)} / 訳: ${oneLine(p?.ja)}`;
}

// 用語集の1件を {en, ja} にそろえる。{en, ja}・{src, ja}・[en, ja] を受け付ける
function normalizeTerm(t) {
  if (Array.isArray(t)) return { en: oneLine(t[0]), ja: oneLine(t[1]) };
  if (t && typeof t === 'object') return { en: oneLine(t.en ?? t.src), ja: oneLine(t.ja) };
  return { en: '', ja: '' };
}

// 英語の語が原文に出てくるか（大文字小文字を区別せず、単語の途中では一致させない）
function containsTerm(src, en) {
  const esc = en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${esc}($|[^A-Za-z0-9])`, 'i').test(src);
}

/**
 * 仕上げ訳のユーザー側プロンプトを作る。
 * - 文脈は直前の最大3段落。全体が maxContextChars を超えたら古い方から削る。
 * - 用語集は「訳す段落」に出てくる語だけを入れる。1つもなければ行ごと出さない。
 */
export function buildRefinePrompt({ target, context = [], glossary = [], maxContextChars = 1500 } = {}) {
  const src = oneLine(target?.src);
  const ja = oneLine(target?.ja);

  // 直前3段落以内に絞り、上限字数に収まるまで古い方から削る
  let lines = (Array.isArray(context) ? context : [])
    .filter(p => p && (oneLine(p.src) || oneLine(p.ja)))
    .slice(-MAX_CONTEXT_PARAS)
    .map(contextLine);
  const total = ls => ls.reduce((n, l) => n + l.length, 0) + Math.max(0, ls.length - 1);
  while (lines.length && total(lines) > maxContextChars) lines.shift();

  const terms = (Array.isArray(glossary) ? glossary : [])
    .map(normalizeTerm)
    .filter(t => t.en && t.ja && containsTerm(src, t.en));

  const out = [];
  if (lines.length) {
    out.push('【文脈（訳さない）】', ...lines);
  }
  if (terms.length) {
    out.push('【用語】' + terms.map(t => `${t.en}＝${t.ja}`).join('、'));
  }
  out.push('【訳す段落】', `英: ${src}`);
  if (ja) out.push(`参考の機械訳: ${ja}`);
  return out.join('\n');
}

// 前置きとして消す言い回し（行頭）
// 例: 「以下が訳です。」「以下は日本語訳です：」「訳：」「日本語訳:」「【訳】」「Here is the translation:」
const PREFACE_RE = /^(?:以下[^\n。：:]{0,20}?(?:訳|翻訳)[^\n。：:]{0,10}?[。：:]|(?:日本語)?(?:訳文|訳|翻訳|字幕)(?:結果)?\s*[：:]|【(?:訳|訳文|翻訳|日本語訳)】|(?:here\s+is\s+the\s+)?(?:japanese\s+)?translation\s*:|japanese\s*:)\s*/i;
// 原文の行（「英:」「English:」「原文:」）
const SOURCE_LINE_RE = /^\s*(?:英|英語|原文|English|Source)\s*[：:]/i;
// 対になる引用符
const QUOTE_PAIRS = [['「', '」'], ['『', '』'], ['"', '"'], ['“', '”'], ["'", "'"], ['‘', '’']];

function stripOnce(text) {
  let t = text.trim();
  // コードブロック（```〜```）の囲みを外す
  const fence = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fence) t = fence[1].trim();
  t = t.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim();
  // 「英:」などの原文の行と、「参考の機械訳:」の行を除く
  t = t.split('\n').filter(l => !SOURCE_LINE_RE.test(l) && !/^\s*参考の機械訳\s*[：:]/.test(l)).join('\n').trim();
  // 行頭の前置きを除く
  t = t.replace(PREFACE_RE, '').trim();
  // 前後の引用符を外す（中に同じ閉じ記号がないときだけ）
  for (const [o, c] of QUOTE_PAIRS) {
    if (t.length >= 2 && t.startsWith(o) && t.endsWith(c)) {
      const inner = t.slice(o.length, t.length - c.length);
      if (!inner.includes(c)) { t = inner.trim(); break; }
    }
  }
  return t;
}

// 文字のうち日本語（ひらがな・カタカナ・漢字）が占める割合
function japaneseRatio(text) {
  const letters = text.match(/\p{L}/gu) || [];
  if (!letters.length) return 0;
  const jp = letters.filter(ch => /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]/u.test(ch)).length;
  return jp / letters.length;
}

// 長すぎ判定の倍率と、日本語の割合の下限
const MAX_LENGTH_RATIO = 2.5;
const MIN_JAPANESE_RATIO = 0.3;

/**
 * 内蔵LLMの出力を整える。
 * 戻り値 {ok, text, reason}  reason: ''（ok）| 'empty' | 'too-long' | 'not-japanese'
 */
export function cleanRefineOutput(raw, { src = '', ja = '' } = {}) {
  let t = typeof raw === 'string' ? raw.replace(/\r\n?/g, '\n') : '';
  // 前置き・引用符・コードブロックが重なっていることがあるので、変化がなくなるまで繰り返す
  for (let i = 0; i < 5; i++) {
    const next = stripOnce(t);
    if (next === t) break;
    t = next;
  }
  // 字幕なので改行は空白1つにまとめる
  t = t.split('\n').map(l => l.trim()).filter(Boolean).join(' ').trim();

  if (!t) return { ok: false, text: '', reason: 'empty' };

  // 段落訳の2.5倍を超えたら長すぎ。段落訳がないときは原文の字数を目安にする
  const base = oneLine(ja).length || oneLine(src).length;
  if (base && t.length > base * MAX_LENGTH_RATIO) return { ok: false, text: t, reason: 'too-long' };

  if (japaneseRatio(t) < MIN_JAPANESE_RATIO) return { ok: false, text: t, reason: 'not-japanese' };

  return { ok: true, text: t, reason: '' };
}
