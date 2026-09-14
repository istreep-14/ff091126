import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAdvanced } from '../src/mpbadvanced.js';

/**
 * The cache-HIT path only, which needs no network by definition — a miss
 * would go to MyPlaybook and is not something a test should do.
 *
 * Four requests per league went out on every dashboard build, and the build
 * runs at the end of every sync, so `sync --watch` turned that into a
 * standing load on endpoints that are rate-limited by a subscription plan.
 */

const league = { key: 'abc123', myTeamId: 4 };
const cached = {
  matchup: { ok: true, marker: 'from-cache' },
  standings: { ok: true },
  insights: { ok: true },
  startSit: { ok: true },
  inactive: false,
};
const cacheAged = (min) => ({
  season: 2026,
  week: 1,
  fetchedAt: new Date(Date.now() - min * 60_000).toISOString(),
  leagues: { abc123: cached },
});

test('a fresh cache entry is served without a request', async () => {
  const got = await fetchAdvanced(league, { season: 2026, week: 1, cache: cacheAged(1), maxAgeMin: 10 });
  assert.equal(got.cached, true);
  assert.equal(got.matchup.marker, 'from-cache');
  assert.equal(got.cachedAgeMin, 1);
});

test('the age is reported, so a stale-looking page can say why', async () => {
  const got = await fetchAdvanced(league, { season: 2026, week: 1, cache: cacheAged(7), maxAgeMin: 10 });
  assert.equal(got.cachedAgeMin, 7);
});

test('an entry past the TTL is not served from cache', async () => {
  // Asserted by what it does NOT return: a miss goes to the network, which a
  // test must not do, so the assertion is that it did not short-circuit.
  // `maxAgeMin: 0` makes every entry stale without any waiting.
  const got = await fetchAdvanced(league, { season: 2026, week: 1, cache: cacheAged(99), maxAgeMin: 0 })
    .catch(() => ({ attempted: true }));
  assert.notEqual(got.cachedAgeMin, 99, 'served the expired entry as if fresh');
});

test('no season or week means no cache lookup at all', async () => {
  // The cache is keyed by season and week; without them there is no file to
  // consult and the guard has to skip it rather than read a wrong one.
  const got = await fetchAdvanced(league, { cache: cacheAged(1), maxAgeMin: 10 })
    .catch(() => ({ attempted: true }));
  assert.notEqual(got.matchup?.marker, 'from-cache');
});
