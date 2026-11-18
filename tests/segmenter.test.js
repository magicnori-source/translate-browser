import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSegmenter } from '../js/segmenter.js';

const sentences = (evs) => evs.filter((e) => e.type === 'sentence').map((e) => e.text);
const closes = (evs) => evs.filter((e) => e.type === 'paragraph-close');
const opens = (evs) => evs.filter((e) => e.type === 'paragraph-open');

// 200msごとに tick を呼び、出たイベントをまとめて返す
function tickUntil(seg, from, to) {
  const out = [];
  for (let t = from; t <= to; t += 200) out.push(...seg.tick(t));
  return out;
}

test('文末記号で即座に文になる', () => {
  const seg = createSegmenter();
  const evs = seg.final('Hello everyone.', 0);
  assert.deepEqual(sentences(evs), ['Hello everyone.']);
  assert.equal(opens(evs).length, 1);
  assert.equal(opens(evs)[0].paraId, 'p1');
  // paragraph-open は最初の文の直前
  const types = evs.map((e) => e.type);
  assert.ok(types.indexOf('paragraph-open') < types.indexOf('sentence'));
});

test('? と ! と閉じ記号つきの文末でも切れる', () => {
  const seg = createSegmenter();
  const evs = seg.final('Is it true? Yes! He said "stop." Then (really.) Done', 0);
  assert.deepEqual(sentences(evs), ['Is it true?', 'Yes!', 'He said "stop."', 'Then (really.)']);
  // 記号のない残りはまだ文にならず、表示用に残る
  assert.equal(evs.at(-1).type, 'interim');
  assert.equal(evs.at(-1).text, 'Done');
});

test('記号なしでも1.2秒で文になる（境界値）', () => {
  const seg = createSegmenter();
  assert.deepEqual(sentences(seg.final('so today we talk about', 1000)), []);
  assert.deepEqual(sentences(seg.tick(2199)), []);
  assert.deepEqual(sentences(seg.tick(2200)), ['so today we talk about']);
});

test('句読点なしで数語ずつ来る確定結果は、間が空くまで1文にまとまる', () => {
  const seg = createSegmenter();
  const evs = [];
  evs.push(...seg.final('so today we', 0));
  evs.push(...tickUntil(seg, 200, 800));
  evs.push(...seg.final('are going to talk', 900));
  evs.push(...tickUntil(seg, 1000, 1800));
  evs.push(...seg.final('about clinical trials', 1900));
  assert.deepEqual(sentences(evs), []);
  evs.push(...tickUntil(seg, 2000, 3200));
  assert.deepEqual(sentences(evs), ['so today we are going to talk about clinical trials']);
});

test('途中結果が来ている間は切らない', () => {
  const seg = createSegmenter();
  const evs = [...seg.final('we have three phases', 0)];
  // 1秒ごとに途中結果が伸び続ける
  for (let t = 1000; t <= 5000; t += 1000) {
    evs.push(...seg.interim('in the', t));
    evs.push(...seg.tick(t + 200));
  }
  assert.deepEqual(sentences(evs), []);
  assert.equal(closes(evs).length, 0);
  // 途中結果が止まって1.2秒たつと切れる
  assert.deepEqual(sentences(seg.tick(6199)), []);
  assert.deepEqual(sentences(seg.tick(6200)), ['we have three phases']);
});

test('interim の text は未確定の文の続き＋途中結果', () => {
  const seg = createSegmenter();
  seg.final('first part', 0);
  const evs = seg.interim('second part', 100);
  assert.deepEqual(evs, [{ type: 'interim', text: 'first part second part' }]);
  // 未確定部分がないときは途中結果だけ
  const seg2 = createSegmenter();
  assert.deepEqual(seg2.interim('  hello   there ', 0), [{ type: 'interim', text: 'hello there' }]);
});

test('1回の確定結果に2文 → 2文', () => {
  const seg = createSegmenter();
  const evs = seg.final('This is one. This is two.', 0);
  assert.deepEqual(sentences(evs), ['This is one.', 'This is two.']);
  const ss = evs.filter((e) => e.type === 'sentence');
  assert.deepEqual(ss.map((e) => [e.paraId, e.index]), [['p1', 0], ['p1', 1]]);
});

