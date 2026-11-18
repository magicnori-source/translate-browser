import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, buildRefinePrompt, cleanRefineOutput } from '../js/prompt.js';

const para = (i, len = 40) => ({ src: `S${i} ` + 'x'.repeat(len), ja: `J${i} ` + 'あ'.repeat(len) });

// 文脈部分（【文脈】の次の行から【訳す段落】の前まで）を取り出す
function contextLines(prompt) {
  const lines = prompt.split('\n');
  const s = lines.indexOf('【文脈（訳さない）】');
  if (s < 0) return [];
  const e = lines.findIndex((l, i) => i > s && l.startsWith('【'));
  return lines.slice(s + 1, e);
}

test('システムプロンプトに主要なルールが入っている', () => {
  const s = buildSystemPrompt();
  assert.match(s, /英語のまま/);
  assert.match(s, /120万/);
  assert.match(s, /訳文だけ/);
  assert.match(s, /文脈/);
});

test('訳す段落と参考の機械訳が入る', () => {
  const p = buildRefinePrompt({ target: { src: 'Hello\nworld.', ja: 'こんにちは世界。' } });
  assert.match(p, /【訳す段落】\n英: Hello world\.\n参考の機械訳: こんにちは世界。$/);
  assert.equal(contextLines(p).length, 0);
  assert.doesNotMatch(p, /【文脈/);
});

test('文脈は直前3段落以内', () => {
  const ctx = [para(1), para(2), para(3), para(4), para(5)];
  const lines = contextLines(buildRefinePrompt({ target: { src: 'Now.', ja: '今。' }, context: ctx }));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^英: S3 .* \/ 訳: J3 /);
  assert.match(lines[2], /^英: S5 /);
});

test('文脈は上限字数を守り、古い方から削る', () => {
  const ctx = [para(1, 200), para(2, 200), para(3, 200)];
  const max = 900;
  const lines = contextLines(buildRefinePrompt({ target: { src: 'Now.', ja: '今。' }, context: ctx, maxContextChars: max }));
  const total = lines.join('\n').length;
  assert.ok(total <= max, `文脈 ${total} 字が上限 ${max} 字を超えている`);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^英: S2 /); // 一番古い S1 が削られる
  assert.match(lines[1], /^英: S3 /);
});

test('1段落でも上限を超えるなら文脈を出さない', () => {
  const p = buildRefinePrompt({ target: { src: 'Now.', ja: '今。' }, context: [para(1, 2000)], maxContextChars: 100 });
  assert.doesNotMatch(p, /【文脈/);
});

test('用語集は空なら行ごと出さず、段落に出てくる語だけ入れる', () => {
  const target = { src: 'We met the primary endpoint.', ja: '主要エンドポイントを達成した。' };
  assert.doesNotMatch(buildRefinePrompt({ target, glossary: [] }), /【用語】/);
  const p = buildRefinePrompt({ target, glossary: [{ en: 'endpoint', ja: '評価項目' }, { en: 'placebo', ja: 'プラセボ' }] });
  assert.match(p, /【用語】endpoint＝評価項目\n/);
  assert.doesNotMatch(p, /placebo/);
  // 該当語がなければ行ごと出さない
  assert.doesNotMatch(buildRefinePrompt({ target, glossary: [{ en: 'placebo', ja: 'プラセボ' }] }), /【用語】/);
});

test('前置きを除去する', () => {
  const ref = { src: 'We hit our primary endpoint.', ja: '私たちは主要評価項目を達成しました。' };
  for (const raw of [
    '以下が訳です。主要評価項目を達成しました。',
    '以下は日本語訳です：主要評価項目を達成しました。',
    '訳：主要評価項目を達成しました。',
    '日本語訳: 主要評価項目を達成しました。',
    '【訳】主要評価項目を達成しました。',
    'Translation: 主要評価項目を達成しました。',
  ]) {
    const r = cleanRefineOutput(raw, ref);
    assert.equal(r.ok, true, raw);
    assert.equal(r.text, '主要評価項目を達成しました。', raw);
  }
});

test('前後の引用符・コードブロック・「英:」行を除去する', () => {
  const ref = { src: 'We hit our primary endpoint.', ja: '私たちは主要評価項目を達成しました。' };
  for (const raw of [
    '「主要評価項目を達成しました。」',
    '"主要評価項目を達成しました。"',
    '“主要評価項目を達成しました。”',
    '```\n主要評価項目を達成しました。\n```',
    '```text\n「主要評価項目を達成しました。」\n```',
    '英: We hit our primary endpoint.\n訳: 主要評価項目を達成しました。',
    '  \n訳：「主要評価項目を達成しました。」\n',
  ]) {
    const r = cleanRefineOutput(raw, ref);
    assert.equal(r.ok, true, raw);
    assert.equal(r.text, '主要評価項目を達成しました。', raw);
  }
});

test('中身の途中にある引用符は残す', () => {
  const r = cleanRefineOutput('「速い」と「安い」を両立した。', { src: 'fast and cheap', ja: '速くて安い。' });
  assert.equal(r.ok, true);
  assert.equal(r.text, '「速い」と「安い」を両立した。');
});

test('製品名など英語が混ざっても日本語中心なら ok', () => {
  const r = cleanRefineOutput('Pfizer社のComirnatyは有効率95%だった。', { src: 'Pfizer Comirnaty efficacy was 95 percent.', ja: 'ファイザーのComirnatyの有効性は95%でした。' });
  assert.equal(r.ok, true);
});

test('空なら ok:false', () => {
  const ref = { src: 'Hello.', ja: 'こんにちは。' };
  for (const raw of ['', '   ', '```\n```', '「」', '訳：', null, undefined]) {
    const r = cleanRefineOutput(raw, ref);
    assert.equal(r.ok, false, String(raw));
    assert.equal(r.reason, 'empty', String(raw));
  }
});

test('段落訳の2.5倍を超える長さなら ok:false', () => {
  const ref = { src: 'We hit it.', ja: 'あいうえおかきくけこ' }; // 10字
  assert.equal(cleanRefineOutput('あ'.repeat(25), ref).ok, true);
  const r = cleanRefineOutput('あ'.repeat(26), ref);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-long');
});

test('英語ばかりなら ok:false', () => {
  const ref = { src: 'We hit our primary endpoint.', ja: '私たちは主要評価項目を達成しました。' };
  const r = cleanRefineOutput('We hit our primary endpoint.', ref);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-japanese');
});
