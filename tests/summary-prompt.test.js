import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUMMARY_SCHEMA, buildSummarySystemPrompt, buildSummaryPrompt, formatSummary, SUMMARIZER_SHARED_CONTEXT,
} from '../js/summary-prompt.js';

test('スキーマは topic・points（最大5）・facts・qa', () => {
  assert.equal(SUMMARY_SCHEMA.type, 'object');
  const p = SUMMARY_SCHEMA.properties;
  assert.equal(p.topic.type, 'string');
  assert.equal(p.points.type, 'array');
  assert.equal(p.points.items.type, 'string');
  assert.equal(p.points.maxItems, 5);
  assert.equal(p.facts.items.type, 'string');
  assert.equal(p.qa.items.type, 'string');
  assert.deepEqual([...SUMMARY_SCHEMA.required].sort(), ['facts', 'points', 'qa', 'topic']);
  // JSON にできる（responseConstraint に渡せる）
  assert.deepEqual(JSON.parse(JSON.stringify(SUMMARY_SCHEMA)), SUMMARY_SCHEMA);
});

test('システムプロンプトに方針が入っている', () => {
  const s = buildSummarySystemPrompt();
  assert.match(s, /何が話された/);
  assert.match(s, /あいさつ/);
  assert.match(s, /お礼/);
  assert.match(s, /お集まりいただきありがとうございます/);
  assert.match(s, /進行の連絡/);
  assert.match(s, /次の質問です/);
  assert.match(s, /画面を共有します/);
  assert.match(s, /あいづち/);
  assert.match(s, /入れない/);
  assert.match(s, /3〜5個/);
  assert.match(s, /質疑応答があったときだけ/);
  assert.match(s, /英語のまま/);
  assert.match(s, /120万/);
  assert.match(s, /あいさつ・進行の連絡のみ/);
  assert.match(s, /JSON/);
});

test('ユーザー側プロンプトに原文と「中身がないとき」の指示が入る', () => {
  const p = buildSummaryPrompt('Hello\n everyone.  Thanks for joining.');
  assert.match(p, /【原文】\nHello everyone\. Thanks for joining\.$/);
  assert.match(p, /topic を「あいさつ・進行の連絡のみ」/);
  assert.match(p, /points を空の配列/);
});

test('maxChars を超えたら先頭（古い方）から削る', () => {
  const words = Array.from({ length: 300 }, (_, i) => `w${i}`);
  const src = words.join(' ');
  const p = buildSummaryPrompt(src, { maxChars: 100 });
  const body = p.split('【原文】\n')[1];
  assert.ok(body.length <= 100, `原文 ${body.length} 字が上限を超えている`);
  assert.ok(body.endsWith('w299'), '末尾（新しい方）が残る');
  assert.ok(!body.includes('w0 '), '先頭（古い方）が削られる');
  // 単語の途中から始まらない
  assert.ok(words.includes(body.split(' ')[0]), body.split(' ')[0]);
});

test('maxChars 以内ならそのまま', () => {
  const p = buildSummaryPrompt('We hit our primary endpoint.', { maxChars: 6000 });
  assert.match(p, /【原文】\nWe hit our primary endpoint\.$/);
});

test('formatSummary: 全項目あり', () => {
  const json = JSON.stringify({
    topic: '新薬の第3相試験の結果',
    points: ['主要評価項目を達成した', ' ・副作用は軽度が中心 ', '- 来年に承認申請する'],
    facts: ['患者数 1,200人', 'Pfizer'],
    qa: ['対象年齢は？ → 18歳以上'],
  });
  assert.equal(formatSummary(json), [
    '【話題】新薬の第3相試験の結果',
    '【要点】',
    '・主要評価項目を達成した',
    '・副作用は軽度が中心',
    '・来年に承認申請する',
    '【数字・固有名詞・結論】',
    '・患者数 1,200人',
    '・Pfizer',
    '【質疑応答】',
    '・対象年齢は？ → 18歳以上',
  ].join('\n'));
});

test('formatSummary: オブジェクトも受け付ける', () => {
  const s = formatSummary({ topic: '話題', points: ['a'], facts: [], qa: [] });
  assert.equal(s, '【話題】話題\n【要点】\n・a');
});

test('formatSummary: qa が空なら【質疑応答】を出さない', () => {
  const s = formatSummary({ topic: '話題', points: ['a', 'b'], facts: ['120万人'], qa: [] });
  assert.equal(s, '【話題】話題\n【要点】\n・a\n・b\n【数字・固有名詞・結論】\n・120万人');
  assert.doesNotMatch(s, /質疑応答/);
});

test('formatSummary: facts が空なら見出しを出さない', () => {
  const s = formatSummary({ topic: '話題', points: ['a'], facts: [], qa: ['Q → A'] });
  assert.equal(s, '【話題】話題\n【要点】\n・a\n【質疑応答】\n・Q → A');
  assert.doesNotMatch(s, /数字・固有名詞・結論/);
});

test('formatSummary: topic のみならその1行', () => {
  assert.equal(formatSummary('{"topic":"あいさつ・進行の連絡のみ","points":[],"facts":[],"qa":[]}'), 'あいさつ・進行の連絡のみ');
  assert.equal(formatSummary({ topic: ' あいさつ・進行の連絡のみ ', points: ['  ', '・'] }), 'あいさつ・進行の連絡のみ');
});

test('formatSummary: 先頭の「・」「-」を重複させず、要点は最大5個', () => {
  const s = formatSummary({ topic: 't', points: ['・・a', '- b', '-c', '* d', '• e', 'f'], facts: [], qa: [] });
  assert.equal(s, '【話題】t\n【要点】\n・a\n・b\n・c\n・d\n・e');
});

test('formatSummary: 壊れたJSON・前置き付き・形が違うものは null', () => {
  for (const bad of [
    '{"topic":"話題","points":["a"',
    '',
    'ただの文章',
    '以下が要約です。{"topic":"話題","points":["a"],"facts":[],"qa":[]}',
    'Here is the summary:\n{"topic":"話題","points":[],"facts":[],"qa":[]}',
    '[]',
    'null',
    '"話題"',
    null,
    undefined,
    42,
    { points: ['a'] },
    { topic: '', points: ['a'] },
    { topic: 1, points: [] },
    { topic: '話題', points: 'a' },
    { topic: '話題', points: [{ x: 1 }] },
    { topic: '話題', points: [], facts: {}, qa: [] },
  ]) {
    assert.equal(formatSummary(bad), null, JSON.stringify(bad));
  }
});

test('Summarizer 用の sharedContext に方針が入っている', () => {
  const s = SUMMARIZER_SHARED_CONTEXT;
  assert.equal(typeof s, 'string');
  assert.match(s, /日本語/);
  assert.match(s, /あいさつ/);
  assert.match(s, /お礼/);
  assert.match(s, /進行の連絡/);
  assert.match(s, /話題/);
  assert.match(s, /要点/);
  assert.match(s, /数字/);
  assert.match(s, /結論/);
});
