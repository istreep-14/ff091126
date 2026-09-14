import { get } from './http.js';

/**
 * MyPlaybook "advanced" endpoints — matchups, projected standings, start/sit
 * accuracy and team insights.
 *
 * These are gated differently from the roster/settings endpoints: they only
 * answer for a league that is ACTIVE on FantasyPros. The account has an
 * `enabledLeagueCap` (1 on the current plan), so at any moment most leagues
 * return:
 *
 *   "This league is set as inactive on FantasyPros. Please activate the league
 *    or upgrade your subscription plan to increase your active league limit."
 *
 * That is a subscription limit, not a scraping failure — `inactive: true` is
 * reported so the UI can say so precisely.
 */

const MPB = 'https://mpbnfl.fantasypros.com';
const PROJ = 'https://projected-standings.fantasypros.com';

const INACTIVE = /set as inactive on FantasyPros/i;

function classify(data) {
  if (data && typeof data === 'object' && data.error) {
    return { ok: false, inactive: INACTIVE.test(data.error), error: data.error };
  }
  return { ok: true };
}

/** Live/projected matchup with full starter and bench slots. */
export async function getMatchup(key, { teamId } = {}) {
  const qs = new URLSearchParams({ matchup: '', key, from: 'web' });
  if (teamId != null) qs.set('teamId', String(teamId));
  const data = await get(`${MPB}/json/matchup?${qs.toString()}`);
  const c = classify(data);
  if (!c.ok) return c;
  if (!data.matchup) return { ok: false, inactive: false, error: 'No matchup in response' };
  return { ok: true, ...normalizeMatchup(data) };
}

/**
 * One lineup slot, kept whole.
 *
 * This is the single normalizer for a matchup slot — matchups.js stores what it
 * returns and the dashboard renders it, so a field dropped here is a field
 * nothing downstream can recover.
 *
 * `points` is the LEAGUE's own number: MyPlaybook applies the league's scoring
 * table (the settings endpoint returns that table too — see normalize.js), so a
 * Sleeper league taking -2 for an interception is already counted. It used to be dropped, and the
 * page read actuals out of FantasyPros' generic PPR file instead — which is why
 * a quarterback read high by exactly the interceptions he threw. It is also the
 * only per-player actual available for ESPN and Yahoo at all.
 *
 * A player whose game has not kicked off has NO `points` and NO `new_proj` —
 * the fields are absent rather than zero, and null is carried through so the UI
 * can print "—" instead of a 0.0 that reads like a bad performance.
 */
const slimSlot = (p, idx) => ({
  slot: p.position || null,          // lineup slot: QB, RB, WR/RB/TE, DST…
  pos: p.real_position || null,      // the player's actual position
  fpId: p.fpId ?? null,
  name: p.full || p.shortName || null,
  short: p.shortName || null,
  team: p.real_team || null,
  opp: p.opponent || null,
  ecr: p.ecr || null,
  proj: p.new_proj ?? p.original_proj ?? null,   // live-adjusted
  proj0: p.original_proj ?? null,                // pre-game
  pts: p.points ?? null,                         // league-scored actual
  game: p.gameStatus || null,        // "Final (W) 33-27", "Not Started"
  score: p.scoreInfo || null,        // "CIN 33 - TB 27"
  clock: p.clockInfo || null,        // "Final", "Q3 04:12"
  time: p.gameTime || null,
  pre: !!p.isPreGame,
  over: !!p.isGameOver,
  min: p.minutesLeft ?? null,
  inj: p.injuryStatus || null,
  sos: p.sos ?? null,
  order: idx,
});

function normalizeSide(t) {
  if (!t) return null;
  return {
    id: t.id ?? null,
    name: t.name || null,
    logo: t.logo || null,
    color: t.background || null,
    points: t.points ?? 0,
    projected: t.new_proj ?? t.original_proj ?? null,
    originalProjected: t.original_proj ?? null,
    result: t.result || null,
    status: t.status || null,
    isPreGame: !!t.isPreGame,
    minutesLeft: t.totalMinutesLeft ?? null,
    starters: (t.starters || []).map(slimSlot),
    bench: (t.bench || []).map(slimSlot),
  };
}

