import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA } from './config.js';
import { pool } from './http.js';
import { getMatchup } from './mpbadvanced.js';
import { resolve as resolveWeek } from './week.js';
import { record } from './freshness.js';

/**
 * Every matchup in a league, live, for every host.
 *
 * MyPlaybook's matchup endpoint takes a `teamId`, and it answers for ANY team
 * in the league — not just yours. That one fact is what makes a league-wide
 * live board possible on ESPN and Yahoo, where no other reachable source
 * returns scores at all: ask once per team and you have the whole week.
 *
 * Each pairing comes back twice, once from either side, so teams already seen
 * in a fetched matchup are skipped. A 12-team league costs 6 requests, not 12.
 *
 * WHY THIS IS ALSO THE POINTS-FOR LEDGER
 *
 * MyPlaybook's projected-standings endpoint gives records and playoff odds for
 * every host but no points for or against, and its matchup endpoint has no week
 * parameter — it only ever answers for the current week. So season totals
 * cannot be fetched for ESPN or Yahoo at all; they can only be ACCUMULATED.
 * Each sync writes that week's final scores to data/scores/, and the season
 * total is the sum of the weeks on disk.
 *
 * That means the totals are only as complete as your sync history, and a week
 * you never synced is simply missing rather than silently counted as zero —
 * `weeksCounted` is carried alongside every total so the UI can say so. Sleeper
 * publishes real season totals, and those are preferred wherever they exist.
 */

const dir = (season) => join(DATA, 'scores', String(season));
const filePath = (season, week) => join(dir(season), `week-${week}.json`);

const sideOf = (t) => t && ({
  teamId: t.id ?? null,
  name: t.name || null,
  logo: t.logo || null,
  color: t.color || null,
  points: t.points ?? 0,
  projected: t.projected ?? null,
  isPreGame: !!t.isPreGame,
  minutesLeft: t.minutesLeft ?? null,
  starters: (t.starters || []).length,
});

/**
 * One league's full slate. `teamIds` is every team; the order decides which
 * side of a pairing is fetched, nothing else.
 */
export async function fetchLeagueMatchups(league, { log = null } = {}) {
  const ids = (league.teams || []).map((t) => t.teamId).filter((x) => x != null);
  if (!ids.length) return { ok: false, error: 'no teams' };

  const seen = new Set();
  const pairs = [];
  let failed = 0;

  // Sequential on purpose: each result tells us which ids we no longer need to
  // ask about, and a parallel fan-out would throw that saving away.
  for (const id of ids) {
    if (seen.has(String(id))) continue;
    let r;
    try {
      r = await getMatchup(league.key, { teamId: id });
    } catch (err) {
      failed++;
      log?.(`    FAIL team ${id} — ${err.message.split('\n')[0]}`);
      seen.add(String(id));
      continue;
    }
    if (!r.ok) {
      // An inactive league answers for no team, so stop rather than ask N times.
      if (r.inactive) return { ok: false, inactive: true, error: r.error };
      failed++;
      seen.add(String(id));
      continue;
    }
    const a = sideOf(r.team1), b = sideOf(r.team2);
    [a, b].forEach((s) => { if (s?.teamId != null) seen.add(String(s.teamId)); });
    seen.add(String(id));
    pairs.push({
      status: r.status || null,
      isPreGame: !!r.isPreGame,
      live: !!r.liveUpdates,
      minutesLeft: r.minutesLeft ?? null,
      winProbability: r.winProbability ?? null,
      result: r.result || null,
      sides: [a, b].filter(Boolean),
    });
  }

  return { ok: true, failed, matchups: dedupe(pairs) };
}

/**
 * Collapse pairings that came back more than once.
 *
 * The skip-what-you-have-seen loop assumes the endpoint answers consistently:
 * ask about team 4 and you get 4's pairing. A 16-team ESPN league does not
 * always oblige — asking about one team occasionally returns a pairing that
 * team is not in, so a team already accounted for gets fetched again and the
 * board grows a seventeenth side for sixteen teams.
 *
 * Deduping on the pairing itself rather than on the request is the fix that
 * does not depend on upstream behaving: two sides sorted make a stable key, and
 * a one-sided card is dropped outright if that team also appears in a real
 * pairing (it is the same bye, reported twice).
 */
function dedupe(pairs) {
  const byKey = new Map();
  for (const m of pairs) {
    const ids = m.sides.map((s) => String(s.teamId ?? s.name)).sort();
    const key = ids.join('|');
    const prev = byKey.get(key);
    // Keep the copy with more sides, then the one further along.
    if (!prev || m.sides.length > prev.sides.length
      || (m.sides.length === prev.sides.length && (m.minutesLeft ?? 1e9) < (prev.minutesLeft ?? 1e9))) {
      byKey.set(key, m);
    }
  }
  const kept = [...byKey.values()];
  const paired = new Set(kept.filter((m) => m.sides.length > 1).flatMap((m) => m.sides.map((s) => String(s.teamId ?? s.name))));
  return kept.filter((m) => m.sides.length > 1 || !paired.has(String(m.sides[0]?.teamId ?? m.sides[0]?.name)));
}