test('小数・略語では切らない', () => {
  const seg = createSegmenter();
  const evs = seg.final(
    'Dr. Smith gave 3.5 mg in the U.S. and the U.K. on St. James street, e.g. at Acme Inc. with Mr. and Mrs. Lee vs. Prof. Kim, i.e. approx. 1.5 times etc. See Fig. 2 and No. 5 now.',
    0,
  );
  assert.equal(sentences(evs).length, 1);
  assert.ok(sentences(evs)[0].startsWith('Dr. Smith gave 3.5 mg'));
  assert.ok(sentences(evs)[0].endsWith('No. 5 now.'));
});

test('略語が確定結果の終わりに来ても、次の確定結果とつながる', () => {
  const seg = createSegmenter();
  assert.deepEqual(sentences(seg.final('I met Dr.', 0)), []);
  assert.deepEqual(sentences(seg.final('Smith today.', 300)), ['I met Dr. Smith today.']);
});

test('「no.」は数字が続かなければ文末として扱う', () => {
  const seg = createSegmenter();
  assert.deepEqual(sentences(seg.final('The answer is no. We stop.', 0)), ['The answer is no.', 'We stop.']);
});

test('3秒無音で段落が閉じる（reason: silence、境界値）', () => {
  const seg = createSegmenter();
  seg.final('Hello there.', 0);
  assert.equal(closes(seg.tick(3000)).length, 0); // ちょうど3秒は「超」ではない
  const evs = seg.tick(3001);
  assert.equal(closes(evs).length, 1);
  assert.deepEqual(closes(evs)[0], { type: 'paragraph-close', paraId: 'p1', sentences: ['Hello there.'], reason: 'silence' });
  // 次の文は新しい段落
  const evs2 = seg.final('Next one.', 5000);
  assert.equal(opens(evs2)[0].paraId, 'p2');
  assert.equal(opens(evs2)[0].at, 5000);
});

test('記号なしの文は1.2秒で文になり、さらに無音が続けば同じ tick 列で段落も閉じる', () => {
  const seg = createSegmenter();
  seg.final('no punctuation here', 0);
  const evs = tickUntil(seg, 200, 3200);
  assert.deepEqual(sentences(evs), ['no punctuation here']);
  assert.equal(closes(evs).length, 1);
  assert.equal(closes(evs)[0].reason, 'silence');
});

test('無音判定は途中結果も含めた最後の音声時刻で行う', () => {
  const seg = createSegmenter();
  seg.final('Hello there.', 0);
  seg.interim('and', 2500);
  assert.equal(closes(seg.tick(3500)).length, 0);
  assert.equal(closes(seg.tick(5500)).length, 0);
  assert.equal(closes(seg.tick(5501)).length, 1);
});

test('4文で段落が閉じる（reason: count）', () => {
  const seg = createSegmenter();
  const evs = seg.final('One. Two. Three. Four. Five.', 0);
  const c = closes(evs);
  assert.equal(c.length, 1);
  assert.equal(c[0].reason, 'count');
  assert.deepEqual(c[0].sentences, ['One.', 'Two.', 'Three.', 'Four.']);
  // 5文目は p2
  const s5 = evs.filter((e) => e.type === 'sentence').at(-1);
  assert.equal(s5.paraId, 'p2');
  assert.equal(s5.index, 0);
  // 3文では閉じない
  const seg2 = createSegmenter();
  assert.equal(closes(seg2.final('One. Two. Three.', 0)).length, 0);
});

