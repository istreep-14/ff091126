import { test } from 'node:test';
import assert from 'node:assert/strict';
import { since, siteMoved } from '../src/freshness.js';

const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();

test('since() rounds once, so there is no 8h 60m', () => {
  // It used to round the hours and the remainder independently, so each half
  // rounded up without telling the other.
  assert.equal(since(ago(8 * 60 + 59.7)), '9h 0m');
  assert.equal(since(ago(59.7)), '1h 0m');
  assert.equal(since(ago(1439.7)), '1d');
});

test('since() boundaries', () => {
  assert.equal(since(null), 'never');
  assert.equal(since(undefined), 'never');
  assert.equal(since(ago(0.4)), 'just now');
  assert.equal(since(ago(30)), '30m');
  assert.equal(since(ago(60)), '1h 0m');
  assert.equal(since(ago(90)), '1h 30m');
  assert.equal(since(ago(1440)), '1d');
  assert.equal(since(ago(4000)), '2d');
});

/**
 * Whether the SITE republished between our last two pulls.
 *
 * The distinction the whole ledger exists for, and the one it reported
 * nowhere until now: a source fetched a minute ago that is still serving this
 * morning's numbers is not fresh in any sense a lineup decision cares about.
 */
test('siteMoved compares the site\'s clock, not ours', () => {
  assert.equal(siteMoved({ sourceAt: 'b', prevSourceAt: 'a' }), true);
  assert.equal(siteMoved({ sourceAt: 'a', prevSourceAt: 'a' }), false);
});

test('siteMoved is null where there is no answer, never false', () => {
  // A source that publishes no recompute time has not "not moved" — we have
  // no idea, and saying "no" would be a claim we cannot make.
  assert.equal(siteMoved({ sourceAt: null, prevSourceAt: 'a' }), null);
  assert.equal(siteMoved({ sourceAt: 'a' }), null, 'only ever pulled once');
  assert.equal(siteMoved({ sourceAt: 'a', prevSourceAt: null }), null);
  assert.equal(siteMoved(null), null);
  assert.equal(siteMoved(undefined), null);
});
