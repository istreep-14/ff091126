import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeFor, splitRos, weekFromRos, perWeekEstimates } from '../src/weekshape.js';

/**
 * The arithmetic that turns a season total into a per-week number.
 *
 * Nothing here talks to a network. The properties being asserted are the ones
 * the feature's honesty rests on: the shares carry no level, the split
 * reconciles with what it came from, and a bye is a bye rather than a zero
 * that happens to look like one.
 */

/** Weeks 1-4 with week 3 on bye, as the store holds them. */
const weeks = {
  1: { ppr: 10, half: 9, std: 8, opp: 'NO' },
  2: { ppr: 20, half: 18, std: 16, opp: 'BUF' },
  4: { ppr: 30, half: 27, std: 24, opp: 'GB' },
};

test('shares sum to 1 across the remaining weeks', () => {
  const s = shapeFor(weeks, { fromWeek: 1, throughWeek: 4 });
  const total = Object.values(s.share).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-12, `shares summed to ${total}`);
});

test('a missing week is a bye: named as one, and given no share', () => {
  const s = shapeFor(weeks, { fromWeek: 1, throughWeek: 4 });
  assert.deepEqual(s.byes, [3]);
  assert.equal(s.share[3], 0);
  assert.equal(s.points[3], 0);
  // Four weeks in the window, three of them games.
  assert.equal(s.weeks, 4);
  assert.equal(s.played, 3);
});

test('the split adds back up to the total it came from', () => {
  const s = shapeFor(weeks, { fromWeek: 1, throughWeek: 4 });
  const split = splitRos(300, s);
  const sum = Object.values(split).reduce((a, b) => a + b, 0);
  // Rounded to 2dp per week, so allow a cent of drift across four weeks.
  assert.ok(Math.abs(sum - 300) < 0.05, `split summed to ${sum}`);
  assert.equal(split[3], 0, 'the bye week takes nothing');
});

test('the shape carries distribution and no level', () => {
  // Doubling every projection must not change a single share: that is what
  // makes it safe to multiply another source's total by them.
  const doubled = Object.fromEntries(Object.entries(weeks)
    .map(([w, v]) => [w, { ...v, ppr: v.ppr * 2 }]));
  const a = shapeFor(weeks, { fromWeek: 1, throughWeek: 4 });
  const b = shapeFor(doubled, { fromWeek: 1, throughWeek: 4 });
  assert.deepEqual(a.share, b.share);
  assert.equal(b.total, a.total * 2, 'but the total is the level, and does change');
});

test('starting later renormalises over what is left', () => {
  const s = shapeFor(weeks, { fromWeek: 2, throughWeek: 4 });
  assert.equal(s.total, 50, 'week 1 is behind us and out of the denominator');
  assert.ok(Math.abs(s.share[2] - 20 / 50) < 1e-12);
  assert.equal(s.share[1], undefined, 'and has no share at all');
});

test('scoring format selects its own column', () => {
  assert.equal(shapeFor(weeks, { fromWeek: 1, scoring: 'PPR' }).total, 60);
  assert.equal(shapeFor(weeks, { fromWeek: 1, scoring: 'HALF' }).total, 54);
  assert.equal(shapeFor(weeks, { fromWeek: 1, scoring: 'STD' }).total, 48);
  // An unknown format falls back to PPR rather than producing NaN.
  assert.equal(shapeFor(weeks, { fromWeek: 1, scoring: 'nonsense' }).total, 60);
});

test('nothing to divide returns null, never a flat split', () => {
  // A flat split would look like knowledge and contain none.
  assert.equal(shapeFor(null, { fromWeek: 1 }), null);
  assert.equal(shapeFor({}, { fromWeek: 1 }), null);
  assert.equal(shapeFor({ 1: { ppr: 0 } }, { fromWeek: 1, throughWeek: 1 }), null);
  assert.equal(shapeFor(weeks, { fromWeek: 5, throughWeek: 4 }), null, 'empty window');
  assert.equal(shapeFor(weeks, {}), null, 'no starting week');
});

test('a week past the end of the season has no share', () => {
  const s = shapeFor(weeks, { fromWeek: 1, throughWeek: 4 });
  assert.equal(weekFromRos(300, s, 9), null);
  assert.equal(weekFromRos(300, null, 1), null);
  assert.equal(weekFromRos(null, s, 1), null);
});

test('string and number week keys both resolve', () => {
  // The store round-trips through JSON, so its keys are strings; callers hold
  // numbers. Both have to work or the lookup silently misses.
  const s = shapeFor({ '1': { ppr: 10 }, '2': { ppr: 30 } }, { fromWeek: 1, throughWeek: 2 });
  assert.equal(weekFromRos(100, s, 1), 25);
  assert.equal(weekFromRos(100, s, '1'), 25);
});

test('per-week estimates skip sources with no total rather than carrying null', () => {
  const s = shapeFor(weeks, { fromWeek: 1, throughWeek: 4 });
  const est = perWeekEstimates({ fp: 300, wwo: null, fd: 600, nope: undefined }, s, 2);
  // "this source has no ROS number" must stay distinguishable from "it says 0".
  assert.deepEqual(Object.keys(est.sources), ['fp', 'fd']);
  assert.equal(est.sources.fp, 100);
  assert.equal(est.sources.fd, 200);
  assert.equal(est.blended, 150, 'a plain mean of whatever answered');
  assert.equal(est.n, 2);
  assert.equal(est.bye, false);
});

test('a bye week estimates zero and says it is a bye', () => {
  const s = shapeFor(weeks, { fromWeek: 1, throughWeek: 4 });
  const est = perWeekEstimates({ fp: 300 }, s, 3);
  assert.equal(est.bye, true);
  assert.equal(est.sources.fp, 0);
});

test('no source with a total yields null, not a zero', () => {
  const s = shapeFor(weeks, { fromWeek: 1, throughWeek: 4 });
  assert.equal(perWeekEstimates({ fp: null }, s, 1), null);
  assert.equal(perWeekEstimates({}, s, 1), null);
  assert.equal(perWeekEstimates({ fp: 300 }, null, 1), null);
  assert.equal(perWeekEstimates({ fp: 300 }, s, 99), null, 'week outside the shape');
});