test('300文字を超える前に段落が閉じる（reason: chars、境界値）', () => {
  const a = 'a'.repeat(148) + '.'; // 149文字
  const b = 'b'.repeat(149) + '.'; // 150文字 → a + ' ' + b = 300文字ちょうど
  const seg = createSegmenter();
  const evs = seg.final(`${a} ${b}`, 0);
  assert.equal(closes(evs).length, 0, '300文字ちょうどは閉じない');

  const seg2 = createSegmenter();
  const b2 = 'b'.repeat(150) + '.'; // 合計301文字になる
  const evs2 = seg2.final(`${a} ${b2}`, 0);
  const c = closes(evs2);
  assert.equal(c.length, 1);
  assert.equal(c[0].reason, 'chars');
  assert.deepEqual(c[0].sentences, [a], '足す前に閉じる');
  const last = evs2.filter((e) => e.type === 'sentence').at(-1);
  assert.equal(last.paraId, 'p2');
  // 閉じる → 開く → 文 の順
  const types = evs2.map((e) => e.type);
  const ci = types.indexOf('paragraph-close');
  assert.equal(types[ci + 1], 'paragraph-open');
  assert.equal(types[ci + 2], 'sentence');
});

test('記号なしの長文を単語の切れ目で強制分割する', () => {
  const seg = createSegmenter();
  const words = Array.from({ length: 80 }, (_, i) => `word${i}`); // 約560文字
  const evs = seg.final(words.join(' '), 0);
  const ss = sentences(evs);
  assert.ok(ss.length >= 2);
  for (const s of ss) {
    assert.ok(s.length <= 250, `長さ ${s.length}`);
    assert.match(s, /^word\d+( word\d+)*$/, '単語の途中で切れていない');
  }
  // 分割した文と残りをつなぐと元に戻る
  const rest = evs.at(-1).text;
  assert.equal([...ss, rest].join(' '), words.join(' '));
});

test('強制分割の境界値: 250文字ちょうどは分割しない', () => {
  // final の切れ目での区切り（softSentenceChars）を止めて、強制分割だけを確かめる
  const seg = createSegmenter({ softSentenceChars: 0 });
  const t250 = ('abcd ').repeat(50).trim() + 'x'; // 250文字
  assert.equal(t250.length, 250);
  assert.deepEqual(sentences(seg.final(t250, 0)), []);
  const seg2 = createSegmenter({ softSentenceChars: 0 });
  const evs2 = seg2.final(t250 + 'y', 0);
  assert.equal(sentences(evs2).length, 1);
  assert.equal(evs2.at(-1).text, 'abcdxy', '強制分割の残りは未確定のまま');
});

test('空白のない長い文字列は文字数で切る', () => {
  const seg = createSegmenter();
  const evs = seg.final('x'.repeat(600), 0);
  assert.deepEqual(sentences(evs).map((s) => s.length), [250, 250]);
  assert.equal(evs.at(-1).text.length, 100);
});

test('flush で残り（未確定の確定結果と途中結果）が出て段落が閉じる', () => {
  const seg = createSegmenter();
  seg.final('First sentence. and then', 0);
  seg.interim('some more', 100);
  const evs = seg.flush(200);
  assert.deepEqual(sentences(evs), ['and then some more']);
  const c = closes(evs);
  assert.equal(c.length, 1);
  assert.equal(c[0].reason, 'flush');
  assert.deepEqual(c[0].sentences, ['First sentence.', 'and then some more']);
  assert.deepEqual(evs.at(-1), { type: 'interim', text: '' });
  // flush のあとは何も残らない
  assert.deepEqual(seg.tick(10000), []);
  assert.deepEqual(closes(seg.flush(10000)), []);
});

test('flush で記号つきの文が複数残っていても分けて出る', () => {
  const seg = createSegmenter();
  seg.interim('One. Two', 0);
  assert.deepEqual(sentences(seg.flush(100)), ['One.', 'Two']);
});

test('何もないときの tick・flush は空', () => {
  const seg = createSegmenter();
  assert.deepEqual(seg.tick(0), []);
  assert.deepEqual(seg.flush(0), [{ type: 'interim', text: '' }]);
});

test('paraId は p1, p2, … の連番（flush をまたいでも続く）', () => {
  const seg = createSegmenter();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const evs = [...seg.final('Hi.', i * 10000), ...seg.flush(i * 10000 + 1)];
    ids.push(...opens(evs).map((e) => e.paraId));
  }
  assert.deepEqual(ids, ['p1', 'p2', 'p3']);
});

