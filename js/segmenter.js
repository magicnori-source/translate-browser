// 文と段落の区切り（純粋モジュール）
// 音声認識の途中結果・確定結果を受け取り、「文」と「段落」のイベントに変換する。
// DOM・タイマー・Date.now() は使わない。時刻はすべて引数 now（ミリ秒）で受け取る。

const DEFAULTS = Object.freeze({
  sentenceGapMs: 1200,    // 新しい音声が来ないまま、この時間たったら文として確定する
  paragraphGapMs: 3000,   // 無音がこの時間を超えたら段落を閉じる
  maxSentences: 4,        // 段落の最大文数
  maxChars: 300,          // 段落の最大文字数（次の文を足すと超えるなら、足す前に閉じる）
  maxSentenceChars: 250,  // 文末記号のない長い文を、単語の切れ目で強制分割する長さ（最後の保険）
  softSentenceChars: 120, // 未確定の文がこの長さ以上になったら、確定結果（final）の終わりで文にする。0 なら無効
});

// 0 を「無効」として受け付ける設定
const ZERO_ALLOWED = new Set(['softSentenceChars']);
// 句読点なしの認識とみなすまでの、文末記号のない final の回数
const PUNCT_MEMORY = 8;

// 文末と見なさない略語（小文字で比較）
const ABBREVIATIONS = new Set([
  'dr.', 'mr.', 'mrs.', 'ms.', 'prof.', 'u.s.', 'u.k.', 'e.g.', 'i.e.', 'vs.',
  'etc.', 'inc.', 'ltd.', 'co.', 'corp.', 'fig.', 'approx.', 'st.',
]);

// 文末記号の後ろに続いてよい閉じ記号
const CLOSERS = new Set(['"', "'", ')', '”', '’']);

