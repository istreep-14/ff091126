import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { get, pool, NotModified } from './http.js';
import { DATA } from './config.js';
import { resolve as resolveWeek } from './week.js';
import { record } from './freshness.js';
import { writeJsonAtomic } from './jsonfile.js';

/**
 * Sleeper's own projections, every week of the season, keyed by Sleeper id.
 *
 * One request per week returns every player at once, in all three scoring
 * formats, so eighteen requests is the entire season — and unlike every other
 * projection source here, each row carries the site's OWN recompute time
 * (`last_modified`) rather than leaving us to guess from our clock.
 *
 * WHY THE WHOLE SEASON AND NOT JUST THIS WEEK
 *
 * Three of the sources in this stack (WinWithOdds, First Down, FanDuel)
 * publish a full-SEASON total and nothing weekly, so `enrich` derives
 * rest-of-season by subtracting points already scored. That leaves one number
 * covering thirteen remaining games, which cannot be compared against
 * anything weekly and cannot answer "what does this player do for me next
 * Sunday".
 *
 * A per-week curve fixes that, because the curve is the part those sources are
 * missing: it knows which week is a bye, who the opponent is, and that week 16
 * is worth more than week 10 for this particular player. Normalised into
 * per-week shares it carries no level information at all — only distribution —
 * so a rest-of-season total from any source can be spread across the remaining
 * schedule in that source's own magnitude. See src/weekshape.js.
 *
 * TWO CLOCKS, AGAIN, AND HERE THEY REALLY DIFFER
 *
 * Measured mid-week-1: the current week's projections had been recomputed four
 * minutes earlier, while weeks 2–18 had not moved since the previous night's
 * batch. They are one endpoint but two different refresh rates, so the current
 * week is fetched on a short TTL and the rest of the season on a long one, and
 * each week records its own `sourceAt`. Every week is also an ETag-conditional
 * GET, so re-asking costs one round trip when nothing has changed — which is
 * what makes polling the live week affordable at all.
 */

const BASE = 'https://api.sleeper.com/projections/nfl';

/** The regular season. Week 19+ answers 200 with no projections in it. */
export const LAST_WEEK = 18;

/** Position filter. Everything comes back in one response regardless of order. */
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

/** Scoring format -> the `pts_*` field that answers for it. */
export const SCORING_KEY = { PPR: 'ppr', HALF: 'half', STD: 'std' };

const dir = (season) => join(DATA, 'sleeper', String(season));
const filePath = (season) => join(dir(season), 'projections.json');

export function weekUrl(season, week) {
  const q = new URLSearchParams({ season_type: 'regular', order_by: 'pts_ppr' });
  for (const p of POSITIONS) q.append('position[]', p);
  return `${BASE}/${season}/${week}?${q}`;
}

const numOr = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * One week's board, slimmed.
 *
 * The raw response is ~2MB, most of it player biography repeated on every row
 * and stat lines nothing here reads. Only players with a projection are kept:
 * the response carries every player in the league, and an empty stat block is
 * not a projection of zero.
 */
export async function fetchWeek({ season, week, etag = null } = {}) {
  const url = weekUrl(season, week);
  let res;
  try {
    res = await get(url, { withHeaders: true, etag });
  } catch (err) {
    if (err instanceof NotModified) return { week, notModified: true };
    throw err;
  }
  const rows = Array.isArray(res.body) ? res.body : [];
  const players = [];
  let newest = 0;
  for (const r of rows) {
    const s = r?.stats;
    if (!s) continue;
    const ppr = numOr(s.pts_ppr), half = numOr(s.pts_half_ppr), std = numOr(s.pts_std);
    if (ppr == null && half == null && std == null) continue;
    const lm = Number(r.last_modified) || 0;
    if (lm > newest) newest = lm;
    players.push({
      sleeperId: String(r.player_id),
      name: [r.player?.first_name, r.player?.last_name].filter(Boolean).join(' ') || null,
      position: r.player?.position ?? null,
      team: r.team ?? r.player?.team ?? null,
      opponent: r.opponent ?? null,
      ppr, half, std,
      injuryStatus: r.player?.injury_status ?? null,
    });
  }
  return {
    week,
    players,
    // The site's own recompute time for this week, not ours.
    sourceAt: newest ? new Date(newest).toISOString() : null,
    // `date` is the projection date the site labels the board with.
    date: rows.find((r) => r?.date)?.date ?? null,
    etag: res.headers?.etag ?? null,
    notModified: false,
  };
}

