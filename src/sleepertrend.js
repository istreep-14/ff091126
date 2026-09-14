import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { get } from './http.js';
import { DATA } from './config.js';
import { loadSleeper } from './sleeper.js';
import { resolve as resolveWeek } from './week.js';
import { record } from './freshness.js';
import { pruneTrend } from './prune.js';

/**
 * Sleeper trending players — adds and drops across every Sleeper league, keyed
 * by Sleeper id, no auth.
 *
 * Yahoo's board is a DAY's transactions; this one is a rolling LOOKBACK. That
 * difference is the whole point of pulling both. Several windows are fetched at
 * once so the same counter can be differenced into a rate:
 *
 *   adds in the last 6h, versus (24h - 6h) spread over the prior 18h
 *
 * A player whose recent hourly rate is several times his trailing rate is being
 * added RIGHT NOW — a Thursday-night breakout, a Saturday injury report — and
 * that is the one worth burning a claim on before the rest of the league wakes
 * up. A flat rate is a player who has been slowly filling rosters all week and
 * will still be there tomorrow.
 */

const BASE = 'https://api.sleeper.app/v1/players/nfl/trending';

/** Short window first — `velocity` differences the first two. */
export const WINDOWS = [6, 24, 72];
const LIMIT = 200;

export async function fetchTrending({ type = 'add', hours = 24, limit = LIMIT } = {}) {
  const rows = await get(`${BASE}/${type}?lookback_hours=${hours}&limit=${limit}`);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Counts per window, per player, for one transaction type.
 * Returns Map<sleeperId, {h6, h24, h72, ...}>.
 */
async function counts(type, windows) {
  const idx = new Map();
  for (const h of windows) {
    for (const r of await fetchTrending({ type, hours: h })) {
      const id = String(r.player_id);
      const rec = idx.get(id) || {};
      rec[`h${h}`] = r.count ?? 0;
      idx.set(id, rec);
    }
  }
  return idx;
}

/**
 * Adds per hour in the short window against adds per hour before it.
 *
 * Null rather than a number when the trailing window has no room to measure —
 * a ratio against zero prior activity is infinity, which sorts a player with 12
 * adds above a player with 40,000. Those get flagged `fresh` instead.
 */
export function velocity(rec, short = WINDOWS[0], long = WINDOWS[1]) {
  const a = rec[`h${short}`], b = rec[`h${long}`];
  if (a == null) return { ratio: null, recentPerHr: null, priorPerHr: null, fresh: false };
  const recentPerHr = Number((a / short).toFixed(1));
  if (b == null || b <= a) return { ratio: null, recentPerHr, priorPerHr: null, fresh: true };
  const priorPerHr = (b - a) / (long - short);
  return {
    ratio: priorPerHr > 0 ? Number((recentPerHr / priorPerHr).toFixed(2)) : null,
    recentPerHr: Number(recentPerHr.toFixed(1)),
    priorPerHr: Number(priorPerHr.toFixed(1)),
    fresh: priorPerHr <= 0,
  };
}

export async function fetchAll({ windows = WINDOWS, withNames = true } = {}) {
  const adds = await counts('add', windows);
  const drops = await counts('drop', windows);
  const dict = withNames ? await loadSleeper() : { players: {} };

  const ids = new Set([...adds.keys(), ...drops.keys()]);
  const players = [];
  for (const id of ids) {
    const a = adds.get(id) || {}, d = drops.get(id) || {};
    const meta = dict.players[id] || {};
    const v = velocity(a);
    players.push({
      sleeperId: id,
      name: meta.name ?? null,
      position: meta.position ?? null,
      team: meta.team ?? null,
      injuryStatus: meta.injuryStatus ?? null,
      adds: a,
      drops: d,
      // Headline numbers: the longest window each is present in.
      addCount: a[`h${windows[1]}`] ?? a[`h${windows[0]}`] ?? null,
      dropCount: d[`h${windows[1]}`] ?? d[`h${windows[0]}`] ?? null,
      net: (a[`h${windows[1]}`] ?? 0) - (d[`h${windows[1]}`] ?? 0),
      ...v,
    });
  }
  players.sort((x, y) => (y.addCount ?? 0) - (x.addCount ?? 0));
  return { windows, fetchedAt: new Date().toISOString(), players };
}

const dir = (season) => join(DATA, 'trend', String(season));

export function readTrend(season) {
  const p = join(dir(season), 'latest.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

export async function trendSync({ season, week, log = console.log } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season, week });
  log(`Sleeper trending — season ${yr}, week ${wk}; windows ${WINDOWS.join('h/')}h`);
  const data = await fetchAll();
  mkdirSync(dir(yr), { recursive: true });
  const out = { season: yr, week: wk, ...data };
  writeFileSync(join(dir(yr), 'latest.json'), JSON.stringify(out, null, 2));
  // A timestamped copy too, so a later run can diff against an earlier pull
  // rather than trusting Sleeper's own window boundaries.
  writeFileSync(join(dir(yr), `${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(out));

  const rising = data.players.filter((p) => p.ratio != null).sort((a, b) => b.ratio - a.ratio).slice(0, 3);
  log(`  ok   ${data.players.length} players`);
  for (const p of data.players.slice(0, 3)) log(`       top add   ${(p.name || p.sleeperId).padEnd(24)} ${String(p.addCount).padStart(7)} adds/24h`);
  for (const p of rising) log(`       rising    ${(p.name || p.sleeperId).padEnd(24)} ${String(p.ratio).padStart(7)}x recent rate`);
  pruneTrend(yr);
  // `data.fetchedAt` is OUR clock. Sleeper's trending endpoint publishes no
  // recompute time — the counters are continuous, which is not the same thing
  // as a timestamp — so reporting ours as the site's would make the "site
  // said" column say what we already know from "fetched".
  record('trend', { ok: [`${data.players.length} players`], sourceAt: null,
    season: yr, week: wk, items: data.players.length, note: `windows ${WINDOWS.join('/')}h` });
  log(`  -> ${dir(yr)}`);
  return out;
}
