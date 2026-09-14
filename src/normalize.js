import { resolve } from './players.js';

/**
 * The league's ACTUAL scoring, as the host defines it.
 *
 * This was in the settings payload the whole time and thrown away, and its
 * absence was a real wrong number on the page: per-player actuals were being
 * read from FantasyPros' generic PPR file, so a Sleeper league that takes -2
 * for an interception showed every quarterback too high. MyPlaybook returns the
 * league's own rule table, tiers and all — `FG` and `PtsAllow` are banded, so a
 * unit is a range with a value, not a single number.
 *
 * Kept as a flat list rather than a map because the tiers matter and a map
 * keyed by stat would have to throw them away or nest anyway.
 */
function scoringSystem(settings) {
  const raw = settings?.settings?.scoring_system;
  if (!Array.isArray(raw) || !raw.length) return null;
  const rules = raw.map((r) => ({
    stat: r.type,
    tiers: (r.units || []).map((u) => ({
      points: u.points ?? null,
      lower: u.lower ?? null,
      upper: u.upper ?? null,
    })),
  })).sort((a, b) => String(a.stat).localeCompare(String(b.stat)));
  return {
    format: settings?.settings?.scoring ?? null,
    basic: settings?.settings?.basic_scoring ?? null,
    custom: !!settings?.use_r2p_custom_scoring,
    rules,
  };
}

/** Flatten raw per-league endpoint payloads into one queryable model. */
export function normalize(rawLeagues, dict) {
  const leagues = rawLeagues.map((r) => {
    const rosters = r.endpoints.rosters?.data || null;
    const settings = r.endpoints.settings?.data || null;
    const tx = r.endpoints.transactions?.data || null;

    const teams = (rosters?.teams || []).map((t) => ({
      teamId: t.id,
      name: t.name,
      logo: t.logo || null,
      isMine: String(t.id) === String(rosters?.teamId),
      players: (t.players || []).map((fpId) => resolve(dict, fpId, rosters?.scoring)),
    }));

    /**
     * Transactions as MOVES, not as loose rows.
     *
     * Upstream, one manager action is one object with an `items` array: an
     * add and the drop that paid for it arrive together, and a trade arrives
     * as several items across two teams. Flattening `items` threw that away,
     * so an add/drop pair read as two unrelated events minutes apart and a
     * trade read as four. The grouping is the information — "who did they drop
     * for him" is most of what a transaction log is for.
     *
     * Each move keeps its own id so the UI can address one, and a `kind` that
     * names the shape the items actually form.
     */
    const transactions = (tx?.transactions || []).map((t, idx) => {
      const items = (t.items || []).map((i) => ({
        teamId: i.teamId,
        teamName: i.teamName,
        action: i.action,
        fpId: i.fpId,
        playerName: i.playerName,
        playerTeam: i.playerTeam,
        playerPos: i.playerPos,
      }));
      const teams = [...new Set(items.map((i) => String(i.teamId)))];
      const adds = items.filter((i) => /ADD|TRADE_FOR/i.test(i.action || ''));
      const drops = items.filter((i) => /DROP|TRADE_AWAY/i.test(i.action || ''));
      const kind = teams.length > 1 ? 'trade'
        : adds.length && drops.length ? 'swap'
        : adds.length ? 'add'
        : drops.length ? 'drop'
        : 'other';
      return {
        id: `${r.key}:${t.time ?? idx}:${idx}`,
        date: t.date,
        time: t.time,
        kind,
        teamIds: teams,
        teamName: items[0]?.teamName ?? null,
        // The upstream link encodes whether the move came off waivers.
        viaWaivers: /[?&]waiver=1/.test(t.url || '') || null,
        url: t.url ?? null,
        adds,
        drops,
        items,
      };
    });

    const playerCount = teams.reduce((a, t) => a + t.players.length, 0);
    // Empty rosters are usually an upstream state (league hasn't drafted, or the
    // host hasn't synced), not a failed fetch. Label it so the two never look alike.
    const status = !rosters ? 'unavailable'
      : rosters.hasDrafted === false ? 'predraft'
      : playerCount === 0 ? 'no-rosters-synced'
      : rosters.hasRosters === false ? 'partial-sync'
      : 'active';

    return {
      key: r.key,
      status,
      playerCount,
      nickname: r.nickname,
      host: r.host,
      sport: r.sport,
      leagueId: rosters?.leagueId || null,
      myTeamId: rosters?.teamId || null,
      myTeamName: rosters?.teamName || null,
      scoring: rosters?.scoring || null,
      // Upstream sends a comma-separated string; an array would throw on split.
      rosterSlots: Array.isArray(rosters?.positions) ? rosters.positions
        : (typeof rosters?.positions === 'string' ? rosters.positions.split(',') : null),
      dynasty: rosters?.dynasty ?? null,
      keepers: rosters?.keepers ?? null,
      hasDrafted: rosters?.hasDrafted ?? null,
      playoffs: settings
        ? { teams: settings.playoffsTeams, startWeek: settings.playoffsStartWeek, endWeek: settings.playoffsEndWeek, reseeding: settings.playoffReseeding }
        : null,
      // The league's own scoring table, tiers included. See scoringSystem().
      scoringSystem: scoringSystem(settings),
      waiverType: settings?.waiverSettings?.waiverType || null,
      faabBudget: settings?.waiverSettings?.faabBudget ?? null,
      commissionerTeamId: settings?.commissionerTeamId ?? null,
      userIsCommissioner: settings?.userIsCommissioner ?? null,
      url: rosters?.url || settings?.url || null,
      teams,
      transactions,
      errors: Object.entries(r.endpoints).filter(([, e]) => !e.ok).map(([name, e]) => ({ endpoint: name, error: e.error })),
    };
  });

  const byStatus = leagues.reduce((a, l) => ((a[l.status] = (a[l.status] || 0) + 1), a), {});

  const unresolved = new Set();
  for (const l of leagues) for (const t of l.teams) for (const p of t.players) if (p.unresolved) unresolved.add(p.fpId);

  return {
    generatedAt: new Date().toISOString(),
    playerDictionaryAt: dict.fetchedAt,
    leagueCount: leagues.length,
    statusCounts: byStatus,
    unresolvedPlayerIds: [...unresolved],
    leagues,
  };
}
