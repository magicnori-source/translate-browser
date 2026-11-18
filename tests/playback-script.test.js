import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTimeline } from '../js/playback-script.js';
import { createPlayback } from '../js/playback.js';

const TEXT = `So, good morning everyone. Dr. Smith will join us later, you know.
We enrolled 1.2 million patients in the U.S. and frankly the results were strong.

Next paragraph starts here. The dose was 3.5 mg, e.g. once daily, for twelve weeks.
Any questions? Great, let's move on!`;

test('seed が同じなら同じ結果、違えば区切りが変わる', () => {
  const a = buildTimeline(TEXT, { seed: 42 });
  const b = buildTimeline(TEXT, { seed: 42 });
  assert.deepEqual(a, b);
  const c = buildTimeline(TEXT, { seed: 7 });
  assert.notDeepEqual(a.map(e => e.type), c.map(e => e.type));
});

test('段落の切れ目に3.5秒以上の無音が入る', () => {
  const tl = buildTimeline(TEXT, { seed: 3 });
  const finals = tl.filter(e => e.type === 'final');
  // 1段落目の最後の確定結果を探す
  const idx = finals.findIndex(e => e.text.endsWith('strong.'));
  assert.ok(idx >= 0);
  const lastOfP1 = finals[idx];
  const next = tl.find(e => e.at > lastOfP1.at);
  assert.ok(next.at - lastOfP1.at >= 3500, `無音が ${next.at - lastOfP1.at}ms しかない`);
  // 段落内の間隔は無音より短い
  const gaps = tl.slice(1).map((e, i) => e.at - tl[i].at);
  assert.equal(gaps.filter(g => g >= 3500).length, 1);
});

test('interim は確定結果まで単調に伸び、確定結果はその続きになる', () => {
  for (const punctuate of [true, false]) {
    const tl = buildTimeline(TEXT, { seed: 5, punctuate });
    let prev = '';
    for (const e of tl) {
      if (e.type === 'interim') {
        assert.ok(e.text.startsWith(prev) && e.text.length > prev.length, `伸びていない: "${prev}" → "${e.text}"`);
        prev = e.text;
      } else {
        assert.ok(e.text.startsWith(prev), `確定結果が途中結果の続きでない: "${prev}" → "${e.text}"`);
        prev = '';
      }
    }
  }
});

test('時刻は昇順で、150語/分なら1語400ms', () => {
  const tl = buildTimeline('one two three four five six', { finalChunkWords: [10, 10] });
  assert.deepEqual(tl.map(e => e.at), [400, 800, 1200, 1600, 2000, 2400]);
  assert.equal(tl.at(-1).type, 'final');
  assert.equal(tl.at(-1).text, 'one two three four five six');
  for (let i = 1; i < tl.length; i++) assert.ok(tl[i].at >= tl[i - 1].at);
});

test('確定結果は15語以下（文末で区切れないときは5語以上）、全語が順番どおり1回ずつ出る', () => {
  const tl = buildTimeline(TEXT, { seed: 11 });
  const finals = tl.filter(e => e.type === 'final');
  const words = TEXT.split(/\s+/).filter(Boolean);
  assert.deepEqual(finals.flatMap(f => f.text.split(' ')), words);
  for (const f of finals) {
    const n = f.text.split(' ').length;
    assert.ok(n <= 15, `語数が多すぎる: ${n}`);
    if (!/[.?!]$/.test(f.text)) assert.ok(n >= 5, `語数が少なすぎる: ${n}`);
  }
});

// 文末（略語・小数を除く）の語
const SENTENCE_ENDS = ['everyone.', 'know.', 'strong.', 'here.', 'weeks.', 'questions?', 'on!'];

test('文末の語で final が終わり、略語・小数では切らない', () => {
  for (const punctuate of [true, false]) {
    const tl = buildTimeline(TEXT, { seed: 9, punctuate, finalChunkWords: [15, 15] });
    const finals = tl.filter(e => e.type === 'final');
    // 句読点なしでも、元の英文の文末と同じ位置で区切られる
    const lastWords = finals.map(f => f.text.split(' ').length);
    const words = TEXT.split(/\s+/).filter(Boolean);
    let i = 0; const ends = [];
    for (const n of lastWords) { i += n; ends.push(words[i - 1]); }
    for (const w of SENTENCE_ENDS) assert.ok(ends.includes(w), `${w} で区切られていない（punctuate:${punctuate}）`);
    for (const w of ['Dr.', 'U.S.', 'e.g.', '3.5']) assert.ok(!ends.includes(w), `${w} で区切られた`);
  }
});

