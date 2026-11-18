import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranscript } from '../js/transcript.js';

function setup() {
  const tr = createTranscript();
  tr.openParagraph('p1', 1000);
  return tr;
}

test('openParagraph で初期状態の段落ができる', () => {
  const tr = setup();
  assert.deepEqual(tr.get('p1'), {
    id: 'p1', startedAt: 1000, sentences: [], src: '', ja: '', stage: 'pending', closed: false, version: 0,
  });
  // 同じ id をもう一度開いても作り直さない
  tr.addSentence('p1', 'A.');
  tr.openParagraph('p1', 9999);
  assert.equal(tr.get('p1').startedAt, 1000);
  assert.equal(tr.all().length, 1);
});

test('addSentence は version を1増やし、src を空白で連結する', () => {
  const tr = setup();
  assert.equal(tr.addSentence('p1', 'Hello.'), 1);
  assert.equal(tr.addSentence('p1', 'World.'), 2);
  const p = tr.get('p1');
  assert.equal(p.version, 2);
  assert.deepEqual(p.sentences, ['Hello.', 'World.']);
  assert.equal(p.src, 'Hello. World.');
});

test('閉じた段落・ない段落には文を足せない', () => {
  const tr = setup();
  tr.addSentence('p1', 'A.');
  assert.equal(tr.close('p1'), true);
  assert.equal(tr.get('p1').closed, true);
  assert.equal(tr.addSentence('p1', 'B.'), null);
  assert.equal(tr.get('p1').version, 1);
  assert.equal(tr.addSentence('nope', 'X.'), null);
  assert.equal(tr.close('nope'), false);
});

test('setJa paragraph で訳と段階が入る', () => {
  const tr = setup();
  tr.addSentence('p1', 'Hello.');
  assert.equal(tr.setJa('p1', 'こんにちは。', 'paragraph', 1), true);
  assert.equal(tr.get('p1').ja, 'こんにちは。');
  assert.equal(tr.get('p1').stage, 'paragraph');
  assert.equal(tr.bestJa('p1'), 'こんにちは。');
});

test('refined のあとに paragraph が来ても上書きしない', () => {
  const tr = setup();
  tr.addSentence('p1', 'Hello.');
  tr.setJa('p1', '段落訳', 'paragraph', 1);
  assert.equal(tr.setJa('p1', '仕上げ訳', 'refined'), true);
  assert.equal(tr.setJa('p1', '遅れて届いた段落訳', 'paragraph', 1), false);
  assert.equal(tr.setJa('p1', 'さらに新しい段落訳', 'paragraph', 5), false);
  assert.equal(tr.get('p1').ja, '仕上げ訳');
  assert.equal(tr.get('p1').stage, 'refined');
  assert.equal(tr.bestJa('p1'), '仕上げ訳');
});

test('古い version の paragraph を無視する', () => {
  const tr = setup();
  tr.addSentence('p1', 'A.');
  tr.addSentence('p1', 'B.');
  assert.equal(tr.setJa('p1', '訳v2', 'paragraph', 2), true);
  assert.equal(tr.setJa('p1', '訳v1', 'paragraph', 1), false);
  assert.equal(tr.get('p1').ja, '訳v2');
  // 同じ version の再送は受け付ける（境界値）
  assert.equal(tr.setJa('p1', '訳v2再', 'paragraph', 2), true);
  assert.equal(tr.get('p1').ja, '訳v2再');
});

test('文が増える前の訳も、まだ新しい訳がなければ表示に使う', () => {
  const tr = setup();
  tr.addSentence('p1', 'A.');
  tr.addSentence('p1', 'B.'); // version 2
  assert.equal(tr.setJa('p1', '訳v1', 'paragraph', 1), true);
  assert.equal(tr.setJa('p1', '訳v2', 'paragraph', 2), true);
  assert.equal(tr.get('p1').ja, '訳v2');
});

test('version を省略した paragraph は今の version として扱う', () => {
  const tr = setup();
  tr.addSentence('p1', 'A.');
  tr.addSentence('p1', 'B.');
  assert.equal(tr.setJa('p1', '訳', 'paragraph'), true);
  assert.equal(tr.setJa('p1', '古い', 'paragraph', 1), false);
});

test('setJa の不正な入力は false', () => {
  const tr = setup();
  assert.equal(tr.setJa('nope', '訳', 'paragraph', 1), false);
  assert.equal(tr.setJa('p1', '訳', 'flash', 1), false);
  assert.equal(tr.setJa('p1', '', 'paragraph', 1), false);
  assert.equal(tr.setJa('p1', '   ', 'refined'), false);
  assert.equal(tr.setJa('p1', null, 'refined'), false);
  assert.equal(tr.get('p1').stage, 'pending');
});

test('get・all はコピーを返し、外から書き換えても中身は変わらない', () => {
  const tr = setup();
  tr.addSentence('p1', 'A.');
  const p = tr.get('p1');
  p.sentences.push('X.');
  p.ja = 'いたずら';
  tr.all()[0].sentences.push('Y.');
  assert.deepEqual(tr.get('p1').sentences, ['A.']);
  assert.equal(tr.get('p1').ja, '');
  assert.equal(tr.get('nope'), null);
  assert.equal(tr.bestJa('nope'), '');
});

test('all は作った順、recent は直近 n 段落を古い順に返す', () => {
  const tr = createTranscript();
  for (let i = 1; i <= 5; i++) tr.openParagraph('p' + i, i);
  assert.deepEqual(tr.all().map((p) => p.id), ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.deepEqual(tr.recent(3).map((p) => p.id), ['p3', 'p4', 'p5']);
  assert.deepEqual(tr.recent(3, 'p4').map((p) => p.id), ['p1', 'p2', 'p3']);
  assert.deepEqual(tr.recent(3, 'p2').map((p) => p.id), ['p1']);
  assert.deepEqual(tr.recent(3, 'p1'), []);
  assert.deepEqual(tr.recent(10).length, 5);
  assert.deepEqual(tr.recent(0), []);
  assert.deepEqual(tr.recent(2, 'nope'), []);
});

test('clear で空になり、同じ id を作り直せる', () => {
  const tr = setup();
  tr.addSentence('p1', 'A.');
  tr.setJa('p1', '訳', 'paragraph', 5);
  tr.clear();
  assert.deepEqual(tr.all(), []);
  assert.equal(tr.get('p1'), null);
  tr.openParagraph('p1', 0);
  tr.addSentence('p1', 'B.');
  // clear 前の version 情報は残っていない
  assert.equal(tr.setJa('p1', '新しい訳', 'paragraph', 1), true);
});