/** The stored season file, or an empty shell. */
export function readProjections(season) {
  const p = filePath(season);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** One player's week -> points map, or null. */
export function playerWeeks(store, sleeperId) {
  if (!store || sleeperId == null) return null;
  return store.players?.[String(sleeperId)]?.w ?? null;
}

const empty = (season) => ({ season, fetchedAt: null, weeks: {}, players: {} });

/**
 * Fetch some or all weeks and merge them into the stored season.
 *
 * Merging rather than replacing is what lets the live week be re-pulled on its
 * own without discarding the other seventeen — which is the entire point of
 * separating the two refresh rates.
 */
export async function projSync({ season, week, weeks = null, log = console.log, force = false } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season, week });
  const store = readProjections(yr) || empty(yr);
  const want = (weeks && weeks.length ? weeks : Array.from({ length: LAST_WEEK }, (_, i) => i + 1))
    .map(Number).filter((w) => w >= 1 && w <= LAST_WEEK);

  log(`Sleeper projections — season ${yr}, week ${wk}; fetching ${want.length === 1 ? `week ${want[0]}` : `weeks ${want[0]}–${want[want.length - 1]}`}`);

  const ok = [], failed = [];
  let unchanged = 0;

  const results = await pool(want, async (w) => {
    try {
      return await fetchWeek({ season: yr, week: w, etag: force ? null : store.weeks?.[w]?.etag ?? null });
    } catch (err) {
      log(`  FAIL wk${String(w).padStart(2)} — ${err.message.split('\n')[0]}`);
      failed.push({ label: `week ${w}`, error: err.message });
      return null;
    }
  }, { concurrency: 2 });

  const now = new Date().toISOString();
  for (const r of results) {
    if (!r) continue;
    if (r.notModified) {
      unchanged++;
      // Move our clock forward; the site's stays where it was, because it is
      // the site telling us it has not moved.
      if (store.weeks[r.week]) store.weeks[r.week].fetchedAt = now;
      ok.push(`week ${r.week} (304)`);
      continue;
    }
    // A week being refetched replaces that week for every player, so the
    // previous values for it are cleared first — a player who dropped off the
    // board must not keep last night's number.
    for (const p of Object.values(store.players)) delete p.w[r.week];
    for (const p of r.players) {
      const rec = store.players[p.sleeperId] || { n: p.name, p: p.position, t: p.team, w: {} };
      rec.n = p.name ?? rec.n;
      rec.p = p.position ?? rec.p;
      rec.t = p.team ?? rec.t;
      rec.w[r.week] = { ppr: p.ppr, half: p.half, std: p.std, opp: p.opponent };
      store.players[p.sleeperId] = rec;
    }
    store.weeks[r.week] = { sourceAt: r.sourceAt, date: r.date, etag: r.etag, players: r.players.length, fetchedAt: now };
    ok.push(`week ${r.week} (${r.players.length})`);
    log(`  ok   wk${String(r.week).padStart(2)} ${String(r.players.length).padStart(4)} players` + (r.sourceAt ? `  site recomputed ${r.sourceAt}` : ''));
  }

  store.fetchedAt = now;
  store.lastWeek = LAST_WEEK;
  // Only a pull that covered every week resets the full-season clock.
  if (want.length === LAST_WEEK && !failed.length) store.fullSyncAt = now;
  mkdirSync(dir(yr), { recursive: true });
  writeJsonAtomic(filePath(yr), store, { indent: 0 });

  // The freshness ledger takes one clock per source, so the CURRENT week's is
  // the one recorded: it is the only week that moves inside a day, and it is
  // the number a live board is read against.
  const sourceAt = store.weeks[wk]?.sourceAt ?? newestSourceAt(store);
  const rep = record('sleeper-proj', {
    ok, failed, sourceAt, season: yr, week: wk,
    items: Object.keys(store.players).length,
    note: `${Object.keys(store.weeks).length} weeks stored${unchanged ? `, ${unchanged} unchanged upstream` : ''}`,
  });
  log(`  ${ok.length} ok, ${failed.length} failed${unchanged ? `, ${unchanged} already current (304)` : ''}`
    + ` — ${Object.keys(store.players).length} players across ${Object.keys(store.weeks).length} weeks`);
  log(`  -> ${filePath(yr)}`);
  return rep;
}

/** Only the live week. What a short-interval poll runs. */
export const projSyncWeek = ({ season, week, log } = {}) => {
  const { season: yr, week: wk } = resolveWeek({ season, week });
  return projSync({ season: yr, week: wk, weeks: [Math.max(1, wk)], log });
};

/** How long the rest of the season is trusted for. It moves once a night. */
const FULL_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Pull what is actually out of date: the live week every time, and the whole
 * season only when it is missing weeks or the nightly batch has since run.
 *
 * This is what the pipeline calls. Fetching all eighteen weeks to find out
 * that seventeen of them have not moved since last night is affordable but
 * pointless, and fetching only the live week forever means a schedule change
 * or a new player never lands.
 */
export async function projSyncAuto({ season, week, log = console.log } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season, week });
  const store = readProjections(yr);
  const complete = store && Array.from({ length: LAST_WEEK }, (_, i) => i + 1).every((w) => store.weeks?.[w]);
  const fullAge = store?.fullSyncAt ? Date.now() - new Date(store.fullSyncAt).getTime() : Infinity;
  const wantFull = !complete || fullAge >= FULL_MAX_AGE_MS;
  if (!wantFull) log(`  (rest of season pulled ${Math.round(fullAge / 60000)}m ago — live week only)`);
  return projSync({ season: yr, week: wk, weeks: wantFull ? null : [Math.max(1, wk)], log });
}

export function newestSourceAt(store) {
  const times = Object.values(store?.weeks || {}).map((w) => w?.sourceAt).filter(Boolean);
  return times.length ? times.sort().at(-1) : null;
}

/**
 * Per-week report of when the SITE last recomputed each week, newest first.
 * This is the answer to "is the number on my screen the current one".
 */
export function weekReport(season) {
  const store = readProjections(season);
  if (!store) return [];
  return Object.entries(store.weeks)
    .map(([week, w]) => ({ week: Number(week), sourceAt: w.sourceAt, fetchedAt: w.fetchedAt, date: w.date, players: w.players }))
    .sort((a, b) => a.week - b.week);
}