test('文末のあとに設定範囲の無音があり、長めの間も出る', () => {
  const sentences = Array.from({ length: 200 }, (_, i) => `This is sentence number ${i}.`).join(' ');
  const msPerWord = 400;
  for (const seed of [1, 2, 3]) {
    const tl = buildTimeline(sentences, { seed, finalChunkWords: [10, 10] });
    let normal = 0, long = 0;
    for (let i = 0; i < tl.length - 1; i++) {
      if (tl[i].type !== 'final') continue;
      const gap = tl[i + 1].at - tl[i].at - msPerWord;
      if (gap >= 400 - 1 && gap <= 900 + 1) normal++;
      else if (gap >= 1300 - 1 && gap <= 2000 + 1) long++;
      else assert.fail(`範囲外の無音: ${gap}ms`);
    }
    assert.equal(normal + long, 199);
    assert.ok(long >= 10 && long <= 55, `長めの間の数: ${long}`);
  }
  // 無効にすると無音なし（final は文末で切れる）
  const off = buildTimeline(sentences, { seed: 1, sentencePauseMs: 0, longPauseRate: 0, finalChunkWords: [10, 10] });
  for (let i = 1; i < off.length; i++) assert.equal(off[i].at - off[i - 1].at, msPerWord);
  assert.equal(off.filter(e => e.type === 'final').length, 200);
  const off2 = buildTimeline(sentences, { seed: 1, sentencePauseMs: [0, 0], longPauseRate: 0 });
  assert.deepEqual(off2.map(e => e.at), off.map(e => e.at));
  // 指定した範囲が効く
  const fixed = buildTimeline('One two. Three four.', { sentencePauseMs: [700, 700], longPauseRate: 0 });
  assert.deepEqual(fixed.map(e => [e.at, e.type]), [[400, 'interim'], [800, 'final'], [1900, 'interim'], [2300, 'final']]);
});

test('文末の無音つきでも seed が同じなら同じ結果', () => {
  const s = readFileSync(new URL('../data/sample-talk.txt', import.meta.url), 'utf8');
  for (const punctuate of [true, false]) {
    assert.deepEqual(buildTimeline(s, { seed: 123, punctuate }), buildTimeline(s, { seed: 123, punctuate }));
  }
  assert.notDeepEqual(buildTimeline(s, { seed: 1 }).map(e => e.at), buildTimeline(s, { seed: 2 }).map(e => e.at));
});

test('punctuate:false なら . ? ! , を除き、先頭以外を小文字にする（小数の点は残す）', () => {
  const tl = buildTimeline(TEXT, { seed: 2, punctuate: false });
  const all = tl.filter(e => e.type === 'final').map(e => e.text).join(' ');
  assert.doesNotMatch(all, /[?!,]/);
  assert.doesNotMatch(all, /\.(\s|$)/);
  assert.match(all, /3\.5 mg/);
  for (const e of tl) assert.equal(e.text.slice(1), e.text.slice(1).toLowerCase());
});

test('空の英文なら空の列、段落区切りの空白行が複数でも1回の無音', () => {
  assert.deepEqual(buildTimeline(''), []);
  assert.deepEqual(buildTimeline('  \n\n  '), []);
  const tl = buildTimeline('a b c\n\n\n\n d e f', { finalChunkWords: [10, 10] });
  assert.equal(tl.filter(e => e.type === 'final').length, 2);
  assert.equal(tl[3].at - tl[2].at, 3500 + 400);
});

test('サンプル英文は約10段落・1200〜1500語', () => {
  const s = readFileSync(new URL('../data/sample-talk.txt', import.meta.url), 'utf8');
  const paras = s.replace(/\r\n?/g, '\n').split(/\n\s*\n/).filter(p => p.trim());
  const words = s.split(/\s+/).filter(Boolean).length;
  assert.ok(paras.length >= 9 && paras.length <= 12, `段落数 ${paras.length}`);
  assert.ok(words >= 1200 && words <= 1500, `語数 ${words}`);
  assert.ok(buildTimeline(s).length > words * 0.9);
});

test('playback: 列を順に流し、stop 後は何も出さない', async () => {
  const pb = createPlayback({ text: 'one two three four five six seven', wpm: 6000, speed: 1 });
  const got = [];
  pb.on('interim', t => got.push(['i', t]));
  pb.on('final', t => got.push(['f', t]));
  const ended = new Promise(r => pb.on('end', r));
  pb.start();
  await ended;
  assert.equal(got.at(-1)[0], 'f');
  assert.equal(got.filter(g => g[0] === 'f').map(g => g[1]).join(' '), 'one two three four five six seven');

  const pb2 = createPlayback({ text: 'a b c d e f g h i j', wpm: 60 }); // 1語1秒
  const got2 = [];
  pb2.on('interim', t => got2.push(t));
  let endCount = 0; pb2.on('end', () => endCount++);
  pb2.start(); pb2.stop();
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(got2, []);
  assert.equal(endCount, 1);
});