function normalize(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function joinText(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a + ' ' + b;
}

// 位置 i（'.'）が略語の終わりかどうか
function isAbbreviationAt(text, i) {
  let start = i;
  while (start > 0 && text[start - 1] !== ' ') start--;
  // 先頭の開き記号を除く
  const token = text.slice(start, i + 1).replace(/^["'(“‘]+/, '').toLowerCase();
  if (ABBREVIATIONS.has(token)) return true;
  // 「No.」は直後が数字のとき（No. 5）だけ略語として扱う（「The answer is no.」で切れるように）
  if (token === 'no.') {
    const rest = text.slice(i + 1).trimStart();
    return /^\d/.test(rest);
  }
  return false;
}

// text の中から文末記号で区切れる位置を探し、{sentences, rest} を返す
function splitByPunctuation(text) {
  const sentences = [];
  let from = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '.' || ch === '?' || ch === '!') {
      // 連続する記号（... や ?!）と閉じ記号をまとめる
      let end = i + 1;
      while (end < text.length && (text[end] === '.' || text[end] === '?' || text[end] === '!')) end++;
      while (end < text.length && CLOSERS.has(text[end])) end++;
      const atEnd = end >= text.length;
      const followedBySpace = !atEnd && text[end] === ' ';
      let boundary = atEnd || followedBySpace;
      // 小数（1.5）は直後が空白でないので上の判定で除外される。
      // 単独の '.' で、略語の終わりなら切らない
      if (boundary && ch === '.' && end === i + 1 && isAbbreviationAt(text, i)) boundary = false;
      if (boundary) {
        const s = text.slice(from, end).trim();
        if (s) sentences.push(s);
        from = end;
      }
      i = end;
      continue;
    }
    i++;
  }
  return { sentences, rest: text.slice(from).trim() };
}

// 長すぎる文を単語の切れ目で切る。{head, rest} を返す
function forceSplit(text, limit) {
  let cut = text.lastIndexOf(' ', limit);
  if (cut <= 0) cut = limit; // 空白がなければ文字数で切る
  return { head: text.slice(0, cut).trim(), rest: text.slice(cut).trim() };
}

export function createSegmenter(options = {}) {
  const opts = { ...DEFAULTS };
  applyOptions(options);

  let pending = '';          // 確定結果のうち、まだ文になっていない部分
  let finalsSincePunct = PUNCT_MEMORY; // 文末記号のない final が続いた回数（始めは句読点なしとみなす）
  let interimText = '';      // 最新の途中結果
  let lastVoiceAt = null;    // 途中結果も含めた最後の音声時刻
  let sentenceStartAt = null; // 今の文（未確定部分）の話し始めの時刻
  let para = null;           // { id, sentences: [] }
  let paraCount = 0;

  function applyOptions(partial) {
    if (!partial || typeof partial !== 'object') return;
    for (const key of Object.keys(DEFAULTS)) {
      const v = partial[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (v > 0 || (v === 0 && ZERO_ALLOWED.has(key))) opts[key] = v;
    }
  }

  function displayText() {
    return joinText(pending, interimText);
  }

  function closeParagraph(reason, events) {
    if (!para) return;
    events.push({ type: 'paragraph-close', paraId: para.id, sentences: para.sentences.slice(), reason });
    para = null;
  }

  function commitSentence(text, now, events) {
    const s = normalize(text);
    if (!s) return;
    if (para && para.sentences.length > 0) {
      const currentLen = para.sentences.join(' ').length;
      if (currentLen + 1 + s.length > opts.maxChars) closeParagraph('chars', events);
    }
    if (!para) {
      paraCount++;
      para = { id: 'p' + paraCount, sentences: [] };
      events.push({ type: 'paragraph-open', paraId: para.id, at: sentenceStartAt ?? now });
    }
    para.sentences.push(s);
    events.push({ type: 'sentence', paraId: para.id, index: para.sentences.length - 1, text: s });
    sentenceStartAt = null;
    if (para.sentences.length >= opts.maxSentences) closeParagraph('count', events);
  }

  // pending から文末記号で切れる文と、長すぎる部分を確定する
  function drainPending(now, events) {
    const { sentences, rest } = splitByPunctuation(pending);
    pending = rest;
    for (const s of sentences) commitSentence(s, now, events);
    while (pending.length > opts.maxSentenceChars) {
      const { head, rest: r } = forceSplit(pending, opts.maxSentenceChars);
      pending = r;
      commitSentence(head, now, events);
    }
  }

  function noteVoice(now) {
    lastVoiceAt = now;
    if (sentenceStartAt === null) sentenceStartAt = now;
  }

  return {
    interim(text, now) {
      interimText = normalize(text);
      if (interimText) noteVoice(now);
      return [{ type: 'interim', text: displayText() }];
    },

    final(text, now) {
      const t = normalize(text);
      interimText = '';
      const events = [];
      if (t) {
        noteVoice(now);
        // 直近の final に文末記号があったかを覚える（句読点が付く認識かどうかの判定）
        finalsSincePunct = /[.?!]["')\]”’]*(\s|$)/.test(t) ? 0 : finalsSincePunct + 1;
        pending = joinText(pending, t);
        drainPending(now, events);
        // 句読点なしの認識向け: Chrome は一息つくたびに final を返すので、
        // 未確定の文が十分長ければ final の切れ目を文の区切りとして使う
        // 句読点が付く認識（直近 PUNCT_MEMORY 回の final のどこかに文末記号がある）では使わない
        if (opts.softSentenceChars > 0 && finalsSincePunct >= PUNCT_MEMORY && pending.length >= opts.softSentenceChars) {
          commitSentence(pending, now, events);
          pending = '';
        }
      }
      // 表示用の文字列（残った未確定部分）も更新する
      events.push({ type: 'interim', text: displayText() });
      return events;
    },

    tick(now) {
      const events = [];
      if (lastVoiceAt === null) return events;
      const silence = now - lastVoiceAt;
      // 音声認識が確定結果を返さないまま止まった（再開した）場合、途中結果が残り続けるので、
      // 段落の区切りと同じ長さの無音が続いたら、聞こえた分を文として確定する
      if (interimText && silence > opts.paragraphGapMs) {
        pending = joinText(pending, interimText);
        interimText = '';
      }
      if (pending && silence >= opts.sentenceGapMs) {
        commitSentence(pending, now, events);
        pending = '';
        events.push({ type: 'interim', text: displayText() });
      }
      if (para && !pending && silence > opts.paragraphGapMs) {
        closeParagraph('silence', events);
      }
      return events;
    },

    flush(now) {
      const events = [];
      // 確定していない途中結果も、停止時は残りとして確定する
      pending = joinText(pending, interimText);
      interimText = '';
      if (pending) {
        drainPending(now, events);
        if (pending) commitSentence(pending, now, events);
        pending = '';
      }
      closeParagraph('flush', events);
      sentenceStartAt = null;
      lastVoiceAt = null;
      events.push({ type: 'interim', text: '' });
      return events;
    },

    setOptions(partial) {
      applyOptions(partial);
    },
  };
}
