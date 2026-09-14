import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { get, pool } from './http.js';
import { DATA } from './config.js';
import { resolve as resolveWeek } from './week.js';
import { record } from './freshness.js';
import { writeJsonAtomic } from './jsonfile.js';
import { LAST_WEEK } from './sleeperproj.js';
import { normTeam } from './teams.js';

/**
 * The NFL regular-season schedule, scraped from ESPN's public schedule page.
 *
 * Sleeper's projection rows carry an opponent, but that opponent is whatever
 * Sleeper last wrote onto that week — and Sleeper's weeks 2–18 move on a
 * nightly batch. A teammate landing on IR, a game flexed, a team on a bye that
 * Sleeper has not yet marked as one: none of those should have to wait on
 * Sleeper's curve to be visible.
 *
 * ESPN publishes the whole slate as JSON behind `cdn.espn.com/core/nfl/schedule`
 * (the HTML page's own XHR). One request per week, 16 games, every team either
 * has an opponent or is on bye. No auth.
 */

const dir = (season) => join(DATA, 'schedule', String(season));
const filePath = (season) => join(dir(season), 'nfl.json');

const scheduleUrl = (season, week) =>
  `https://cdn.espn.com/core/nfl/schedule?xhr=1&year=${season}&seasontype=2&week=${week}`;

const NFL_TEAMS = [
  'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE',
  'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'JAC', 'KC',
  'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG',
  'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS',
];

export function readSchedule(season) {
  const p = filePath(season);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function teamWeek(store, team, week) {
  if (!store || team == null || week == null) return null;
  const t = store.teams?.[normTeam(team)];
  if (!t) return null;
  if (t.bye === Number(week)) return { bye: true, opp: null, home: null, date: null };
  return t.weeks?.[String(week)] || t.weeks?.[week] || null;
}

export function byeWeek(store, team) {
  return store?.teams?.[normTeam(team)]?.bye ?? null;
}

/** Parse one ESPN schedule XHR payload into per-team rows. */
export function parseEspnSchedule(json, { week } = {}) {
  const days = json?.content?.schedule || {};
  const games = [];
  for (const day of Object.values(days)) {
    for (const g of day?.games || []) {
      const comp = g.competitions?.[0] || g;
      const competitors = comp.competitors || [];
      const home = competitors.find((c) => c.homeAway === 'home');
      const away = competitors.find((c) => c.homeAway === 'away');
      if (!home || !away) continue;
      const ht = normTeam(home.team?.abbreviation);
      const at = normTeam(away.team?.abbreviation);
      if (!ht || !at) continue;
      const date = g.date || comp.date || comp.startDate || null;
      games.push({
        id: String(g.id || comp.id || ''),
        week: Number(week) || Number(g.week?.number) || null,
        date,
        home: ht,
        away: at,
        name: g.shortName || g.name || `${at} @ ${ht}`,
        status: g.status?.type?.name || comp.status?.type?.name || null,
        final: !!(g.status?.type?.completed || comp.status?.type?.completed),
      });
    }
  }
  return games;
}

function emptyTeams() {
  const teams = {};
  for (const t of NFL_TEAMS) teams[t] = { bye: null, weeks: {} };
  return teams;
}

export async function fetchWeekSchedule({ season, week } = {}) {
  const json = await get(scheduleUrl(season, week), {
    headers: { Accept: 'application/json', Referer: 'https://www.espn.com/nfl/schedule' },
  });
  return parseEspnSchedule(json, { week });
}

export async function scheduleSync({ season, week, weeks = null, log = console.log } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season, week });
  const want = (weeks && weeks.length ? weeks : Array.from({ length: LAST_WEEK }, (_, i) => i + 1))
    .map(Number).filter((w) => w >= 1 && w <= LAST_WEEK);

  log(`NFL schedule — season ${yr}; fetching ${want.length === 1 ? `week ${want[0]}` : `weeks ${want[0]}–${want[want.length - 1]}`}`);

  const store = readSchedule(yr) || { season: yr, fetchedAt: null, weeks: {}, teams: emptyTeams() };
  if (!store.teams || Object.keys(store.teams).length < 32) store.teams = { ...emptyTeams(), ...(store.teams || {}) };

  const ok = [], failed = [];
  const results = await pool(want, async (w) => {
    try {
      const games = await fetchWeekSchedule({ season: yr, week: w });
      return { week: w, games };
    } catch (err) {
      log(`  FAIL wk${String(w).padStart(2)} — ${err.message.split('\n')[0]}`);
      failed.push({ label: `week ${w}`, error: err.message });
      return null;
    }
  }, { concurrency: 3 });

  const now = new Date().toISOString();
  for (const r of results) {
    if (!r) continue;
    store.weeks[r.week] = { fetchedAt: now, games: r.games.length };
    const playing = new Set();
    for (const g of r.games) {
      playing.add(g.home); playing.add(g.away);
      const put = (team, opp, home) => {
        const rec = store.teams[team] || { bye: null, weeks: {} };
        rec.weeks[r.week] = { opp, home, date: g.date, final: !!g.final, name: g.name };
        store.teams[team] = rec;
      };
      put(g.home, g.away, true);
      put(g.away, g.home, false);
    }
    for (const t of NFL_TEAMS) {
      if (playing.has(t)) continue;
      const rec = store.teams[t] || { bye: null, weeks: {} };
      rec.bye = r.week;
      delete rec.weeks[r.week];
      store.teams[t] = rec;
    }
    ok.push(`week ${r.week} (${r.games.length} games)`);
    log(`  ok   wk${String(r.week).padStart(2)} ${String(r.games.length).padStart(2)} games`);
  }

  store.fetchedAt = now;
  store.season = yr;
  mkdirSync(dir(yr), { recursive: true });
  writeJsonAtomic(filePath(yr), store, { indent: 0 });

  const rep = record('schedule', {
    ok, failed, sourceAt: null, season: yr, week: wk,
    items: Object.keys(store.teams).length,
    note: `${Object.keys(store.weeks).length} weeks stored`,
  });
  log(`  ${ok.length} ok, ${failed.length} failed — ${Object.keys(store.teams).length} teams -> ${filePath(yr)}`);
  return rep;
}
