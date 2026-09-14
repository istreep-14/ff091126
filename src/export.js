import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EXPORT } from './config.js';

/**
 * Quote for CSV, and defuse the leading characters a spreadsheet reads as a
 * formula. Team and league names are free text typed by other managers, and
 * Excel evaluating one of them on open is not a hypothetical.
 */
const esc = (v) => {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // A negative number is not a formula; -2.5 must stay numeric in the column.
  if (/^[=+\-@\t\r]/.test(s) && !Number.isFinite(Number(s))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(rows, columns) {
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

export function exportCsv(model) {
  mkdirSync(EXPORT, { recursive: true });

  const leagues = model.leagues.map((l) => ({
    key: l.key, nickname: l.nickname, host: l.host, status: l.status, leagueId: l.leagueId, scoring: l.scoring, playerCount: l.playerCount,
    teamCount: l.teams.length, myTeamName: l.myTeamName, myTeamId: l.myTeamId,
    dynasty: l.dynasty, keepers: l.keepers, waiverType: l.waiverType, faabBudget: l.faabBudget,
    playoffTeams: l.playoffs?.teams, playoffStartWeek: l.playoffs?.startWeek, url: l.url,
  }));

  const rosters = model.leagues.flatMap((l) =>
    l.teams.flatMap((t) =>
      t.players.map((p) => ({
        league: l.nickname, host: l.host, leagueKey: l.key,
        teamId: t.teamId, teamName: t.name, isMine: t.isMine,
        fpId: p.fpId, player: p.name, playerTeam: p.team, position: p.position,
        ecrOverall: p.ecrOverall, ecrPosition: p.ecrPosition, ecrRestOfSeason: p.ecrRestOfSeason, ecrBoard: p.ecrBoard, tier: p.tier, byeWeek: p.byeWeek, unresolved: !!p.unresolved,
        // enrichment (blank unless `enrich` has run)
        sleeperId: p.fp?.sleeperId ?? null, thumb: p.fp?.thumb ?? null,
        fpWeekPoints: p.fp?.weekPoints ?? null, fpRosPoints: p.fp?.rosPoints ?? null,
        fpWeekRank: p.fp?.weekRank ?? null, fpRosRank: p.fp?.rosRank ?? null,
        startSitGrade: p.fp?.startSitGrade ?? null, opponent: p.fp?.opponent ?? null,
        vegasPoints: p.fp?.vegas?.points ?? null, vegasComplete: p.fp?.vegas?.complete ?? null,
        vegasVolatility: p.fp?.vegas?.volatility ?? null, vegasVsFp: p.fp?.vegasVsFp ?? null,
        pointsScored: p.fp?.scored?.points ?? null,
        injuryStatus: p.fp?.injury?.status ?? null,
        espnId: p.fp?.externalIds?.espn ?? null, yahooId: p.fp?.externalIds?.yahoo ?? null,
      })),
    ),
  );

  // CSV wants one row per PLAYER, but the move is the unit upstream, so each
  // row carries its move's id and kind — the grouping survives the flattening
  // instead of being destroyed by it.
  const transactions = model.leagues.flatMap((l) =>
    l.transactions.flatMap((t) =>
      t.items.map((i) => ({
        league: l.nickname,
        host: l.host,
        moveId: t.id,
        date: t.date,
        kind: t.kind,
        viaWaivers: t.viaWaivers ?? '',
        teamId: i.teamId,
        teamName: i.teamName,
        action: i.action,
        fpId: i.fpId,
        playerName: i.playerName,
        playerTeam: i.playerTeam,
        playerPos: i.playerPos,
      })),
    ),
  );

  const files = {
    'leagues.csv': toCsv(leagues, Object.keys(leagues[0] || { key: '' })),
    'rosters.csv': toCsv(rosters, Object.keys(rosters[0] || { league: '' })),
    'transactions.csv': toCsv(transactions, Object.keys(transactions[0] || { league: '' })),
  };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(EXPORT, name), body);
  return { dir: EXPORT, counts: { leagues: leagues.length, rosters: rosters.length, transactions: transactions.length } };
}
