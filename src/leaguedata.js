import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { get, pool } from './http.js';
import { DATA } from './config.js';
import { resolve as resolveWeek } from './week.js';
import { record, MAX_AGE_MIN } from './freshness.js';

/**
 * Standings, matchups and waiver state — none of which MyPlaybook exposes.
 *
 * Sleeper publishes all of it without auth, keyed by the league id MyPlaybook
 * already gives us. ESPN's read API (lm-api-reads.espn.com) is not reachable
 * from here and Yahoo requires OAuth, so those hosts report `supported: false`
 * rather than inventing numbers.
 *
 * Results are cached to data/leaguedetail/<season>-week-N.json and READ back by
 * default. The cache was previously written by a function nothing called and
 * read by nobody, while the dashboard re-fetched four Sleeper endpoints per
 * league on every single build — the most redundant traffic in the pipeline,
 * since `dashboard` runs immediately after `scrape` pulled the same leagues.
 */

const SLEEPER = 'https://api.sleeper.app/v1';

/**
 * Sleeper splits a score into a whole part and HUNDREDTHS, so 1102.06 arrives
 * as `{ fpts: 1102, fpts_decimal: 6 }`. Pasting the two together made that
 * 1102.6 — ten times the fraction, every time the hundredths were a single
 * digit, which is one week in ten and always in the column leagues are ranked
 * on.
 */
const sleeperPoints = (whole, hundredths) =>
  Math.round(((whole ?? 0) + (hundredths ?? 0) / 100) * 100) / 100;

export const supportsLeagueDetail = (host) => String(host).toLowerCase() === 'sleeper';

export const UNSUPPORTED_REASON = {
  espn: "ESPN's read API is not reachable from this environment.",
  yahoo: 'Yahoo requires an OAuth login per league.',
};

async function sleeperLeague(leagueId, week) {
  const [league, rosters, users, matchups] = await Promise.all([
    get(`${SLEEPER}/league/${leagueId}`),
    get(`${SLEEPER}/league/${leagueId}/rosters`),
    get(`${SLEEPER}/league/${leagueId}/users`),
    get(`${SLEEPER}/league/${leagueId}/matchups/${week}`).catch(() => []),
  ]);

  const userById = new Map((users || []).map((u) => [u.user_id, u]));
  const teamOf = (r) => {
    const u = userById.get(r.owner_id);
    return {
      rosterId: r.roster_id,
      ownerId: r.owner_id,
      owner: u?.display_name || null,
      name: u?.metadata?.team_name || u?.display_name || `Team ${r.roster_id}`,
      avatar: u?.avatar ? `https://sleepercdn.com/avatars/thumbs/${u.avatar}` : null,
    };
  };

  const standings = (rosters || [])
    .map((r) => {
      const s = r.settings || {};
      return {
        ...teamOf(r),
        wins: s.wins ?? 0,
        losses: s.losses ?? 0,
        ties: s.ties ?? 0,
        pointsFor: sleeperPoints(s.fpts, s.fpts_decimal),
        pointsAgainst: sleeperPoints(s.fpts_against, s.fpts_against_decimal),
        waiverPosition: s.waiver_position ?? null,
        waiverBudgetUsed: s.waiver_budget_used ?? 0,
        totalMoves: s.total_moves ?? 0,
        streak: s.streak ?? null,
        playerIds: r.players || [],
        starters: r.starters || [],
      };
    })
    .sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor);
  standings.forEach((t, i) => { t.rank = i + 1; });

  // Pair rosters that share a matchup_id.
  const byMatchup = new Map();
  for (const m of matchups || []) {
    if (m.matchup_id == null) continue;
    if (!byMatchup.has(m.matchup_id)) byMatchup.set(m.matchup_id, []);
    byMatchup.get(m.matchup_id).push(m);
  }
  const byRoster = new Map(standings.map((t) => [t.rosterId, t]));
  const pairings = [...byMatchup.entries()].map(([id, sides]) => ({
    matchupId: id,
    sides: sides.map((s) => ({
      rosterId: s.roster_id,
      team: byRoster.get(s.roster_id)?.name || `Team ${s.roster_id}`,
      avatar: byRoster.get(s.roster_id)?.avatar || null,
      points: s.points ?? 0,
      starters: s.starters || [],
      playerPoints: s.players_points || {},
    })),
  }));

  return {
    supported: true,
    source: 'sleeper',
    week,
    settings: {
      teams: league?.total_rosters ?? standings.length,
      waiverType: league?.settings?.waiver_type ?? null,
      waiverBudget: league?.settings?.waiver_budget ?? null,
      waiverClearDays: league?.settings?.waiver_clear_days ?? null,
      waiverDayOfWeek: league?.settings?.waiver_day_of_week ?? null,
      playoffTeams: league?.settings?.playoff_teams ?? null,
      playoffWeekStart: league?.settings?.playoff_week_start ?? null,
      status: league?.status ?? null,
      /**
       * Sleeper's own stat-by-stat scoring table.
       *
       * MyPlaybook returns a scoring system too, but its Sleeper reading is
       * incomplete — it lists no defensive stats at all for a league that
       * scores them. Where Sleeper publishes the table itself, that is the
       * authority, and League Setup shows both so a disagreement is visible
       * rather than averaged away.
       */
      scoring: league?.scoring_settings ?? null,
    },
    standings,
    matchups: pairings,
  };
}

