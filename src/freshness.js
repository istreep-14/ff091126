import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DATA } from './config.js';
import { writeJsonAtomic } from './jsonfile.js';

/**
 * One ledger for "when did each source last give us data, and how old is the
 * data itself".
 *
 * Six syncs were each writing their own `_sync-report.json` in a different
 * shape, and nothing read any of them. That is the wrong failure: the whole
 * point of `npm run all` re-fetching eleven sources is that some of them have
 * moved, and without a ledger there is no way to know which — so everything
 * re-fetches every time.
 *
 * Two different clocks are tracked, and conflating them is the mistake this
 * module exists to prevent:
 *
 *   fetchedAt    when WE pulled it. Always known.
 *   sourceAt     when the SITE says it last recomputed. Known for FantasyPros
 *                (last_updated_ts on every board), WinWithOdds (a
 *                rankings-updated-at tag), First Down (generatedAt) and via
 *                ETag for Sleeper. VegasEdge and FanDuel publish neither, so
 *                for those two `sourceAt` is null and age is ours alone.
 *
 * A source whose sourceAt has not moved since our last pull has nothing new,
 * no matter how long ago we pulled it. A source with no sourceAt can only be
 * governed by a local TTL, and says so rather than pretending to know.
 */

const LEDGER = join(DATA, 'freshness.json');

export function loadLedger() {
  if (!existsSync(LEDGER)) return { sources: {} };
  try {
    const j = JSON.parse(readFileSync(LEDGER, 'utf8'));
    return { sources: j.sources || {} };
  } catch {
    return { sources: {} };
  }
}

function save(ledger) {
  writeJsonAtomic(LEDGER, { updatedAt: new Date().toISOString(), ...ledger });
}

/**
 * Record a completed sync.
 *
 * `ok` / `failed` are lists of labels, the same shape for every source — the
 * old per-source schemas (`"Average/qb"` vs `"wk1 PPR QB"` vs `{date,players}`)
 * meant no consumer could ever be written once.
 */
export function record(source, { ok = [], failed = [], sourceAt = null, etag = null, items = null, note = null, season = null, week = null } = {}) {
  const ledger = loadLedger();
  const prev = ledger.sources[source] || {};
  ledger.sources[source] = {
    fetchedAt: new Date().toISOString(),
    sourceAt: sourceAt ?? null,
    // What the site said last time, so a skip decision can compare the two.
    prevSourceAt: prev.sourceAt ?? null,
    etag: etag ?? prev.etag ?? null,
    season, week,
    items,
    ok, failed,
    note,
  };
  save(ledger);
  return ledger.sources[source];
}

export const entry = (source) => loadLedger().sources[source] || null;

const MIN = 60_000;

/**
 * Default max ages, in minutes, per source.
 *
 * These are the intervals at which each source actually republishes, not
 * arbitrary round numbers:
 *
 *   trend    Sleeper's counter is continuous; 15 min is the point at which a
 *            6h-window rate has visibly moved.
 *   buzz     Yahoo recomputes a day's board through the day, in the morning.
 *   vegas    lines move all day on game days, slowly otherwise.
 *   fp       FantasyPros re-runs consensus a few times a day.
 *   wwo/fd/fanduel  once or twice a day in practice.
 *   sleeper-players / idmap  rosters, not results.
 */
export const MAX_AGE_MIN = {
  trend: 15,
  buzz: 60,
  vegas: 90,
  'vegas-dist': 180,
  fp: 180,
  wwo: 180,
  firstdown: 180,
  fanduel: 180,
  scrape: 60,
  leaguedetail: 30,
  // Scores move during games and not at all between them; 10 minutes is about
  // the resolution a live board is worth refreshing at.
  matchups: 10,
  'sleeper-players': 24 * 60,
  idmap: 12 * 60,
};

export const ageMinutes = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / MIN : null);

/**
 * Should this source be re-fetched?
 *
 * Returns `{ skip, age, reason }` — never a bare boolean, because "skipped
 * because it is 3 minutes old" and "skipped because you passed --skip" are
 * different things a log line has to be able to say.
 */
export function check(source, { maxAgeMin = null, force = false } = {}) {
  const e = entry(source);
  const limit = maxAgeMin ?? MAX_AGE_MIN[source] ?? 60;
  if (force) return { skip: false, age: ageMinutes(e?.fetchedAt), reason: 'forced' };
  if (!e?.fetchedAt) return { skip: false, age: null, reason: 'never fetched' };
  const age = ageMinutes(e.fetchedAt);
  if (age >= limit) return { skip: false, age, reason: `${Math.round(age)}m old, limit ${limit}m` };
  return { skip: true, age, reason: `${Math.round(age)}m old, under the ${limit}m limit` };
}

/** Human age: "4m", "2h 10m", "3d". */
export function since(iso) {
  const m = ageMinutes(iso);
  if (m == null) return 'never';
  if (m < 1) return 'just now';
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ${Math.round(m % 60)}m`;
  return `${Math.floor(h / 24)}d`;
}

/** Newest mtime under a directory tree, as a fallback age for pre-ledger data. */
export function newestFileAt(path) {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

/** The whole ledger, shaped for a status table or the dashboard payload. */
export function report() {
  const { sources } = loadLedger();
  return Object.entries(sources).map(([name, e]) => ({
    source: name,
    fetchedAt: e.fetchedAt,
    age: since(e.fetchedAt),
    ageMin: ageMinutes(e.fetchedAt),
    sourceAt: e.sourceAt,
    sourceAge: e.sourceAt ? since(e.sourceAt) : null,
    stale: (ageMinutes(e.fetchedAt) ?? Infinity) >= (MAX_AGE_MIN[name] ?? 60),
    items: e.items,
    ok: (e.ok || []).length,
    failed: (e.failed || []).length,
    note: e.note,
  })).sort((a, b) => (b.ageMin ?? 0) - (a.ageMin ?? 0));
}
