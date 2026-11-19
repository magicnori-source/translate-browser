// 要約（内蔵LLM）のプロンプト作成と、出力の整形（純粋モジュール）
// DOM・ブラウザAPI・時刻・タイマーは使わない。

// 要点の最大数
const MAX_POINTS = 5;

// 何も話し合われていない（あいさつ・進行だけの）ときの話題
const EMPTY_TOPIC = 'あいさつ・進行の連絡のみ';

/** Prompt API の responseConstraint に渡す JSON スキーマ */
export const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    topic: { type: 'string' },
    points: { type: 'array', items: { type: 'string' }, maxItems: MAX_POINTS },
    facts: { type: 'array', items: { type: 'string' } },
    qa: { type: 'array', items: { type: 'string' } },
  },
  required: ['topic', 'points', 'facts', 'qa'],
  additionalProperties: false,
};

// 要約に入れないもの（システムプロンプトと sharedContext で共通）
const EXCLUDE_RULE = '次のものは要約に入れない：あいさつ・お礼（「お集まりいただきありがとうございます」など）、進行の連絡（「次の質問です」「画面を共有します」「聞こえていますか」など）、あいづち・言いよどみ。';

export function buildSummarySystemPrompt() {
  return [
    'あなたは英語の講演を聞いて、日本語で要約を書く担当です。',
    '目的は、その時間に何が話されたのかが、後から読んで分かる要約を作ることです。訳文を並べるのではなく、内容をまとめ直してください。',
    `- ${EXCLUDE_RULE}`,
    '- topic（話題）: 何についての話だったかを日本語で1行にまとめる。',
    `- points（要点）: 話の中身を3〜5個の短い箇条書きにする（最大${MAX_POINTS}個）。講演者が強調した主張を優先する。`,
    '- facts（数字・固有名詞・結論）: 出てきた数字・固有名詞・結論を箇条書きにする。なければ空の配列にする。',
    '- qa（質疑応答）: 質疑応答があったときだけ「質問 → 答え」の形でまとめる。なければ空の配列にする。',
    '- 人名・社名・製品名は英語のまま書く。',
    '- 数字は日本語の単位に直す（1.2 million → 120万、3 billion → 30億、50 percent → 50%）。',
    `- 中身がほとんどなく、あいさつや進行の連絡だけのときは、topic を「${EMPTY_TOPIC}」とし、points・facts・qa は空の配列にする。`,
    '- 各項目の先頭に「・」や「-」は付けない。',
    '- 出力は指定された形式の JSON だけ。説明や前置きは書かない。',
  ].join('\n');
}

// 改行や連続する空白を1つの空白にまとめる
function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 要約のユーザー側プロンプトを作る。
 * srcText は英語の原文（講演の文字起こし）。maxChars を超えたら古い方（先頭）から削る。
 */
export function buildSummaryPrompt(srcText, { maxChars = 6000 } = {}) {
  let src = oneLine(srcText);
  if (src.length > maxChars) {
    src = src.slice(src.length - maxChars);
    // 単語の途中で切れた先頭を落とす（空白がなければそのまま）
    const sp = src.indexOf(' ');
    if (sp >= 0 && sp < src.length - 1) src = src.slice(sp + 1);
  }
  return [
    '次の英語の講演の文字起こしを、日本語で要約してください。',
    `あいさつ・お礼・進行の連絡だけで中身がほとんどない場合は、topic を「${EMPTY_TOPIC}」とし、points を空の配列にしてください。`,
    '【原文】',
    src,
  ].join('\n');
}

// 項目の前後の空白と、先頭の箇条書き記号（・ - * • ●）を除く
function cleanItem(s) {
  return String(s).trim().replace(/^(?:[・\-*•●‐－]\s*)+/, '').trim();
}

// 文字列の配列（または未指定）を整える。形が違えば null
function cleanList(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const x of v) {
    if (typeof x !== 'string' && typeof x !== 'number') return null;
    const t = cleanItem(x);
    if (t) out.push(t);
  }
  return out;
}

/**
 * 要約の JSON（文字列またはオブジェクト）を見出し付きの文章にする。
 * 読めない・形が違うときは null。
 */
export function formatSummary(jsonOrText) {
  let obj = jsonOrText;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj.trim()); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.topic !== 'string') return null;

  const topic = obj.topic.trim().replace(/^【話題】\s*/, '').trim();
  const points = cleanList(obj.points);
  const facts = cleanList(obj.facts);
  const qa = cleanList(obj.qa);
  if (!topic || !points || !facts || !qa) return null;

  // 要点も数字も質疑もなければ、話題の1行だけ
  if (!points.length && !facts.length && !qa.length) return topic;

  const out = [`【話題】${topic}`];
  const section = (title, items) => {
    if (items.length) out.push(title, ...items.map(t => `・${t}`));
  };
  section('【要点】', points.slice(0, MAX_POINTS));
  section('【数字・固有名詞・結論】', facts);
  section('【質疑応答】', qa);
  return out.join('\n');
}

/** Summarizer API に切り替える場合の sharedContext */
export const SUMMARIZER_SHARED_CONTEXT = [
  '英語の講演の文字起こしを、日本語で要約してください。',
  'その時間に何が話されたのかが分かるように、話題と要点・数字・固有名詞・結論を中心にまとめてください。',
  EXCLUDE_RULE,
  '人名・社名・製品名は英語のまま書き、数字は日本語の単位に直してください（1.2 million → 120万）。',
].join('\n');
