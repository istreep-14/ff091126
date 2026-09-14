import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, currentSeason, currentWeek, kickoff } from '../src/week.js';

/**
 * Season and week both end up in file PATHS, so an argument that cannot be
 * honoured has to fail rather than resolve to something plausible.
 */

test('a pinned season and week pass through', () => {
  assert.deepEqual(resolve({ season: 2026, week: 5 }), { season: 2026, week: 5 });
  assert.deepEqual(resolve({ season: '2026', week: '5' }), { season: 2026, week: 5 });
});

test('week 0 is preseason and is allowed', () => {
  assert.deepEqual(resolve({ season: 2026, week: 0 }), { season: 2026, week: 0 });
  assert.deepEqual(resolve({ season: 2026, week: '0' }), { season: 2026, week: 0 });
});

test('an unparseable week throws instead of writing week-NaN', () => {
  // It used to resolve to NaN and write data/fp/2026/week-NaN/, which then
  // read back as an empty week forever.
  assert.throws(() => resolve({ season: 2026, week: 'fifteen' }), /Invalid week/);
  assert.throws(() => resolve({ season: 2026, week: '5x' }), /Invalid week/);
});

test('a week outside the season throws', () => {
  assert.throws(() => resolve({ season: 2026, week: 19 }), /Invalid week/);
  assert.throws(() => resolve({ season: 2026, week: -1 }), /Invalid week/);
  assert.throws(() => resolve({ season: 2026, week: 5.5 }), /Invalid week/);
});

test('an unparseable season throws instead of silently using this one', () => {
  // Asking for a season and getting a different one without being told is
  // worse than an error.
  assert.throws(() => resolve({ season: 'twentysix' }), /Invalid season/);
  assert.throws(() => resolve({ season: 26 }), /Invalid season/);
  assert.throws(() => resolve({ season: 0 }), /Invalid season/);
});

test('absent means infer, and the three ways of being absent agree', () => {
  const now = new Date('2026-09-14T12:00:00Z');
  for (const v of [undefined, null, '']) {
    const r = resolve({ season: v, week: v }, now);
    assert.equal(r.season, 2026);
    assert.equal(r.week, currentWeek(now, 2026));
  }
});

test('January belongs to the previous season', () => {
  assert.equal(currentSeason(new Date('2027-01-15T00:00:00Z')), 2026);
  assert.equal(currentSeason(new Date('2027-02-28T00:00:00Z')), 2026);
  assert.equal(currentSeason(new Date('2027-03-01T00:00:00Z')), 2027);
});

test('before kickoff is week 0, and week 1 starts on kickoff Thursday', () => {
  const ko = kickoff(2026);
  assert.equal(currentWeek(new Date(ko.getTime() - 1), 2026), 0);
  assert.equal(currentWeek(ko, 2026), 1);
});

test('the week rolls over on Tuesday, not mid-weekend', () => {
  const ko = kickoff(2026).getTime();
  const day = 86_400_000;
  // Thu (kickoff) through Mon are all week 1; Tuesday is week 2.
  for (const d of [0, 1, 2, 3, 4]) {
    assert.equal(currentWeek(new Date(ko + d * day), 2026), 1, `+${d}d should still be week 1`);
  }
  assert.equal(currentWeek(new Date(ko + 5 * day), 2026), 2, 'Tuesday rolls over');
});

test('the week never runs past the end of the season', () => {
  const far = new Date(kickoff(2026).getTime() + 400 * 86_400_000);
  assert.equal(currentWeek(far, 2026), 18);
});