const cachePath = (season, week) => join(DATA, 'leaguedetail', `${season}-week-${week}.json`);

function readCache(season, week) {
  const p = cachePath(season, week);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(season, week, leagues) {
  const dir = join(DATA, 'leaguedetail');
  mkdirSync(dir, { recursive: true });
  writeFileSync(cachePath(season, week), JSON.stringify({ season, week, fetchedAt: new Date().toISOString(), leagues }, null, 2));
}

/**
 * Detail for one league, from cache when it is fresh enough.
 *
 * `maxAgeMin` null means "always fetch" — the caller explicitly wants live
 * standings. Anything else reads the on-disk cache first.
 */
export async function fetchLeagueDetail(league, week, { season = null, maxAgeMin = undefined, cache = null } = {}) {
  const host = String(league.host || '').toLowerCase();
  if (!supportsLeagueDetail(host)) {
    return { supported: false, source: host, reason: UNSUPPORTED_REASON[host] || 'No public source for this host.' };
  }
  const limit = maxAgeMin === undefined ? MAX_AGE_MIN.leaguedetail : maxAgeMin;
  if (limit != null && season != null) {
    const c = cache ?? readCache(season, week);
    const hit = c?.leagues?.[league.key];
    const ageMin = c?.fetchedAt ? (Date.now() - new Date(c.fetchedAt).getTime()) / 60000 : Infinity;
    if (hit && ageMin < limit) return { ...hit, cached: true, cachedAgeMin: Math.round(ageMin) };
  }
  try {
    return await sleeperLeague(league.leagueId, week);
  } catch (err) {
    // A failed refresh falls back to whatever is on disk rather than blanking
    // the standings — stale numbers beat no numbers, as long as they say so.
    const stale = season != null ? (cache ?? readCache(season, week))?.leagues?.[league.key] : null;
    if (stale) return { ...stale, cached: true, stale: true };
    return { supported: false, source: host, reason: `Sleeper request failed: ${err.message}` };
  }
}

/** Read the whole cache file once, for a caller looping over many leagues. */
export const loadDetailCache = (season, week) => readCache(season, week);

/** Refresh every league's detail and write the cache the dashboard reads. */
export async function syncLeagueDetail({ season, week, leagues, log = console.log } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season, week });
  const out = {};
  const ok = [], failed = [];
  await pool(leagues, async (l) => {
    const detail = await fetchLeagueDetail(l, wk, { season: yr, maxAgeMin: null });
    out[l.key] = detail;
    if (detail.supported) ok.push(l.nickname || l.key);
    else if (supportsLeagueDetail(l.host)) failed.push({ label: l.nickname || l.key, error: detail.reason });
    log(`  ${detail.supported ? 'ok  ' : 'skip'} ${(l.host || '').padEnd(8)} ${(l.nickname || '').slice(0, 26).padEnd(28)} ${detail.supported ? `${detail.standings.length} teams, ${detail.matchups.length} matchups` : detail.reason}`);
  }, { concurrency: 2 });

  writeCache(yr, wk, out);
  record('leaguedetail', { ok, failed, sourceAt: null, season: yr, week: wk, items: ok.length });
  return out;
}

export { writeCache as writeDetailCache };
