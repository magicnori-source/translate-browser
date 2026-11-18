// テスト再生用の台本づくり（純粋）。
// 英文を、音声認識が出すような「時刻つきの途中結果・確定結果」の列に変える。
// DOM・タイマー・現在時刻は使わない。乱数は seed 付きなので、同じ入力なら必ず同じ結果になる。

// seed 付きの乱数（mulberry32）。0以上1未満を返す関数を作る
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 空行で段落に分け、段落ごとに単語の配列にする
function splitParagraphs(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map(p => p.split(/\s+/).filter(Boolean))
    .filter(words => words.length > 0);
}

// 句読点なし認識（Chrome）を模擬する。単語末尾の . ? ! , を除く（小数 3.5 の途中の点は残す）
function stripPunctuation(word) {
  // 末尾の閉じ引用符・かっこは一度外し、句読点を除いてから戻す
  const m = word.match(/^(.*?)(["'”’)]*)$/);
  let core = m[1];
  const tail = m[2];
  core = core.replace(/[.?!,]+$/, '');
  const out = core + tail;
  return out;
}

// 確定結果1つ分の文字列を作る。punctuate:false なら先頭以外を小文字にする
function chunkText(words, punctuate) {
  if (punctuate) return words.join(' ');
  const joined = words.map(stripPunctuation).filter(Boolean).join(' ');
  if (!joined) return '';
  return joined.charAt(0) + joined.slice(1).toLowerCase();
}

// 文末の判定に使う略語（小文字・末尾の点を含む）。これらで終わる語は文末とみなさない
const ABBREVIATIONS = new Set([
  'dr.', 'mr.', 'mrs.', 'ms.', 'prof.', 'u.s.', 'u.k.', 'e.g.', 'i.e.', 'vs.', 'etc.',
  'inc.', 'ltd.', 'co.', 'corp.', 'no.', 'fig.', 'approx.', 'st.',
]);

// 元の英文の語が文末か（. ? ! で終わる。後ろに閉じ引用符・かっこが続いてよい。略語は除く）
function isSentenceEnd(word) {
  const core = word.replace(/["'”’)]+$/, '');
  if (!/[.?!]$/.test(core)) return false;
  if (core.endsWith('.') && ABBREVIATIONS.has(core.replace(/^["'“‘(]+/, '').toLowerCase())) return false;
  return true;
}

// [最小, 最大] の範囲を正規化する。数値1つなら [n, n]
function toRange(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return [Math.max(0, v), Math.max(0, v)];
  if (Array.isArray(v) && v.length >= 1) {
    const a = Math.max(0, Number(v[0]) || 0);
    const b = Math.max(a, Number(v[1] ?? v[0]) || 0);
    return [a, b];
  }
  return fallback;
}

/**
 * 英文を時刻つきの途中結果・確定結果の列にする。
 * @param {string} text 英文。空行で段落を区切る
 * @param {object} [opts]
 * @param {number} [opts.wpm=150] 1分あたりの語数
 * @param {number[]} [opts.finalChunkWords=[5,15]] 確定結果1つに入れる語数の範囲（最小, 最大）。文末に来たら途中でも区切る
 * @param {boolean} [opts.punctuate=true] false なら句読点を除き、先頭以外を小文字にする（文末の判定は元の英文で行う）
 * @param {number} [opts.paragraphPauseMs=3500] 段落の切れ目に入れる無音の長さ
 * @param {number[]|number} [opts.sentencePauseMs=[400,900]] 文末のあとに入れる息継ぎの無音の範囲。0 か [0,0] で無効
 * @param {number} [opts.longPauseRate=0.15] 文末のうち、長めの間（1300〜2000ms）にする割合。0 で無効
 * @param {number} [opts.seed=1] 乱数の種
 * @returns {{at:number, type:'interim'|'final', text:string}[]} at は再生開始からのミリ秒（昇順）
 */
export function buildTimeline(text, {
  wpm = 150,
  finalChunkWords = [5, 15],
  punctuate = true,
  paragraphPauseMs = 3500,
  sentencePauseMs = [400, 900],
  longPauseRate = 0.15,
  seed = 1,
} = {}) {
  const rand = mulberry32(seed);
  const msPerWord = 60000 / Math.max(1, wpm);
  const minW = Math.max(1, Math.floor(finalChunkWords[0] ?? 5));
  const maxW = Math.max(minW, Math.floor(finalChunkWords[1] ?? minW));
  const nextChunkSize = () => minW + Math.floor(rand() * (maxW - minW + 1));
  const [pauseMin, pauseMax] = toRange(sentencePauseMs, [400, 900]);
  const longRate = Math.min(1, Math.max(0, Number(longPauseRate) || 0));
  const LONG_MIN = 1300, LONG_MAX = 2000;

  // 文末のあとの無音の長さ。乱数の消費回数を一定にして、設定が変わっても区切りがぶれにくいようにする
  function sentencePause() {
    const r1 = rand(), r2 = rand();
    if (longRate > 0 && r1 < longRate) return LONG_MIN + r2 * (LONG_MAX - LONG_MIN);
    if (pauseMax <= 0) return 0;
    return pauseMin + r2 * (pauseMax - pauseMin);
  }

  const events = [];
  let t = 0;
  const paragraphs = splitParagraphs(text);

  paragraphs.forEach((words, pi) => {
    if (pi > 0) t += paragraphPauseMs; // 段落の切れ目の無音
    let chunk = [];
    let size = nextChunkSize();
    words.forEach((word, wi) => {
      t += msPerWord;
      chunk.push(word);
      const isLastInPara = wi === words.length - 1;
      const sentenceEnd = isSentenceEnd(word); // 句読点を除く前の元の語で判定する
      if (chunk.length >= size || isLastInPara || sentenceEnd) {
        const s = chunkText(chunk, punctuate);
        if (s) events.push({ at: Math.round(t), type: 'final', text: s });
        chunk = [];
        size = nextChunkSize();
        // 文末なら息継ぎの無音を入れる（段落の最後は段落の無音に任せる）
        if (sentenceEnd && !isLastInPara) t += sentencePause();
      } else {
        const s = chunkText(chunk, punctuate);
        if (s) events.push({ at: Math.round(t), type: 'interim', text: s });
      }
    });
  });

  return events;
}