function normalizeMatchup(d) {
  const m = d.matchup;
  return {
    league: { name: d.nickname || d.name, host: d.host, key: d.key, myTeamId: d.teamId },
    winProbability: m.win_probability ?? null,
    result: m.result || null,
    status: m.status || null,
    isPreGame: !!m.isPreGame,
    minutesLeft: m.totalMinutesLeft ?? null,
    liveUpdates: !!m.doLiveUpdates,
    team1: normalizeSide(m.team1),
    team2: normalizeSide(m.team2),
  };
}

/** Projected final standings with playoff odds. */
export async function getProjectedStandings(key, { fast = true } = {}) {
  const data = await get(`${PROJ}/api/getProjectedStandings?fast=${fast}&key=${encodeURIComponent(key)}`);
  const c = classify(data);
  if (!c.ok) return c;
  const rows = (data.standings || []).map((r) => ({
    teamId: r.teamId,
    teamName: r.teamName,
    isUser: !!r.isUser,
    rankCurrent: r.rank_current ?? null,
    rankProjected: r.rank_proj ?? null,
    winsCurrent: r.wins_current ?? 0,
    lossesCurrent: r.losses_current ?? 0,
    tiesCurrent: r.ties_current ?? 0,
    winsProjected: r.wins_proj ?? null,
    lossesProjected: r.losses_proj ?? null,
    tiesProjected: r.ties_proj ?? null,
    winsBest: r.wins_new ?? null,
    lossesBest: r.losses_new ?? null,
    playoffOdds: r.playoffs_odds ?? null,
  })).sort((a, b) => (a.rankProjected ?? 99) - (b.rankProjected ?? 99));
  return { ok: true, playoffTeams: data.playoffsTeam ?? null, standings: rows };
}

/** Season-to-date start/sit accuracy vs the optimal lineup. Errors pre-week-2. */
export async function getStartSitAccuracy(key, teamId) {
  const data = await get(`${MPB}/api/getStartSitAccuracy?key=${encodeURIComponent(key)}&teamId=${encodeURIComponent(teamId)}`);
  const c = classify(data);
  if (!c.ok) return c;
  return { ok: true, ...data };
}

/** Contextual cards (news, waiver nudges) for the user's team. */
export async function getTeamInsights(key, { location } = {}) {
  const qs = new URLSearchParams({ key });
  if (location) qs.set('location', location);
  const data = await get(`${MPB}/api/getTeamInsights?${qs.toString()}`);
  const c = classify(data);
  if (!c.ok) return c;
  return {
    ok: true,
    week: data.week ?? null,
    cards: (data.cards || []).map((card) => ({
      type: card.type || null,
      title: card.title || null,
      subtitle: card.subtitle || null,
      text: card.text || null,
      actionText: card.actionText || null,
      actionLink: card.actionLink || null,
      imageUrl: card.imageUrl || null,
    })),
  };
}

/** Everything advanced for one league, with failures captured per endpoint. */
export async function fetchAdvanced(league) {
  const key = league.key;
  const teamId = league.myTeamId;
  const [matchup, standings, insights, startSit] = await Promise.all([
    getMatchup(key, { teamId }).catch((e) => ({ ok: false, error: e.message })),
    getProjectedStandings(key).catch((e) => ({ ok: false, error: e.message })),
    getTeamInsights(key).catch((e) => ({ ok: false, error: e.message })),
    teamId != null ? getStartSitAccuracy(key, teamId).catch((e) => ({ ok: false, error: e.message })) : Promise.resolve({ ok: false, error: 'no teamId' }),
  ]);
  const inactive = [matchup, standings, insights].some((r) => r.inactive);
  return { matchup, standings, insights, startSit, inactive };
}
