import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslateQueue } from '../js/translate-queue.js';

// ---- 偽の時計 ----
function createClock() {
  let t = 0;
  let timers = [];
  let seq = 0;
  return {
    now: () => t,
    schedule(fn, ms) {
      const timer = { at: t + ms, fn, id: seq++, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    async advance(ms) {
      const end = t + ms;
      await flush(); // 解決済みの Promise を先に進める（実際のイベントループと同じ順）
      for (;;) {
        const due = timers
          .filter((x) => !x.cancelled && x.at <= end)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        t = due.at;
        due.cancelled = true;
        due.fn();
        await flush();
      }
      t = end;
      await flush();
    },
    pending: () => timers.filter((x) => !x.cancelled).length,
  };
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

// ---- 偽の翻訳関数（結果を外から解決できる） ----
function createFakeFn() {
  const calls = [];
  const fn = (...args) => new Promise((resolve, reject) => {
    calls.push({ args, resolve, reject });
  });
  return { fn, calls };
}

function setup(opts = {}) {
  const clock = createClock();
  const tr = createFakeFn();
  const rf = createFakeFn();
  const q = createTranslateQueue({
    translate: tr.fn,
    refine: opts.noRefine ? null : rf.fn,
    now: clock.now,
    schedule: clock.schedule,
    ...opts.options,
  });
  const events = [];
  for (const name of ['flash', 'paragraph', 'refined', 'refine-skipped', 'stats', 'error']) {
    q.on(name, (p) => events.push({ name, ...p }));
  }
  const of = (name) => events.filter((e) => e.name === name);
  return { clock, tr, rf, q, events, of };
}

// ---------------- 速報 ----------------
test('速報は1秒に1回まで・最新だけ送る', async () => {
  const { clock, tr, q, of } = setup();
  q.requestFlash('a');
  await flush();
  assert.equal(tr.calls.length, 1);
  assert.equal(tr.calls[0].args[0], 'a');
  tr.calls[0].resolve('ア');
  await flush();
  assert.deepEqual(of('flash').map((e) => [e.text, e.ja]), [['a', 'ア']]);

  // 1秒未満のあいだに何度来ても送らない
  await clock.advance(200);
  q.requestFlash('ab');
  q.requestFlash('abc');
  await clock.advance(300);
  q.requestFlash('abcd');
  assert.equal(tr.calls.length, 1);

  // 1秒経ったら最新だけ送る
  await clock.advance(500);
  assert.equal(tr.calls.length, 2);
  assert.equal(tr.calls[1].args[0], 'abcd');
  assert.equal(clock.now(), 1000);
  tr.calls[1].resolve('アブ');
  await flush();
  assert.equal(of('flash').length, 2);
  const last = of('stats').at(-1);
  assert.equal(last.dropped, 2); // ab と abc を捨てた
});

test('速報の翻訳中に来た分は、終わってから間隔を守って最新だけ送る', async () => {
  const { clock, tr, q } = setup();
  q.requestFlash('a');
  await clock.advance(1500);
  q.requestFlash('b');
  q.requestFlash('c');
  await flush();
  assert.equal(tr.calls.length, 1); // 翻訳中なので待つ
  tr.calls[0].resolve('ア');
  await flush();
  assert.equal(tr.calls.length, 2);
  assert.equal(tr.calls[1].args[0], 'c');
});

test('setFlashEnabled(false) で速報を送らず結果も出さない', async () => {
  const { clock, tr, q, of } = setup();
  q.requestFlash('a');
  await flush();
  q.setFlashEnabled(false);
  tr.calls[0].resolve('ア');
  q.requestFlash('b');
  await clock.advance(2000);
  assert.equal(tr.calls.length, 1);
  assert.equal(of('flash').length, 0);
  q.setFlashEnabled(true);
  q.requestFlash('c');
  await flush();
  assert.equal(tr.calls.length, 2);
});

// ---------------- 段落訳 ----------------
test('段落訳が待ち中・翻訳中なら速報を捨て、段落訳を優先する', async () => {
  const { clock, tr, q, of } = setup();
  q.requestFlash('x');          // 翻訳中
  await flush();
  q.requestFlash('y');          // 待ち
  q.requestParagraph('p1', 'Hello.', 1); // 待ち中の速報 y を捨てる
  q.requestFlash('z');          // 段落訳待ち中なので捨てる
  tr.calls[0].resolve('エックス');
  await flush();
  assert.equal(tr.calls.length, 2);
  assert.equal(tr.calls[1].args[0], 'Hello.');
  q.requestFlash('w');          // 段落訳の翻訳中なので捨てる
  tr.calls[1].resolve('こんにちは。');
  await clock.advance(5000);
  assert.equal(tr.calls.length, 2); // 速報は1件も送られていない
  assert.deepEqual(of('paragraph').map((e) => [e.paraId, e.ja, e.version]), [['p1', 'こんにちは。', 1]]);
  assert.equal(of('stats').at(-1).dropped, 3); // y, z, w
});

test('同じ段落の段落訳は最新の依頼に差し替える', async () => {
  const { tr, q, of } = setup();
  q.requestParagraph('p1', 'A.', 1); // すぐ翻訳中
  await flush();
  q.requestParagraph('p1', 'A. B.', 2);
  q.requestParagraph('p1', 'A. B. C.', 3);
  tr.calls[0].resolve('ア');
  await flush();
  assert.equal(tr.calls.length, 2);
  assert.equal(tr.calls[1].args[0], 'A. B. C.');
  tr.calls[1].resolve('アイウ');
  await flush();
  assert.equal(tr.calls.length, 2);
  assert.deepEqual(of('paragraph').map((e) => e.version), [1, 3]);
});

test('別の段落の段落訳は順番に両方処理する', async () => {
  const { tr, q, of } = setup();
  q.requestParagraph('p1', 'A.', 1);
  await flush();
  q.requestParagraph('p1', 'A. B.', 2);
  q.requestParagraph('p2', 'C.', 1);
  tr.calls[0].resolve('1');
  await flush();
  tr.calls[1].resolve('2');
  await flush();
  tr.calls[2].resolve('3');
  await flush();
  assert.deepEqual(of('paragraph').map((e) => `${e.paraId}v${e.version}`), ['p1v1', 'p1v2', 'p2v1']);
});

test('翻訳エラーで詰まらず次へ進み、error を出す', async () => {
  const { tr, q, of } = setup();
  q.requestParagraph('p1', 'A.', 1);
  await flush();
  q.requestParagraph('p2', 'B.', 1);
  tr.calls[0].reject(new Error('失敗'));
  await flush();
  assert.equal(of('error').length, 1);
  assert.equal(of('error')[0].lane, 'translate');
  assert.equal(tr.calls.length, 2);
  tr.calls[1].resolve('ビー');
  await flush();
  assert.deepEqual(of('paragraph').map((e) => e.paraId), ['p2']);
});

test('translate が同期で例外を投げても詰まらない', async () => {
  const clock = createClock();
  let n = 0;
  const q = createTranslateQueue({
    translate: (text) => { n++; if (text === 'bad') throw new Error('同期エラー'); return Promise.resolve('訳' + text); },
    refine: null, now: clock.now, schedule: clock.schedule,
  });
  const got = [];
  const errors = [];
  q.on('paragraph', (e) => got.push(e.ja));
  q.on('error', (e) => errors.push(e));
  q.requestParagraph('p1', 'bad', 1);
  q.requestParagraph('p2', 'ok', 1);
  await flush();
  assert.equal(n, 2);
  assert.equal(errors.length, 1);
  assert.deepEqual(got, ['訳ok']);
});

test('返ってこない翻訳は時間切れでレーンを空ける', async () => {
  const { clock, tr, q, of } = setup({ options: { translateTimeoutMs: 5000 } });
  q.requestParagraph('p1', 'A.', 1);
  await flush();
  q.requestParagraph('p2', 'B.', 1);
  await clock.advance(5000);
  assert.equal(of('error').length, 1);
  assert.equal(tr.calls.length, 2);
  tr.calls[0].resolve('遅すぎ'); // 時間切れ後の結果は無視
  tr.calls[1].resolve('ビー');
  await flush();
  assert.deepEqual(of('paragraph').map((e) => e.ja), ['ビー']);
});

// ---------------- 仕上げ訳 ----------------
test('仕上げ訳は1段落1回・順番どおり、段落訳と並行して動く', async () => {
  const { tr, rf, q, of } = setup();
  q.requestRefine('p1', 'A.', []);
  q.requestRefine('p1', 'A.', []); // 2回目は無視
  q.requestRefine('p2', 'B.', [{ src: 'A.', ja: 'ア' }]);
  q.requestParagraph('p3', 'C.', 1);
  await flush();
  assert.equal(rf.calls.length, 1);
  assert.equal(tr.calls.length, 1); // 別レーンなので並行
  const [paraId, src, ctx, signal] = rf.calls[0].args;
  assert.equal(paraId, 'p1');
  assert.equal(src, 'A.');
  assert.deepEqual(ctx, []);
  assert.ok(signal instanceof AbortSignal);
  rf.calls[0].resolve('仕上げア');
  await flush();
  assert.equal(rf.calls.length, 2);
  assert.equal(rf.calls[1].args[0], 'p2');
  assert.deepEqual(rf.calls[1].args[2], [{ src: 'A.', ja: 'ア' }]);
  rf.calls[1].resolve('仕上げビ');
  await flush();
  assert.deepEqual(of('refined').map((e) => [e.paraId, e.ja]), [['p1', '仕上げア'], ['p2', '仕上げビ']]);
  assert.equal(rf.calls.length, 2);
});

test('仕上げ訳の待ちあふれで古いものを捨て refine-skipped(backlog) を出す', async () => {
  const { rf, q, of } = setup({ options: { maxRefineBacklog: 3 } });
  for (let i = 1; i <= 6; i++) q.requestRefine(`p${i}`, `S${i}.`, []);
  await flush();
  // p1 は実行中、待ちは p4 p5 p6 の3件。p2 p3 が捨てられる
  assert.deepEqual(of('refine-skipped').map((e) => [e.paraId, e.reason]), [['p2', 'backlog'], ['p3', 'backlog']]);
  assert.equal(of('stats').at(-1).refineQueued, 3);
  rf.calls[0].resolve('1');
  await flush();
  rf.calls[1].resolve('4');
  await flush();
  rf.calls[2].resolve('5');
  await flush();
  rf.calls[3].resolve('6');
  await flush();
  assert.deepEqual(rf.calls.map((c) => c.args[0]), ['p1', 'p4', 'p5', 'p6']);
  assert.equal(of('stats').at(-1).refineQueued, 0);
});

test('仕上げ訳は時間切れで abort して次へ進む', async () => {
  const { clock, rf, q, of } = setup({ options: { refineTimeoutMs: 20000 } });
  q.requestRefine('p1', 'A.', []);
  q.requestRefine('p2', 'B.', []);
  await flush();
  const signal = rf.calls[0].args[3];
  await clock.advance(19999);
  assert.equal(signal.aborted, false);
  await clock.advance(1);
  assert.equal(signal.aborted, true);
  assert.deepEqual(of('refine-skipped').map((e) => [e.paraId, e.reason]), [['p1', 'timeout']]);
  assert.equal(rf.calls.length, 2);
  rf.calls[0].resolve('遅い結果'); // 無視される
  rf.calls[1].resolve('ビ');
  await flush();
  assert.deepEqual(of('refined').map((e) => e.paraId), ['p2']);
  assert.equal(of('stats').at(-1).lastRefineMs, 0);
});

test('仕上げ訳が null・空文字なら invalid、例外なら error', async () => {
  const { rf, q, of } = setup();
  q.requestRefine('p1', 'A.', []);
  q.requestRefine('p2', 'B.', []);
  q.requestRefine('p3', 'C.', []);
  await flush();
  rf.calls[0].resolve(null);
  await flush();
  rf.calls[1].resolve('  ');
  await flush();
  rf.calls[2].reject(new Error('壊れた'));
  await flush();
  assert.deepEqual(of('refine-skipped').map((e) => [e.paraId, e.reason]),
    [['p1', 'invalid'], ['p2', 'invalid'], ['p3', 'error']]);
  assert.equal(of('error').filter((e) => e.lane === 'refine').length, 1);
  assert.equal(of('refined').length, 0);
});

test('lastRefineMs に仕上げ訳の所要時間が入る', async () => {
  const { clock, rf, q, of } = setup();
  q.requestRefine('p1', 'A.', []);
  await clock.advance(1234);
  rf.calls[0].resolve('ア');
  await flush();
  assert.equal(of('stats').at(-1).lastRefineMs, 1234);
});

test('refine が null でも段落訳まで動き、仕上げ訳は何もしない', async () => {
  const { clock, tr, q, of } = setup({ noRefine: true });
  q.requestParagraph('p1', 'A.', 1);
  q.requestRefine('p1', 'A.', []);
  await flush();
  tr.calls[0].resolve('ア');
  await clock.advance(30000);
  assert.deepEqual(of('paragraph').map((e) => e.ja), ['ア']);
  assert.equal(of('refined').length, 0);
  assert.equal(of('refine-skipped').length, 0);
  assert.equal(of('stats').at(-1).refineQueued, 0);
});

// ---------------- clear・stats・長時間 ----------------
test('clear() で待ちを捨て、実行中の仕上げ訳を abort し、タイマーを全部止める', async () => {
  const { clock, tr, rf, q, of } = setup();
  q.requestFlash('a');
  await flush();
  tr.calls[0].resolve('ア');
  await flush();
  q.requestFlash('b'); // 間隔待ちのタイマーが入る
  q.requestRefine('p1', 'A.', []);
  q.requestRefine('p2', 'B.', []);
  await flush();
  assert.ok(clock.pending() > 0);
  const signal = rf.calls[0].args[3];
  q.clear();
  assert.equal(signal.aborted, true);
  assert.equal(clock.pending(), 0);
  const s = of('stats').at(-1);
  assert.equal(s.translateQueued, 0);
  assert.equal(s.refineQueued, 0);
  assert.equal(s.translateBusy, false);
  assert.equal(s.refineBusy, false);
  // 古い結果は出さない
  rf.calls[0].resolve('古い');
  await clock.advance(60000);
  assert.equal(of('refined').length, 0);
  assert.equal(of('refine-skipped').length, 0);
  assert.equal(tr.calls.length, 1);
  // clear 後も同じ段落IDで仕上げ訳を受け付ける
  q.requestRefine('p1', 'A2.', []);
  await flush();
  assert.equal(rf.calls.length, 2);
});

test('clear() 中に実行中だった翻訳が返らなくても、次の依頼はすぐ動く', async () => {
  const { tr, q, of } = setup();
  q.requestParagraph('p1', 'A.', 1);
  await flush();
  q.clear();
  q.requestParagraph('p1', 'New.', 1);
  await flush();
  assert.equal(tr.calls.length, 2);
  tr.calls[0].resolve('古い');
  tr.calls[1].resolve('新しい');
  await flush();
  assert.deepEqual(of('paragraph').map((e) => e.ja), ['新しい']);
});

test("'stats' は状態が変わるたびに出て、同じ内容は繰り返さない", async () => {
  const { tr, q, of } = setup();
  q.requestParagraph('p1', 'A.', 1);
  const n1 = of('stats').length;
  assert.ok(n1 >= 1);
  assert.equal(of('stats').at(-1).translateBusy, true);
  q.setFlashEnabled(true); // 変化なし
  assert.equal(of('stats').length, n1);
  q.requestParagraph('p2', 'B.', 1);
  assert.equal(of('stats').at(-1).translateQueued, 1);
  tr.calls[0].resolve('ア');
  await flush();
  tr.calls[1].resolve('ビ');
  await flush();
  const last = of('stats').at(-1);
  assert.equal(last.translateQueued, 0);
  assert.equal(last.translateBusy, false);
  const keys = of('stats').map((e) => JSON.stringify(e));
  for (let i = 1; i < keys.length; i++) assert.notEqual(keys[i], keys[i - 1]);
});

test('受け手の例外でキューが止まらない', async () => {
  const clock = createClock();
  const q = createTranslateQueue({
    translate: async (t) => '訳' + t, refine: null, now: clock.now, schedule: clock.schedule,
  });
  const got = [];
  q.on('paragraph', () => { throw new Error('受け手のバグ'); });
  q.on('paragraph', (e) => got.push(e.paraId));
  const errors = [];
  q.on('error', (e) => errors.push(e.lane));
  q.requestParagraph('p1', 'A', 1);
  q.requestParagraph('p2', 'B', 1);
  await flush();
  assert.deepEqual(got, ['p1', 'p2']);
  assert.deepEqual(errors, ['listener', 'listener']);
});

test('2時間ぶんの依頼を流しても待ちとタイマーが積み上がらない', async () => {
  const clock = createClock();
  const q = createTranslateQueue({
    // 速報・段落訳は 400ms、仕上げ訳は 15秒（段落の間隔12秒より遅く、待ちがあふれる想定）
    translate: (t) => new Promise((r) => clock.schedule(() => r('訳' + t), 400)),
    refine: (id, src, ctx, signal) => new Promise((r) => {
      const c = clock.schedule(() => r('仕上げ' + id), 15000);
      signal.addEventListener('abort', c);
    }),
    now: clock.now,
    schedule: clock.schedule,
  });
  let maxT = 0;
  let maxR = 0;
  let refined = 0;
  let paragraphs = 0;
  q.on('stats', (s) => { maxT = Math.max(maxT, s.translateQueued); maxR = Math.max(maxR, s.refineQueued); });
  q.on('refined', () => refined++);
  let skipped = 0;
  q.on('refine-skipped', () => skipped++);
  q.on('paragraph', () => paragraphs++);
  let para = 0;
  const totalMs = 2 * 60 * 60 * 1000;
  for (let t = 0; t < totalMs; t += 500) {
    q.requestFlash('words at ' + t);
    if (t % 3000 === 0) q.requestParagraph(`p${para + 1}`, 'sentence ' + t, t);
    if (t % 12000 === 0) { para++; q.requestRefine(`p${para}`, 'para ' + para, []); }
    await clock.advance(500);
  }
  assert.ok(maxT <= 6, `速報・段落訳の待ち ${maxT}`);
  assert.ok(maxR <= 3, `仕上げ訳の待ち ${maxR}`);
  assert.ok(clock.pending() <= 4, `残りタイマー ${clock.pending()}`);
  assert.ok(paragraphs > 2000);
  assert.ok(refined > 0);
  assert.ok(skipped > 0); // 追いつかない分は捨てている
  q.clear();
  // 残るのは偽の translate 自身が持つタイマー（最大1つ）だけ
  assert.ok(clock.pending() <= 1);
});

// ---------------- 仕上げ訳の一時停止 ----------------
test('pauseRefine(true) のあいだは新しい仕上げ訳を始めず、実行中のものは続く', async () => {
  const { rf, q, of } = setup();
  q.requestRefine('p1', 'A.', []);
  await flush();
  assert.equal(rf.calls.length, 1);
  const signal = rf.calls[0].args[3];
  q.pauseRefine(true);
  q.requestRefine('p2', 'B.', []);
  q.requestRefine('p3', 'C.', []);
  await flush();
  assert.equal(signal.aborted, false); // 実行中は止めない
  rf.calls[0].resolve('仕上げア');
  await flush();
  assert.deepEqual(of('refined').map((e) => e.paraId), ['p1']);
  assert.equal(rf.calls.length, 1); // 一時停止中なので次を始めない
  assert.equal(of('stats').at(-1).refineQueued, 2);
  assert.equal(of('stats').at(-1).refineBusy, false);
});

test('pauseRefine(false) で待ちを順番どおり処理する', async () => {
  const { rf, q, of } = setup();
  q.pauseRefine(true);
  q.requestRefine('p1', 'A.', []);
  q.requestRefine('p2', 'B.', []);
  await flush();
  assert.equal(rf.calls.length, 0);
  q.pauseRefine(false);
  await flush();
  assert.equal(rf.calls.length, 1);
  assert.equal(rf.calls[0].args[0], 'p1');
  rf.calls[0].resolve('1');
  await flush();
  assert.equal(rf.calls[1].args[0], 'p2');
  rf.calls[1].resolve('2');
  await flush();
  assert.deepEqual(of('refined').map((e) => e.paraId), ['p1', 'p2']);
});

test('一時停止中も待ちあふれは古いものを捨てて refine-skipped(backlog)', async () => {
  const { rf, q, of } = setup({ options: { maxRefineBacklog: 3 } });
  q.pauseRefine(true);
  for (let i = 1; i <= 5; i++) q.requestRefine(`p${i}`, `S${i}.`, []);
  await flush();
  assert.equal(rf.calls.length, 0);
  assert.deepEqual(of('refine-skipped').map((e) => [e.paraId, e.reason]), [['p1', 'backlog'], ['p2', 'backlog']]);
  assert.equal(of('stats').at(-1).refineQueued, 3);
  q.pauseRefine(false);
  await flush();
  assert.equal(rf.calls[0].args[0], 'p3');
});

test('whenRefineIdle は実行中がなければすぐ解決し、実行中なら終わってから解決する', async () => {
  const { rf, q } = setup();
  let idle = false;
  await q.whenRefineIdle(); // なし: すぐ解決
  q.requestRefine('p1', 'A.', []);
  q.pauseRefine(true);
  q.whenRefineIdle().then(() => { idle = true; });
  await flush();
  assert.equal(idle, false);
  rf.calls[0].resolve('ア');
  await flush();
  assert.equal(idle, true);
});

test('whenRefineIdle は時間切れでも解決する', async () => {
  const { clock, q } = setup({ options: { refineTimeoutMs: 1000 } });
  q.requestRefine('p1', 'A.', []);
  let idle = false;
  q.whenRefineIdle().then(() => { idle = true; });
  await clock.advance(999);
  assert.equal(idle, false);
  await clock.advance(1);
  assert.equal(idle, true);
});

test('clear() で whenRefineIdle が解決し、一時停止も解除される', async () => {
  const { rf, q, of } = setup();
  q.requestRefine('p1', 'A.', []);
  q.pauseRefine(true);
  let idle = false;
  q.whenRefineIdle().then(() => { idle = true; });
  await flush();
  assert.equal(idle, false);
  q.clear();
  await flush();
  assert.equal(idle, true);
  assert.equal(of('stats').at(-1).refinePaused, false);
  q.requestRefine('p2', 'B.', []);
  await flush();
  assert.equal(rf.calls.length, 2);
  assert.equal(rf.calls[1].args[0], 'p2');
});

test("'stats' に refinePaused が入る", async () => {
  const { q, of } = setup();
  assert.equal(q.stats().refinePaused, false);
  q.pauseRefine(true);
  assert.equal(of('stats').at(-1).refinePaused, true);
  assert.equal(q.stats().refinePaused, true);
  const n = of('stats').length;
  q.pauseRefine(true); // 変化なし
  assert.equal(of('stats').length, n);
  q.pauseRefine(false);
  assert.equal(of('stats').at(-1).refinePaused, false);
});
