import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFiller, stripFillerEdges } from '../js/filler.js';

test('あいづち・感嘆だけの発言は true', () => {
  for (const t of [
    'Wow.', 'Oh.', 'Um.', 'Yeah.', 'Oh, wow.', 'Yeah yeah.', 'Um, uh...', 'Whoa!', 'Hmm?',
    'Uh-huh.', 'Mhm.', 'Oops.', 'Gosh.', 'Yep.', 'Yup.', 'Ooh!', 'Ha ha.', 'Hahaha!', 'Aha!',
    'Huh?', 'Erm...', 'Ahh.', 'mm', 'MMM', 'OH WOW',
  ]) {
    assert.equal(isFiller(t), true, t);
  }
});

test('伸ばした発音も true', () => {
  for (const t of ['Hmmmm.', 'Ummm...', 'Ahhhh!', 'Wooow.', 'Ohhh.', 'Hahahaha.', 'Uhhh,']) {
    assert.equal(isFiller(t), true, t);
  }
});

test('okay などはそれだけ（またはあいづちとの組み合わせ）の文なら true', () => {
  for (const t of [
    'Okay.', 'OK.', 'Ok!', 'Oh okay.', 'Right, right.', 'Alright.', 'All right.', 'Cool.',
    'Great!', 'Nice.', 'Oh, nice.', 'Mm-hmm.', 'Uh-oh.', 'Okay, okay, okay.', 'Wow, great.',
  ]) {
    assert.equal(isFiller(t), true, t);
  }
});

test('意味のある答え（yes・no・thank you・thanks）は false', () => {
  for (const t of ['Yes.', 'No.', 'Thank you.', 'Thanks.', 'Oh, yes.', 'Yeah, no.', 'Okay, thanks.', 'Oh, thank you.']) {
    assert.equal(isFiller(t), false, t);
  }
});

test('本文の中にあいづちがある文は false', () => {
  for (const t of [
    'Um, so the data shows a clear trend.',
    'Okay, let us move on.',
    'Right, the next slide.',
    'That is great.',
    'Oh, the results were nice.',
    'Wow, that is big.',
    'Easy wind.',
  ]) {
    assert.equal(isFiller(t), false, t);
  }
});

test('空・空白・句読点だけ・文字列以外は false', () => {
  for (const t of ['', '   ', '...', '?!', null, undefined]) {
    assert.equal(isFiller(t), false, String(t));
  }
});

test('語数の境界: 6語までは true、7語は false', () => {
  assert.equal(isFiller('Oh oh oh oh oh oh.'), true);
  assert.equal(isFiller('Oh oh oh oh oh oh oh.'), false);
  assert.equal(isFiller('Yeah, yeah, yeah, yeah, yeah, okay.'), true);
  assert.equal(isFiller('Yeah, yeah, yeah, yeah, yeah, okay, okay.'), false);
});

test('一覧に似た別の語は false', () => {
  for (const t of ['Ohio.', 'Right now.', 'Hm, maybe.', 'Okayish.', 'Erase.', 'Hamburger.']) {
    assert.equal(isFiller(t), false, t);
  }
});

test('Sure（「はい」の答え）は意味があるので訳す', () => {
  assert.equal(isFiller('Sure.'), false);
  assert.equal(isFiller('Yeah, sure.'), false);
});

test('stripFillerEdges: 文頭・文末のあいづちを取り除く（句読点なしの認識向け）', () => {
  assert.equal(stripFillerEdges("Yeah yeah that's in an all-comers population"), "That's in an all-comers population");
  assert.equal(stripFillerEdges("Um we're planning to enroll"), "We're planning to enroll");
  assert.equal(stripFillerEdges('Oh, wow. That is great.'), 'That is great.');
  assert.equal(stripFillerEdges('The data looked good, um.'), 'The data looked good.');
  assert.equal(stripFillerEdges('um um um um um um um um'), '');
});

test('stripFillerEdges: 意味のある語や本文の途中は変えない', () => {
  assert.equal(stripFillerEdges('Right now we have data.'), 'Right now we have data.');
  assert.equal(stripFillerEdges('Okay so the endpoint was met.'), 'Okay so the endpoint was met.');
  assert.equal(stripFillerEdges('The rate was, um, about 45 percent.'), 'The rate was, um, about 45 percent.');
  assert.equal(stripFillerEdges('Hello everyone.'), 'Hello everyone.');
});


test('「Oh my god」「You know」「I mean」などの感嘆・つなぎの言葉だけの文は訳さない', () => {
  for (const t of ['Oh my god.', 'Oh my gosh!', 'My goodness.', 'You know.', 'I mean.', 'Like, you know.', 'You know what I mean?', 'You know, I mean.']) {
    assert.equal(isFiller(t), true, t);
  }
  // 本文の中にある場合や、意味のある使い方は訳す
  for (const t of ['I like the data.', 'I mean the data is strong.', 'You know the answer.']) {
    assert.equal(isFiller(t), false, t);
  }
});

test('stripFillerEdges: 文頭・文末の感嘆と、カンマで区切られたつなぎの句を取り除く（like は残す）', () => {
  assert.equal(stripFillerEdges('Oh my god that is huge'), 'That is huge');
  assert.equal(stripFillerEdges('I mean, the data is strong'), 'The data is strong');
  assert.equal(stripFillerEdges('You know, the data is strong.'), 'The data is strong.');
  assert.equal(stripFillerEdges('The data is strong, you know.'), 'The data is strong.');
  assert.equal(stripFillerEdges('Like the previous trial we saw benefit'), 'Like the previous trial we saw benefit');
});

test('stripFillerEdges: 普通の文の中の you know / I mean / you see は削らない（意味が壊れないように）', () => {
  for (const t of ['You know the answer.', 'Do you know?', "That's what I mean.", 'Do you know what I mean', "Let's see what you know.", "Here's what you see", 'What do you know', 'I mean the data is strong']) {
    assert.equal(stripFillerEdges(t), t, t);
  }
});