test('paragraph-open の at は話し始め（最初の途中結果）の時刻', () => {
  const seg = createSegmenter();
  seg.interim('hello', 500);
  const evs = seg.final('Hello world.', 1500);
  assert.equal(opens(evs)[0].at, 500);
});

test('setOptions が効く（文の待ち・段落の無音・文数・文字数・強制分割）', () => {
  const seg = createSegmenter();
  seg.setOptions({ sentenceGapMs: 500, paragraphGapMs: 1000, maxSentences: 2 });
  seg.final('short wait', 0);
  assert.deepEqual(sentences(seg.tick(499)), []);
  assert.deepEqual(sentences(seg.tick(500)), ['short wait']);
  assert.equal(closes(seg.tick(1001)).length, 1);

  const evs = seg.final('A. B. C.', 2000);
  assert.equal(closes(evs)[0].reason, 'count');
  assert.deepEqual(closes(evs)[0].sentences, ['A.', 'B.']);

  const seg2 = createSegmenter({ maxChars: 10, maxSentenceChars: 20 });
  const evs2 = seg2.final('Hello. World.', 0);
  assert.equal(closes(evs2)[0].reason, 'chars');
  const evs3 = seg2.final('one two three four five six', 100);
  assert.ok(sentences(evs3).every((s) => s.length <= 20));
});

test('setOptions は不正な値を無視し、渡していない項目は変えない', () => {
  const seg = createSegmenter();
  seg.setOptions({ sentenceGapMs: -1, paragraphGapMs: 'x', maxSentences: NaN });
  seg.setOptions(null);
  seg.final('still default', 0);
  assert.deepEqual(sentences(seg.tick(1199)), []);
  assert.deepEqual(sentences(seg.tick(1200)), ['still default']);
});

// 句読点なしで数語ずつ届く final（Chromeの実際の認識に近い）
const CHUNKS = [
  'so today i want to talk', // 23
  'about the results of our', // 24
  'phase three clinical trial', // 26
  'which we finished last month', // 28
  'and the primary endpoint was', // 28 → ここで累計 133（初めて120以上）
  'met with a clear margin',
];

test('句読点なし: 120字以上になった最初の final の終わりで文になる', () => {
  const seg = createSegmenter();
  const evs = [];
  let acc = '';
  for (let i = 0; i < 4; i++) {
    evs.push(...seg.final(CHUNKS[i], i * 500));
    acc = acc ? acc + ' ' + CHUNKS[i] : CHUNKS[i];
  }
  assert.ok(acc.length < 120, `4つ目まで ${acc.length}字`);
  assert.deepEqual(sentences(evs), [], '120字未満の final の切れ目では切らない');
  const evs5 = seg.final(CHUNKS[4], 2000);
  const expected = CHUNKS.slice(0, 5).join(' ');
  assert.ok(expected.length >= 120);
  assert.deepEqual(sentences(evs5), [expected]);
  assert.equal(evs5.at(-1).text, '', '未確定の部分は残らない');
  // 次の final は新しい文の始まり
  assert.deepEqual(sentences(seg.final(CHUNKS[5], 2500)), []);
  assert.deepEqual(sentences(seg.tick(3700)), [CHUNKS[5]]);
});

test('句読点なし: softSentenceChars の境界値（119字は切らない・120字で切る）', () => {
  const seg = createSegmenter();
  const first = 'x'.repeat(59);
  assert.deepEqual(sentences(seg.final(first, 0)), []);
  assert.deepEqual(sentences(seg.final('y'.repeat(59), 100)), [], '59+1+59=119字');
  const seg2 = createSegmenter();
  seg2.final(first, 0);
  assert.equal(sentences(seg2.final('y'.repeat(60), 100)).length, 1, '59+1+60=120字');
});