/** Read one stored week. */
export function readWeek(season, week) {
  const p = filePath(season, week);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

/** Every week on disk for a season, ascending. */
export function storedWeeks(season) {
  if (!existsSync(dir(season))) return [];
  return readdirSync(dir(season))
    .map((f) => f.match(/^week-(\d+)\.json$/)?.[1])
    .filter(Boolean).map(Number).sort((a, b) => a - b);
}

/**
 * Season points for and against per team, summed over the weeks on disk.
 *
 * Returns Map<leagueKey, Map<teamId, {pointsFor, pointsAgainst, weeksCounted,
 * wins, losses, ties}>>. A bye (a matchup with one side) contributes points
 * for and no opponent, which is what it is — not a zero against.
 */
export function seasonTotals(season, { throughWeek = null } = {}) {
  const out = new Map();
  for (const wk of storedWeeks(season)) {
    if (throughWeek != null && wk > throughWeek) continue;
    const data = readWeek(season, wk);
    for (const [key, lg] of Object.entries(data?.leagues || {})) {
      if (!lg?.ok) continue;
      /**
       * A week counts for a league only when EVERY matchup in it is final.
       *
       * Counting matchup by matchup made the column incoherent: on a Sunday
       * with two games finished, two teams carried a points-for and the other
       * ten carried nothing, in the same table, sorted against each other. A
       * partial week is not a small amount of season — it is not a season yet.
       * The live week gets its own column instead.
       */
      if (!(lg.matchups || []).length || !lg.matchups.every(isFinal)) continue;
      if (!out.has(key)) out.set(key, new Map());
      const byTeam = out.get(key);
      for (const m of lg.matchups || []) {
        const [a, b] = m.sides;
        const add = (self, opp) => {
          if (!self || self.teamId == null) return;
          const k = String(self.teamId);
          const cur = byTeam.get(k) || { pointsFor: 0, pointsAgainst: 0, weeksCounted: 0, wins: 0, losses: 0, ties: 0 };
          cur.pointsFor += self.points || 0;
          cur.weeksCounted++;
          if (opp) {
            cur.pointsAgainst += opp.points || 0;
            if ((self.points || 0) > (opp.points || 0)) cur.wins++;
            else if ((self.points || 0) < (opp.points || 0)) cur.losses++;
            else cur.ties++;
          }
          byTeam.set(k, cur);
        };
        add(a, b); add(b, a);
      }
    }
  }
  return out;
}

/**
 * Which weeks are complete for each league — the denominator behind every
 * accumulated total, so the UI can name it instead of implying a full season.
 */
export function completeWeeks(season, { throughWeek = null } = {}) {
  const out = new Map();
  for (const wk of storedWeeks(season)) {
    if (throughWeek != null && wk > throughWeek) continue;
    const data = readWeek(season, wk);
    for (const [key, lg] of Object.entries(data?.leagues || {})) {
      if (!lg?.ok || !(lg.matchups || []).length) continue;
      if (!lg.matchups.every(isFinal)) continue;
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(wk);
    }
  }
  return out;
}

/**
 * A matchup is final when the host says so, or when the clock has run out.
 *
 * MyPlaybook's own word is "finished"; `liveUpdates` stays true even after, so
 * that flag says the league is being polled, not that the game is running.
 */
export const isFinal = (m) =>
  /final|finish|complete/i.test(String(m.status || '')) || (!m.isPreGame && m.minutesLeft === 0);

export async function matchupsSync({ season, week, leagues, log = console.log } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season, week });
  log(`League matchups — season ${yr}, week ${wk}, ${leagues.length} league(s)`);
  const out = {};
  const ok = [], failed = [];

  await pool(leagues, async (l) => {
    const r = await fetchLeagueMatchups(l, { log });
    out[l.key] = r;
    if (r.ok) {
      const live = r.matchups.filter((m) => m.live && !isFinal(m)).length;
      const done = r.matchups.filter(isFinal).length;
      log(`  ok   ${(l.host || '').padEnd(8)} ${(l.nickname || '').slice(0, 24).padEnd(25)} ${String(r.matchups.length).padStart(2)} matchups${done ? `, ${done} final` : ''}${live ? `, ${live} live` : ''}`);
      ok.push(l.nickname || l.key);
    } else {
      log(`  ${r.inactive ? 'skip' : 'FAIL'} ${(l.host || '').padEnd(8)} ${(l.nickname || '').slice(0, 24).padEnd(25)} ${r.error}`);
      if (!r.inactive) failed.push({ label: l.nickname || l.key, error: r.error });
    }
  }, { concurrency: 2 });

  mkdirSync(dir(yr), { recursive: true });
  writeFileSync(filePath(yr, wk), JSON.stringify({ season: yr, week: wk, fetchedAt: new Date().toISOString(), leagues: out }, null, 2));

  const weeks = storedWeeks(yr);
  record('matchups', { ok, failed, sourceAt: null, season: yr, week: wk,
    items: ok.length, note: `weeks on disk: ${weeks.join(', ') || 'none'}` });
  log(`  -> ${filePath(yr, wk)} (season history: week ${weeks.join(', ')})`);
  return out;
}
