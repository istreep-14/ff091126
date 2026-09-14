import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buzzDate, recentDates } from '../src/buzz.js';
import { heatOf } from '../src/signals.js';

/**
 * Yahoo counts its day boundary in US Eastern, so every date here is an
 * Eastern calendar date regardless of where the machine is.
 */

test('buzzDate uses the Eastern calendar day, not UTC', () => {
  // 03:00 UTC is still the previous evening in New York.
  assert.equal(buzzDate(new Date('2026-09-14T03:00:00Z')), '2026-09-13');
  assert.equal(buzzDate(new Date('2026-09-14T13:00:00Z')), '2026-09-14');
});

test('consecutive days, most recent first', () => {
  assert.deepEqual(
    recentDates(3, new Date('2026-09-14T16:00:00Z')),
    ['2026-09-14', '2026-09-13', '2026-09-12'],
  );
});

test('spring forward does not skip a day', () => {
  /*
   * US DST began Sunday 2026-03-08, so the Eastern day 2026-03-08 is 23 hours
   * long. Subtracting a fixed 24h from an instant on the 9th therefore lands
   * an hour EARLIER in the Eastern day than it should — and from inside the
   * first Eastern hour of the 9th that pushes it clean off the front of the
   * 8th and onto the 7th, dropping the 8th entirely.
   *
   * 04:30Z is 00:30 EDT on the 9th, which is that window. The bug needed the
   * hour to be right to show at all, which is most of why it survived.
   */
  const dates = recentDates(4, new Date('2026-03-09T04:30:00Z'));
  assert.deepEqual(dates, ['2026-03-09', '2026-03-08', '2026-03-07', '2026-03-06']);
});

test('fall back does not repeat a day', () => {
  // The other direction: 2026-11-01 is 25 hours long in Eastern.
  const dates = recentDates(4, new Date('2026-11-02T05:30:00Z')); // 00:30 EST on the 2nd
  assert.deepEqual(dates, ['2026-11-02', '2026-11-01', '2026-10-31', '2026-10-30']);
});

test('the walk crosses month and year boundaries', () => {
  assert.deepEqual(
    recentDates(3, new Date('2026-03-02T16:00:00Z')),
    ['2026-03-02', '2026-03-01', '2026-02-28'],
  );
  assert.deepEqual(
    recentDates(2, new Date('2027-01-01T16:00:00Z')),
    ['2027-01-01', '2026-12-31'],
  );
});

test('N days in means N consecutive days out, from any hour of any day', () => {
  /*
   * The property both DST failures break, swept across every hour of the year
   * rather than the handful someone thought to check — which is the only
   * reason the spring-forward case is visible at all, since it needs the
   * Eastern hour to be 00.
   */
  const day = 86_400_000;
  const start = Date.parse('2026-01-01T00:00:00Z');
  for (let h = 0; h < 366 * 24; h++) {
    const from = new Date(start + h * 3_600_000);
    const dates = recentDates(5, from);
    assert.equal(new Set(dates).size, 5, `duplicate from ${from.toISOString()}: ${dates}`);
    // And they must be genuinely consecutive, not merely distinct.
    for (let i = 1; i < dates.length; i++) {
      const gap = (Date.parse(dates[i - 1] + 'T12:00:00Z') - Date.parse(dates[i] + 'T12:00:00Z')) / day;
      assert.equal(gap, 1, `gap of ${gap} days from ${from.toISOString()}: ${dates}`);
    }
  }
});

// ------------------------------------------------------------------- heat

test('bottom of the board is a reading, not an absence', () => {
  // It read `Math.max(a ?? 0, b ?? 0) || null`, so a player who IS on a board
  // at its 0th percentile came back null — indistinguishable from a player on
  // neither board.
  assert.equal(heatOf(0, null), 0);
  assert.equal(heatOf(null, 0), 0);
  assert.equal(heatOf(0, 0), 0);
});

test('heat is the better of the two boards, never a blend', () => {
  assert.equal(heatOf(90, 10), 90);
  assert.equal(heatOf(10, 90), 90);
  assert.equal(heatOf(90, null), 90, 'absent from the other board costs nothing');
});

test('on neither board is null', () => {
  assert.equal(heatOf(null, null), null);
  assert.equal(heatOf(undefined, undefined), null);
});