test('句読点なし: 長い入力でも文の切れ目が final の切れ目になり、強制分割が起きない', () => {
  const seg = createSegmenter();
  const evs = [];
  const finals = [];
  for (let i = 0; i < 40; i++) {
    const f = `chunk${i} goes on with some words`;
    finals.push(f);
    evs.push(...seg.final(f, i * 600));
  }
  const ss = sentences(evs);
  assert.ok(ss.length >= 3);
  for (const s of ss) {
    assert.ok(s.length < 250, '強制分割の長さに達していない');
    assert.match(s, /goes on with some words$/, 'final の終わりで切れている');
  }
  // 段落も文の途中ではなく、文の切れ目で閉じる
  for (const c of closes(evs)) {
    for (const s of c.sentences) assert.match(s, /goes on with some words$/);
  }
});

test('句読点あり: 文末記号が先に効き、記号のあとの短い残りは final の切れ目で切らない', () => {
  const seg = createSegmenter();
  const long = 'This is a long sentence that keeps going and going for quite a while to exceed the soft limit easily';
  const evs = seg.final(`${long}. and then`, 0);
  assert.deepEqual(sentences(evs), [`${long}.`]);
  assert.equal(evs.at(-1).text, 'and then');
});

test('softSentenceChars は setOptions で変えられ、0 で無効', () => {
  const seg = createSegmenter();
  seg.setOptions({ softSentenceChars: 20 });
  assert.deepEqual(sentences(seg.final('one two three', 0)), []);
  assert.deepEqual(sentences(seg.final('four five', 100)), ['one two three four five']);

  const off = createSegmenter({ softSentenceChars: 0 });
  const evs = [];
  for (let i = 0; i < 6; i++) evs.push(...off.final(CHUNKS[i], i * 500));
  assert.deepEqual(sentences(evs), [], '無効なら final の切れ目では切らない');
  // 強制分割（最後の保険）は無効にしても残る
  const evs2 = off.final('z '.repeat(100), 3000);
  assert.ok(sentences(evs2).length >= 1);
  assert.ok(sentences(evs2).every((s) => s.length <= 250));
});

test('空の確定結果・途中結果は音声として数えない', () => {
  const seg = createSegmenter();
  seg.final('Hello.', 0);
  seg.interim('', 2000);
  seg.final('   ', 2500);
  assert.equal(closes(seg.tick(3001)).length, 1);
});

test('句読点が付く認識では、長い文を final の切れ目で切らない（softSentenceChars は句読点なしの認識だけ）', () => {
  const seg = createSegmenter({ sentenceGapMs: 1200, paragraphGapMs: 3000 });
  let t = 1000;
  const sentences = [];
  const take = evs => { for (const e of evs) if (e.type === 'sentence') sentences.push(e.text); };
  // まず句読点付きの文で「句読点が付く認識」だと分かる
  take(seg.final('This is the first sentence.', t += 300));
  // 20語以上の長い文が、文末記号なしの final に分かれて届く（間は短い）
  const parts = ['and then we looked at the response rate across', 'all of the subgroups that were prespecified in the', 'statistical analysis plan including the patients with', 'low expression of the target and the elderly patients'];
  for (const p of parts) take(seg.final(p, t += 300));
  take(seg.final('which was reassuring.', t += 300));
  assert.equal(sentences.length, 2);
  assert.equal(sentences[0], 'This is the first sentence.');
  assert.match(sentences[1], /^and then we looked .* which was reassuring\.$/);
});

test('確定結果が来ないまま途中結果が残った場合、段落の無音を超えたら文として確定し、途中結果を消す', () => {
  const seg = createSegmenter({ sentenceGapMs: 1200, paragraphGapMs: 3000 });
  seg.interim('we are now going to', 1000);
  // 認識が止まって final が来ない。3秒までは残す
  let evs = seg.tick(3800);
  assert.equal(sentences(evs).length, 0);
  evs = seg.tick(4200);
  assert.deepEqual(sentences(evs), ['we are now going to']);
  assert.equal(closes(evs).length, 1);
  const last = evs.filter(e => e.type === 'interim').pop();
  assert.equal(last.text, '');
});
