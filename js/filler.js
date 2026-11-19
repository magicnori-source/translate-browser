// あいづち・感嘆だけの発言かどうかを判定する（純粋モジュール）
// 「Oh, wow.」「Yeah yeah.」「Okay.」のように、すべての語があいづちで、語数が少ないときだけ true。
// 「Yes.」「No.」「Thank you.」は意味のある答えなので false。

const MAX_WORDS = 6;

// 単独でも混ぜてもよいあいづち・感嘆
const INTERJECTIONS = [
  'oh', 'wow', 'whoa', 'um', 'uh', 'uhm', 'umm', 'er', 'erm', 'ah', 'aha', 'ahh',
  'hmm', 'hm', 'mm', 'mhm', 'mmm', 'huh', 'uh-huh', 'mm-hmm', 'mhmm', 'uh-oh', 'oops', 'gosh',
  'yeah', 'yep', 'yup', 'ooh', 'ha', 'haha', 'hahaha',
];

// 文全体があいづちだけのときに限って、あいづち扱いにする語。
// 判定は「全語が一覧に入っている」ときだけ true なので、本文中に混ざった場合は自然に false になる。
// sure（「はい」の答え）は意味があるので訳す
const ACKNOWLEDGEMENTS = ['okay', 'ok', 'right', 'alright', 'cool', 'great', 'nice'];

const WORDS = new Set([...INTERJECTIONS, ...ACKNOWLEDGEMENTS]);

// 伸ばした発音（Hmmmm, Ummm, Ahhh, Wooow, Hahaha など）
const STRETCHED = [
  /^h+m+$/, /^u+m+$/, /^u+h+$/, /^m+h*m+$/, /^a+h+$/, /^o+h+$/, /^w+o+w+$/,
  /^(ha)+h?$/, /^e+r+m*$/,
];

function isFillerWord(w) {
  return WORDS.has(w) || STRETCHED.some((re) => re.test(w));
}

function words(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\ball right\b/g, 'alright')
    .replace(/[^\p{L}\p{N}'\-\s]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[-']+|[-']+$/g, ''))
    .filter((w) => w !== '');
}

// 何語かでひとまとまりの感嘆・つなぎの言葉。文全体がこれら（と上のあいづち）だけなら訳さない
const PHRASES = [
  ['you', 'know', 'what', 'i', 'mean'], // 長い句を先に
  ['oh', 'my', 'god'], ['oh', 'my', 'gosh'], ['oh', 'my', 'goodness'], ['my', 'god'], ['my', 'gosh'], ['my', 'goodness'],
  ['oh', 'boy'], ['you', 'know'], ['i', 'mean'], ['you', 'see'], ['like'], ['goodness'],
];

// 語の並びの先頭から、一覧の句に当たる長さを返す（当たらなければ 0）
function phraseAt(ws, i) {
  for (const ph of PHRASES) {
    if (ph.every((w, k) => ws[i + k] === w)) return ph.length;
  }
  return 0;
}

export function isFiller(text) {
  const ws = words(text);
  if (ws.length === 0 || ws.length > MAX_WORDS) return false;
  for (let i = 0; i < ws.length;) {
    const n = phraseAt(ws, i);
    if (n) { i += n; continue; }
    if (!isFillerWord(ws[i])) return false;
    i++;
  }
  return true;
}

// 文頭・文末のあいづち（Um, Oh, Yeah, Mm-hmm など）を取り除いた文を返す（訳に使う）。
// 句読点のない認識では「Yeah yeah That's ...」「Um We're planning ...」のように本文とつながるため。
// okay / right などは「right now」のように意味があることがあるので、ここでは取り除かない。
const EDGE_WORDS = new Set(INTERJECTIONS);
function isEdgeFiller(token) {
  const w = token.toLowerCase().replace(/[’`]/g, "'").replace(/[^\p{L}\p{N}'\-]/gu, '').replace(/^[-']+|[-']+$/g, '');
  return w !== '' && (EDGE_WORDS.has(w) || STRETCHED.some((re) => re.test(w)));
}
// 文頭・文末で無条件に取り除く句は、純粋な感嘆だけ（「Oh my god」「Oh boy」など）。
const EXCLAIM_PHRASES = [
  ['oh', 'my', 'god'], ['oh', 'my', 'gosh'], ['oh', 'my', 'goodness'], ['my', 'god'], ['my', 'gosh'], ['my', 'goodness'],
  ['oh', 'boy'], ['goodness'],
];
// 「you know」「I mean」「you see」は「Do you know?」「That's what I mean.」のように普通の文でも使うので、
// カンマで区切られているとき（文頭なら句の直後、文末なら句の直前にカンマ）だけ取り除く。
// 句読点のない認識では区別できないので取り除かない。
const COMMA_PHRASES = [
  ['you', 'know', 'what', 'i', 'mean'], ['you', 'know'], ['i', 'mean'], ['you', 'see'],
];
function normToken(token) {
  return token.toLowerCase().replace(/[’`]/g, "'").replace(/[^\p{L}\p{N}'\-]/gu, '').replace(/^[-']+|[-']+$/g, '');
}
// toks[i] から始まる（dir=1）／toks[i] で終わる（dir=-1）句の語数。当たらなければ 0
function edgePhraseLen(toks, i, dir, lo, hi) {
  const match = (ph) => {
    const n = ph.length;
    const start = dir === 1 ? i : i - n + 1;
    if (start < lo || start + n > hi) return 0;
    return ph.every((w, k) => normToken(toks[start + k]) === w) ? n : 0;
  };
  for (const ph of EXCLAIM_PHRASES) { const n = match(ph); if (n) return n; }
  for (const ph of COMMA_PHRASES) {
    const n = match(ph);
    if (!n) continue;
    if (dir === 1) {
      // 文頭: 句の最後の語にカンマが付いていて、後ろに本文が続くとき（「You know, the data…」）
      if (/,$/.test(toks[i + n - 1]) && i + n < hi) return n;
    } else {
      // 文末: 句の直前の語にカンマが付いているとき（「…is strong, I mean.」）
      const before = i - n;
      if (before >= lo && /,$/.test(toks[before])) return n;
    }
  }
  return 0;
}
export function stripFillerEdges(text) {
  const src = String(text ?? '').trim();
  const toks = src.split(/\s+/).filter(Boolean);
  let a = 0, b = toks.length;
  for (;;) {
    if (a < b && isEdgeFiller(toks[a])) { a++; continue; }
    const n = a < b ? edgePhraseLen(toks, a, 1, a, b) : 0;
    if (n) { a += n; continue; }
    break;
  }
  for (;;) {
    if (b > a && isEdgeFiller(toks[b - 1])) { b--; continue; }
    const n = b > a ? edgePhraseLen(toks, b - 1, -1, a, b) : 0;
    if (n) { b -= n; continue; }
    break;
  }
  if (a === 0 && b === toks.length) return src;
  let out = toks.slice(a, b).join(' ').replace(/^[,;:.!?…\s]+/, '');
  if (b < toks.length) {
    // 文末を削ったときは、削った語に付いていた文末記号（. ? !）を残す
    const end = toks[toks.length - 1].match(/[.?!]+$/);
    out = out.replace(/[,;:\s]+$/, '');
    if (end && out && !/[.?!]$/.test(out)) out += end[0];
  }
  // 先頭を削ったときは、残りの最初の文字を大文字にする（英語の文として自然に）
  if (a > 0 && out) out = out[0].toUpperCase() + out.slice(1);
  return out;
}

