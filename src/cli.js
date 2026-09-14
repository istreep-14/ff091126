#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, config } from './config.js';
import { resolveLeagues, ENDPOINTS } from './fantasypros.js';
import { loadDictionary } from './players.js';
import { scrape } from './scrape.js';
import { exportCsv } from './export.js';
import * as fp from './fpapi.js';
import { fpSync, apiSupplement, scoringsInUse } from './fpsync.js';
import { scrapeSync, fetchRankings, fetchInjuryNews } from './scrapefp.js';
import { resolve as resolveWeek } from './week.js';
import { enrich } from './enrich.js';
import { loadState, isActive, setActive, setOnly, applyFilters } from './leaguestate.js';
import * as vegas from './vegas.js';
import { loadIdMap, buildIdMap } from './idmap.js';
import { loadSleeper } from './sleeper.js';
import { buildDashboard } from './dashboard.js';
import { wwoSync } from './winwithodds.js';
import { fdSync } from './firstdown.js';
import { fanduelSync } from './fanduel.js';
import { buzzSync, fetchDay, recentDates } from './buzz.js';
import { trendSync, fetchAll as fetchTrending } from './sleepertrend.js';
import { loadSignals } from './signals.js';
import { runPipeline, printStatus, printProjectionAges } from './sync.js';
import { projSync, projSyncAuto, readProjections, playerWeeks, weekReport, LAST_WEEK } from './sleeperproj.js';
import { shapeFor, splitRos, perWeekEstimates } from './weekshape.js';
import { parseArgs, resolveLeague } from './args.js';
import * as ov from './overrides.js';
import { syncLeagueDetail } from './leaguedata.js';
import { matchupsSync } from './matchups.js';
import { scrapeSync as fpScrapeSync } from './scrapefp.js';

const [, , cmd, ...rest] = process.argv;
const { positional, flag, opt } = parseArgs(rest);

const resolveLeagueArg = () => resolveLeague(loadLatest().leagues, positional);

function loadLatest() {
  const p = join(DATA, 'latest.json');
  if (!existsSync(p)) throw new Error('No data yet — run `npm run scrape` first.');
  return JSON.parse(readFileSync(p, 'utf8'));
}

const commands = {
  async leagues() {
    const leagues = await resolveLeagues();
    const state = loadState();
    const on = leagues.filter((l) => isActive(state, l.key)).length;
    console.log(`${leagues.length} league(s) for ${config.email || '(keys only)'} — ${on} active, ${leagues.length - on} inactive\n`);
    console.log('  ON   HOST      SCORING  NICKNAME                        KEY');
    for (const l of leagues) {
      console.log(
        ` ${isActive(state, l.key) ? ' \u2713 ' : ' \u00b7 '}  `,
        (l.host || '?').padEnd(9),
        (l.scoring || '-').padEnd(8),
        (l.nickname || l.name || '-').slice(0, 30).padEnd(31),
        l.key,
      );
    }
    console.log('\n  leagues:on <name> | leagues:off <name> | leagues:only <name> [name...]');
  },

  async 'leagues:on'() {
    const hits = setActive(await resolveLeagues(), positional[0], true);
    if (!hits.length) throw new Error(`No league matched "${positional[0]}"`);
    console.log(`activated: ${hits.map((l) => l.nickname || l.name).join(', ')}`);
  },

  async 'leagues:off'() {
    const hits = setActive(await resolveLeagues(), positional[0], false);
    if (!hits.length) throw new Error(`No league matched "${positional[0]}"`);
    console.log(`deactivated: ${hits.map((l) => l.nickname || l.name).join(', ')}`);
  },

  async 'leagues:only'() {
    if (!positional.length) throw new Error('Name at least one league to keep active.');
    const kept = setOnly(await resolveLeagues(), positional);
    if (!kept.length) throw new Error(`No league matched ${positional.join(', ')}`);
    console.log(`active now: ${kept.map((l) => l.nickname || l.name).join(', ')}`);
  },

  async 'leagues:all'() {
    const leagues = await resolveLeagues();
    setOnly(leagues, leagues.map((l) => l.key));
    console.log(`activated all ${leagues.length} leagues`);
  },

  async scrape() {
    const only = opt('league');
    const eps = opt('endpoints')?.split(',') || Object.keys(ENDPOINTS);
    const { model } = await scrape({ filter: only, limit: opt('limit'), all: flag('all'), endpoints: eps });
    if (model.unresolvedPlayerIds.length) {
      console.log(`\nNote: ${model.unresolvedPlayerIds.length} player id(s) not in the ECR dictionary: ${model.unresolvedPlayerIds.join(', ')}`);
    }
  },

  async players() {
    const dict = await loadDictionary({ refresh: flag('refresh') });
    console.log(`${dict.count} players (fetched ${dict.fetchedAt})`);
    const q = positional[0];
    if (q) {
      const hits = Object.values(dict.players).filter((p) => p.name?.toLowerCase().includes(q.toLowerCase()));
      for (const p of hits.slice(0, 20)) console.log(`  ${String(p.fpId).padEnd(7)} ${(p.name||'').padEnd(24)} ${p.position} ${p.team}  ppr ${p.ranks?.ppr ?? '-'} | half ${p.ranks?.half ?? '-'} | std ${p.ranks?.std ?? '-'} | ${p.position}${p.ranks?.pos ?? '-'}`);
    }
  },

  async roster() {
    const model = loadLatest();
    const q = (positional[0] || '').toLowerCase();
    const leagues = q ? model.leagues.filter((l) => l.nickname?.toLowerCase().includes(q) || l.key === positional[0]) : model.leagues;
    if (!leagues.length) throw new Error(`No league matched "${positional[0]}"`);
    for (const l of leagues) {
      console.log(`\n=== ${l.nickname} (${l.host}, ${l.scoring}) — ${l.teams.length} teams, ${l.playerCount} players [${l.status}] ===`);
      if (l.status !== 'active') console.log(`  (no roster data upstream — ${l.status})`);
      for (const t of l.teams) {
        console.log(`\n  ${t.name}${t.isMine ? '  <-- you' : ''} [team ${t.teamId}]`);
        for (const p of t.players) {
          console.log(`    ${String(p.position || '--').padEnd(4)} ${(p.name || '').padEnd(26)} ${(p.team || '').padEnd(4)} ovr ${String(p.ecrOverall ?? '-').padStart(4)}  ${String(p.position || '')}${p.ecrPosition ?? '-'}`);
        }
      }
    }
  },

  /** Moves, kept whole: the add and the drop that paid for it on one line. */
  async transactions() {
    const model = loadLatest();
    const name = (i) => `${i.playerName || '?'}${i.playerPos ? ` (${i.playerPos})` : ''}`;
    for (const l of model.leagues) {
      if (!l.transactions.length) continue;
      console.log(`\n=== ${l.nickname} (${l.host}) ===`);
      for (const t of l.transactions) {
        const parts = [];
        if (t.adds.length) parts.push('+ ' + t.adds.map(name).join(', '));
        if (t.drops.length) parts.push('- ' + t.drops.map(name).join(', '));
        console.log(
          `  ${t.date?.slice(0, 10)}  ${String(t.kind).padEnd(5)}${t.viaWaivers ? ' W' : '  '} ` +
          `${(t.teamName || '').slice(0, 26).padEnd(27)} ${parts.join('   ')}`,
        );
      }
    }
  },

  // ---------------------------------------------------------- FantasyPros API

  async 'fp:check'() {
    const { season, week } = resolveWeek({ season: config.season, week: config.week });
    console.log(`season ${season}, week ${week} (override with FP_SEASON / FP_WEEK)`);
    console.log(`scoring formats in use: ${scoringsInUse().join(', ')}`);
    if (!config.apiKey) { console.log('\nFP_API_KEY: not set'); return; }
    console.log(`FP_API_KEY: set (${config.apiKey.length} chars)\n`);
    try {
      const r = await fp.ping();
      console.log(`OK — key works. /nfl/players returned ${r?.players?.length ?? '?'} players.`);
    } catch (err) {
      console.log(err.message);
    }
  },

  async 'fp:sync'() {
    const positions = opt('positions')?.split(',') || fp.POSITIONS;
    const scorings = opt('scoring')?.split(',') || null;
    const args = { season: opt('season'), week: opt('week'), positions, scorings };
    const source = opt('source') || 'hybrid';

    if (source === 'api') return void (await fpSync(args));
    if (source === 'scrape') return void (await scrapeSync(args));

    // hybrid (default): scrape the bulk, spend a few API calls on the rest.
    await scrapeSync(args);
    if (!config.apiKey) {
      console.log('\n(no FP_API_KEY — skipping players/external-ids and points-scored)');
      return;
    }
    console.log();
    try {
      await apiSupplement(args);
    } catch (err) {
      if (!(err instanceof fp.ApiKeyRejectedError || err instanceof fp.MissingApiKeyError)) throw err;
      console.log(`  ${err.message.split('\n')[0]}`);
    }
  },

  async 'fp:scrape'() {
    await scrapeSync({
      season: opt('season'), week: opt('week'),
      positions: opt('positions')?.split(',') || undefined,
      scorings: opt('scoring')?.split(',') || null,
      newsPages: Number(opt('news-pages') || 4),
    });
  },

  async 'scrape:rankings'() {
    const d = await fetchRankings({ position: opt('position') || 'RB', scoring: opt('scoring') || 'PPR', ros: flag('ros') });
    console.log(`${d.position_id || opt('position')} ${d.scoring} ${d.ranking_type_name} week ${d.week} — ${d.players.length} players (${d.total_experts || '?'} experts)\n`);
    console.log('  RK  PLAYER                     TM   OPP        PTS  GRADE  SPREAD');
    for (const p of d.players.slice(0, Number(opt('limit') || 30))) {
      console.log(
        `  ${String(p.rank_ecr).padStart(3)} ${(p.player_name || '').slice(0, 25).padEnd(26)} ${(p.player_team_id || '').padEnd(4)} ` +
        `${(p.player_opponent || '').padEnd(9)} ${String(p.r2p_pts ?? '-').padStart(5)}  ${(p.start_sit_grade || '-').padEnd(5)}  ${p.rank_min}-${p.rank_max}`,
      );
    }
  },

  async 'scrape:news'() {
    const items = await fetchInjuryNews({ pages: Number(opt('pages') || 2), position: opt('position'), team: opt('team') });
    console.log(`${items.length} items\n`);
    for (const i of items.slice(0, Number(opt('limit') || 30))) {
      console.log(`  ${(i.date || '').padEnd(26)} ${(i.position || '').padEnd(4)} ${(i.team || '').padEnd(4)} ${i.headline}`);
    }
  },

  async 'fp:rankings'() {
    const { season, week } = resolveWeek({ season: opt('season') ?? config.season, week: opt('week') ?? config.week });
    const ros = flag('ros');
    const data = await fp.consensusRankings({
      season, position: opt('position') || 'ALL', scoring: opt('scoring') || 'PPR',
      week: ros ? undefined : week, type: ros ? 'ROS' : undefined,
    });
    console.log(`${data.position_id} ${data.scoring} ${ros ? 'ROS' : `week ${week}`} — ${data.players?.length ?? 0} players\n`);
    for (const p of (data.players || []).slice(0, Number(opt('limit') || 40))) {
      console.log(`  ${String(p.rank_ecr).padStart(4)}  ${(p.player_name || '').padEnd(26)} ${(p.player_team_id || '').padEnd(4)} ${(p.player_position_id || '').padEnd(4)} tier ${p.tier ?? '-'}`);
    }
  },

  async 'fp:projections'() {
    const { season, week } = resolveWeek({ season: opt('season') ?? config.season, week: opt('week') ?? config.week });
    const ros = flag('ros');
    const pos = opt('position') || 'RB';
    const data = await fp.projections({ season, position: pos, week: ros ? undefined : week, ros: ros || undefined });
    console.log(`${pos} projections — ${ros ? 'rest of season' : `week ${week}`} — ${data.players?.length ?? 0} players\n`);
    const key = { PPR: 'points_ppr', HALF: 'points_half', STD: 'points' }[(opt('scoring') || 'PPR').toUpperCase()];
    const rows = (data.players || []).map((p) => ({ name: p.name, team: p.team_id, pts: (Array.isArray(p.stats) ? p.stats[0] : p.stats)?.[key] }))
      .sort((a, b) => (b.pts ?? 0) - (a.pts ?? 0));
    for (const r of rows.slice(0, Number(opt('limit') || 40))) {
      console.log(`  ${String(r.pts ?? '-').padStart(7)}  ${(r.name || '').padEnd(26)} ${r.team || ''}`);
    }
  },

  async 'fp:injuries'() {
    const { season, week } = resolveWeek({ season: opt('season') ?? config.season, week: opt('week') ?? config.week });
    const data = await fp.injuries({ year: season, week });
    const rows = data.injuries || data.players || [];
    console.log(`injuries — season ${season} week ${week} — ${rows.length}\n`);
    for (const i of rows.slice(0, Number(opt('limit') || 60))) {
      console.log(`  ${(i.status || i.injury_type || '?').padEnd(14)} ${(i.name || '').padEnd(26)} ${i.injury_type || ''} ${i.injury_update_date || ''}`);
    }
  },

  async 'fp:news'() {
    const data = await fp.news({ limit: Number(opt('limit') || 25), category: opt('category') });
    const rows = data.news || data.items || [];
    console.log(`news — ${rows.length} items\n`);
    for (const n of rows) console.log(`  ${(n.created || n.updated || '').slice(0, 16)}  ${n.title || n.headline || ''}`);
  },

  async enrich() {
    const { season } = resolveWeek({ season: opt('season') ?? config.season, week: opt('week') ?? config.week });
    const idMap = await loadIdMap({ season });
    const m = enrich({ season: opt('season') ?? config.season, week: opt('week') ?? config.week, bookmaker: opt('bookmaker') || 'Average', idMap });
    const all = m.leagues.flatMap((l) => l.teams.flatMap((t) => t.players));
    const withProj = all.filter((p) => p.fp?.weekPoints != null).length;
    const withRank = all.filter((p) => p.fp?.weekRank != null).length;
    const hurt = all.filter((p) => p.fp?.injury?.status).length;
    const withVegas = all.filter((p) => p.fp?.vegas?.points != null).length;
    const withThumb = all.filter((p) => p.fp?.thumb).length;
    console.log(`Enriched ${all.length} roster slots for season ${m.enrichedSeason} week ${m.enrichedWeek}`);
    if (!m.fpDataPresent) console.log('  (no data/fp/ yet — run `fp:sync` once the API key is active)');
    console.log(`  week projections: ${withProj}`);
    console.log(`  week ranks:       ${withRank}`);
    console.log(`  injury flags:     ${hurt}`);
    console.log(`  vegas projections:${String(withVegas).padStart(5)} (${m.bookmaker})`);
    console.log(`  headshots:        ${withThumb}`);
    console.log(`  -> data/enriched.json`);
  },

  async lineup() {
    const { season } = resolveWeek({ season: opt('season') ?? config.season, week: opt('week') ?? config.week });
    const idMap = await loadIdMap({ season });
    const m = enrich({ season: opt('season') ?? config.season, week: opt('week') ?? config.week, bookmaker: opt('bookmaker') || 'Average', idMap });
    const q = (positional[0] || '').toLowerCase();
    const leagues = q ? m.leagues.filter((l) => l.nickname?.toLowerCase().includes(q)) : m.leagues;
    if (!leagues.length) throw new Error(`No league matched "${positional[0]}"`);
    let shown = 0;
    for (const l of leagues) {
      const mine = l.teams.find((t) => t.isMine);
      if (!mine) {
        console.log(`\n=== ${l.nickname} (${l.host}) — no roster for your team [${l.status}] ===`);
        continue;
      }
      shown++;
      console.log(`\n=== ${l.nickname} (${l.host}, ${l.scoring}) — ${mine.name}, week ${m.enrichedWeek} ===`);
      console.log('  POS  PLAYER                      TM    FP WK   VEGAS    DIFF   ROS PTS   WK RK  STATUS');
      const rows = [...mine.players].sort((a, b) => (b.fp?.weekPoints ?? -1) - (a.fp?.weekPoints ?? -1));
      for (const p of rows) {
        const f = p.fp || {};
        const d = f.vegasVsFp;
        console.log(
          `  ${String(p.position || '--').padEnd(4)} ${(p.name || '').slice(0, 26).padEnd(27)} ${(p.team || '').padEnd(4)} ` +
          `${String(f.weekPoints ?? '-').padStart(6)} ${String(f.vegas?.points ?? '-').padStart(7)} ` +
          `${(d == null ? '-' : (d > 0 ? '+' : '') + d).padStart(7)} ${String(f.rosPoints ?? '-').padStart(9)} ` +
          `${String(f.weekRank ?? '-').padStart(6)}  ${f.injury?.status || f.vegas?.injuryStatus || ''}`,
        );
      }
    }
    if (shown && !m.fpDataPresent) console.log('\n  (projections/ranks blank — run `fp:sync` once the API key is active)');
  },

  // ------------------------------------------------------------- VegasEdge

  async 'wwo:sync'() {
    await wwoSync({ season: opt('season'), week: opt('week') });
  },

  async 'fd:sync'() {
    await fdSync({ season: opt('season'), week: opt('week') });
  },

  async 'fanduel:sync'() {
    await fanduelSync({ season: opt('season'), week: opt('week') });
  },

  // ------------------------------------------------------------ league edits
  //
  // Everything else in this CLI reads. These write data/league-overrides.json,
  // which is merged over the scrape at dashboard time and is never touched by a
  // re-scrape.

  /** Show one league's overrides, or all of them. */
  async league() {
    const model = loadLatest();
    const q = positional.join(' ');
    const matched = q ? model.leagues.filter((l) => (l.nickname || '').toLowerCase().includes(q.toLowerCase()) || l.key === q) : model.leagues;
    if (!matched.length) throw new Error(`No league matched "${q}"`);
    for (const l of matched) {
      const o = ov.forLeague(l.key);
      console.log(`\n=== ${o.nickname || l.nickname} ${o.nickname ? `(scraped: ${l.nickname})` : ''}`);
      console.log(`  key       ${l.key}`);
      console.log(`  host      ${l.host} · ${l.scoring} · ${l.teams.length} teams`);
      const mine = o.myTeamIds.length ? o.myTeamIds : (l.myTeamId != null ? [l.myTeamId] : []);
      console.log(`  mine      ${mine.length ? mine.map((id) => {
        const t = l.teams.find((x) => String(x.teamId) === String(id));
        const nm = o.teams[String(id)]?.nickname || t?.name || id;
        return `${nm}${String(o.primaryTeamId ?? mine[0]) === String(id) ? ' *' : ''}`;
      }).join(', ') : '(none)'}${o.myTeamIds.length ? '' : '  [from host]'}`);
      console.log(`  playoffs  ${ov.describeRule(o.playoffs) || `(no rule set — host says ${l.playoffs?.teams ?? '?'} teams from week ${l.playoffs?.startWeek ?? '?'})`}`);
      console.log(`  waivers   ${o.waivers.type || l.waiverType || '(unset)'}${o.waivers.claimDays != null ? `, ${o.waivers.claimDays}d claim period` : ''}`);
      if (o.divisions.length) console.log(`  divisions ${o.divisions.map((d) => d.name).join(', ')}`);
      console.log('\n  TEAM                             ID   DIVISION');
      for (const t of l.teams) {
        const to = o.teams[String(t.teamId)] || {};
        const nm = to.nickname || t.name;
        console.log(`  ${(nm + (to.nickname ? ` (was ${t.name})` : '')).slice(0, 32).padEnd(33)}${String(t.teamId).padStart(3)}   ${to.division || ''}`);
      }
    }
    console.log(`\n  edits: league:name | league:team | league:mine | league:playoffs | league:waivers | league:division | league:scoring`);
  },

  /** Rename a league. `league:name <key-or-match> <new name>` */
  async 'league:name'() {
    const { league, rest: name } = resolveLeagueArg();
    if (!name) throw new Error('Usage: league:name <league> <new nickname>');
    ov.update(league.key, { nickname: name });
    console.log(`${league.nickname} -> "${name}"`);
  },

  /** Rename a team. `league:team <league> <teamId> <new name>` */
  async 'league:team'() {
    const { league, rest } = resolveLeagueArg();
    const [teamId, ...nameParts] = rest.split(' ');
    const team = league.teams.find((t) => String(t.teamId) === teamId);
    if (!team) throw new Error(`No team ${teamId} in ${league.nickname}. Run \`league ${league.nickname}\` for ids.`);
    const name = nameParts.join(' ');
    if (!name) throw new Error('Usage: league:team <league> <teamId> <new nickname>');
    ov.setTeam(league.key, teamId, { nickname: name });
    console.log(`${league.nickname}: team ${teamId} "${team.name}" -> "${name}"`);
  },

  /**
   * Which teams are yours. `league:mine <league> <teamId> [teamId...]`
   *
   * A list, because the host reports exactly one and that is wrong for anyone
   * co-managing or running two teams. The first id given is the primary — the
   * one "My Team" opens on.
   */
  async 'league:mine'() {
    const { league, rest } = resolveLeagueArg();
    const ids = rest.split(/[\s,]+/).filter(Boolean);
    if (!ids.length) throw new Error('Usage: league:mine <league> <teamId> [teamId...]');
    const bad = ids.filter((id) => !league.teams.some((t) => String(t.teamId) === id));
    if (bad.length) throw new Error(`Not a team id in ${league.nickname}: ${bad.join(', ')}`);
    ov.update(league.key, { myTeamIds: ids, primaryTeamId: ids[0] });
    const names = ids.map((id) => league.teams.find((t) => String(t.teamId) === id).name);
    console.log(`${league.nickname}: yours = ${names.join(', ')} (primary: ${names[0]})`);
  },

  /** Assign a team to a division. `league:division <league> <teamId> <division>` */
  async 'league:division'() {
    const { league, rest } = resolveLeagueArg();
    const [teamId, ...div] = rest.split(' ');
    const name = div.join(' ');
    if (!teamId || !name) throw new Error('Usage: league:division <league> <teamId> <division name>');
    const cur = ov.forLeague(league.key);
    const divisions = cur.divisions.some((d) => d.name === name) ? cur.divisions : [...cur.divisions, { id: name, name }];
    ov.update(league.key, { divisions });
    ov.setTeam(league.key, teamId, { division: name });
    console.log(`${league.nickname}: team ${teamId} -> division "${name}"`);
  },

  /**
   * How playoff seeds are decided.
   * `league:playoffs <league> --rule points-wildcard --teams 6 --wildcards 1`
   */
  async 'league:playoffs'() {
    const { league } = resolveLeagueArg();
    const rule = opt('rule');
    if (rule && !ov.SEED_RULES[rule]) {
      throw new Error(`Unknown rule "${rule}". One of: ${Object.keys(ov.SEED_RULES).join(', ')}`);
    }
    const patch = {};
    if (rule) patch.rule = rule;
    if (opt('teams')) patch.playoffTeams = Number(opt('teams'));
    if (opt('division-seeds')) patch.divisionSeeds = Number(opt('division-seeds'));
    if (opt('wildcards')) patch.wildcards = Number(opt('wildcards'));
    if (opt('tiebreak')) patch.tiebreak = opt('tiebreak');
    if (opt('start-week')) patch.startWeek = Number(opt('start-week'));
    if (opt('note')) patch.note = opt('note');
    if (!Object.keys(patch).length) {
      console.log('Rules:');
      for (const [k, v] of Object.entries(ov.SEED_RULES)) console.log(`  ${k.padEnd(16)} ${v.label}`);
      console.log('Tiebreaks:');
      for (const [k, v] of Object.entries(ov.TIEBREAK)) console.log(`  ${k.padEnd(16)} ${v.label}`);
      return;
    }
    const next = ov.update(league.key, { playoffs: patch });
    console.log(`${league.nickname}: ${ov.describeRule(next.playoffs)}`);
  },

  /** Waiver mechanics the hosts do not expose. */
  async 'league:waivers'() {
    const { league } = resolveLeagueArg();
    const patch = {};
    if (opt('type')) patch.type = opt('type');
    if (opt('claim-days')) patch.claimDays = Number(opt('claim-days'));
    if (opt('process-day')) patch.processDay = Number(opt('process-day'));
    if (opt('process-hour')) patch.processHour = Number(opt('process-hour'));
    if (opt('note')) patch.note = opt('note');
    if (!Object.keys(patch).length) {
      throw new Error('Usage: league:waivers <league> [--type rolling|faab|reverse|none] [--claim-days N] [--process-day 0-6] [--process-hour 0-23]');
    }
    const next = ov.update(league.key, { waivers: patch });
    console.log(`${league.nickname}: waivers ${JSON.stringify(next.waivers)}`);
  },

  /**
   * The league's scoring table, and corrections to it.
   *
   * `league:scoring <league>`              print it
   * `league:scoring <league> IntQB -2`     override one stat
   * `league:scoring <league> IntQB --clear`
   *
   * Two readings are printed because two sources disagree: MyPlaybook's read of
   * the host's rules (available for every host, complete for none — it lists no
   * defensive stats at all for a Sleeper league that scores them) and the host's
   * own table where the host publishes one. Yours wins over both.
   */
  async 'league:scoring'() {
    const { league, rest } = resolveLeagueArg();
    const o = ov.forLeague(league.key);
    const parts = rest.split(/\s+/).filter(Boolean);

    if (parts.length) {
      const [stat, val] = parts;
      const next = { ...o.scoring };
      if (flag('clear') || val === undefined) delete next[stat];
      else next[stat] = Number(val);
      ov.update(league.key, { scoring: next });
      console.log(`${league.nickname}: ${stat} ${next[stat] === undefined ? 'cleared' : `= ${next[stat]}`}`);
      return;
    }

    const sys = league.scoringSystem;
    if (!sys) {
      console.log(`${league.nickname}: no scoring table from ${league.host} (run \`scrape\` to refresh).`);
      return;
    }
    console.log(`\n=== ${o.nickname || league.nickname} — ${sys.format || '?'}${sys.custom ? ' (custom scoring on)' : ''}`);
    console.log('\n  STAT          SCRAPED                 YOURS');
    for (const r of sys.rules) {
      const val = r.tiers.length > 1
        ? r.tiers.map((t) => `${t.points}@${t.lower}-${t.upper}`).join(' ')
        : String(r.tiers[0]?.points ?? '—');
      const mine = o.scoring[r.stat];
      console.log(`  ${r.stat.padEnd(13)} ${val.slice(0, 23).padEnd(24)}${mine == null ? '' : mine}`);
    }
    const extra = Object.keys(o.scoring).filter((k) => !sys.rules.some((r) => r.stat === k));
    for (const k of extra) console.log(`  ${k.padEnd(13)} ${'(not in scrape)'.padEnd(24)}${o.scoring[k]}`);
    console.log('\n  Per-player points elsewhere come from the host itself, not from this table.');
  },

  /**
   * Apply a JSON patch exported from the dashboard's league editor.
   * `league:import <file.json>` — or pipe it in.
   */
  async 'league:import'() {
    const file = positional[0];
    if (!file) throw new Error('Usage: league:import <file.json>  (from the dashboard\u2019s Export button)');
    const body = JSON.parse(readFileSync(file, 'utf8'));
    const leagues = body.leagues || body;
    let n = 0;
    for (const [key, patch] of Object.entries(leagues)) { ov.update(key, patch); n++; }
    console.log(`Imported overrides for ${n} league(s) -> ${ov.OVERRIDES_PATH}`);
  },

  // ------------------------------------------------------------- pipeline

  /**
   * Every source, but only the ones that have gone stale.
   *
   * This is what `all` should always have been. `all` is kept as the
   * unconditional escape hatch; this is the one to run repeatedly.
   */
  async sync() {
    const run = () => runPipeline({
      scrape: async () => { await commands.scrape(); },
      fp: async ({ season, week }) => { await fpScrapeSync({ season, week }); },
      sleeperProj: async ({ season, week }) => { await projSyncAuto({ season, week }); },
      vegas: async ({ season, week }) => { await vegas.vegasSync({ season, week, bookmakers: opt('bookmaker')?.split(',') || ['Average'] }); },
      vegasDist: async ({ season, week }) => { await vegas.vegasDistSync({ season, week, scoring: opt('scoring') || 'PPR' }); },
      wwo: async ({ season, week }) => { await wwoSync({ season, week }); },
      firstdown: async ({ season, week }) => { await fdSync({ season, week }); },
      fanduel: async ({ season, week }) => { await fanduelSync({ season, week }); },
      buzz: async ({ season, week }) => { await buzzSync({ season, week, days: opt('days') || 2 }); },
      trend: async ({ season, week }) => { await trendSync({ season, week }); },
      leaguedetail: async ({ season, week }) => {
        const leagues = applyFilters(await resolveLeagues(), { all: flag('all') });
        await syncLeagueDetail({ season, week, leagues });
      },
      matchups: async ({ season, week }) => { await matchupsSync({ season, week, leagues: loadLatest().leagues }); },
      enrich: async () => { await commands.enrich(); },
      dashboard: async () => { await commands.dashboard(); },
    }, {
      force: flag('force'),
      only: opt('only'),
      skip: opt('skip'),
      maxAge: opt('max-age'),
      dryRun: flag('dry-run'),
    });

    const every = Number(opt('watch'));
    if (!every || !Number.isFinite(every) || every <= 0) return void (await run());

    /**
     * Keep going until interrupted.
     *
     * Each pass still honours every source's own TTL, so a one-minute interval
     * does not mean fetching everything once a minute — it means asking the
     * handful of sources that move that often, and for Sleeper's projections
     * asking with an ETag, which costs a 304. The interval is how often we
     * CHECK, not how often we fetch.
     */
    console.log(`Watching — a pass every ${every}m. Ctrl-C to stop.\n`);
    let stop = false;
    process.on('SIGINT', () => { stop = true; console.log('\nStopping after this pass…'); });
    for (let pass = 1; !stop; pass++) {
      console.log(`\n${'─'.repeat(60)}\npass ${pass} · ${new Date().toLocaleTimeString()}`);
      // One bad pass must not end the watch; the next one may well work.
      await run().catch((err) => console.error(`  pass failed — ${err.message.split('\n')[0]}`));
      if (stop) break;
      await new Promise((r) => setTimeout(r, every * 60_000));
    }
  },

  /** How old every source is, and whether the site itself has moved. */
  async status() {
    printStatus();
    if (flag('weeks')) {
      const { season } = resolveWeek({ season: opt('season') ?? config.season });
      console.log('');
      printProjectionAges(season, weekReport(season));
    }
  },

  // ------------------------------------------- Sleeper weekly projections

  /**
   * Sleeper's projections for every week of the season, per player.
   *
   * Default behaviour matches the pipeline: the live week always, the rest of
   * the season only when it is missing or the nightly batch has run since.
   * `--full` forces all eighteen weeks, `--week N` just one.
   */
  async 'sleeper:proj'() {
    const args = { season: opt('season'), week: opt('week') };
    if (flag('full')) return void (await projSync({ ...args, force: flag('force') }));
    if (opt('week')) return void (await projSync({ ...args, weeks: [Number(opt('week'))], force: flag('force') }));
    await projSyncAuto(args);
  },

  /** Per-week recompute times for the stored projection set. */
  async 'proj:ages'() {
    const { season } = resolveWeek({ season: opt('season') ?? config.season });
    printProjectionAges(season, weekReport(season));
  },

  /**
   * One player's week-by-week curve, and every rest-of-season total on him
   * spread across it.
   *
   * This is the view the whole weekly-shape machinery exists for: three of the
   * five projection sources publish a season total and nothing weekly, and
   * this is where those totals become a number you can put in a lineup.
   */
  async proj() {
    const q = positional.join(' ').toLowerCase();
    if (!q) throw new Error('Usage: proj <player name> [--scoring PPR] [--from N]');
    const { season, week } = resolveWeek({ season: opt('season') ?? config.season, week: opt('week') ?? config.week });
    const store = readProjections(season);
    if (!store) throw new Error(`No Sleeper projections for ${season} — run \`sleeper:proj\` first.`);

    const model = existsSync(join(DATA, 'enriched.json'))
      ? JSON.parse(readFileSync(join(DATA, 'enriched.json'), 'utf8'))
      : null;
    const rostered = model
      ? model.leagues.flatMap((l) => l.teams.flatMap((t) => t.players.map((p) => ({ p, league: l, team: t }))))
      : [];
    const hit = rostered.find(({ p }) => (p.name || '').toLowerCase().includes(q));

    // Fall back to the projection set itself, so an unrostered free agent works.
    let sleeperId = hit?.p?.fp?.sleeperId ?? null;
    let label = hit?.p?.name ?? null;
    if (!sleeperId) {
      const entryId = Object.entries(store.players).find(([, v]) => (v.n || '').toLowerCase().includes(q));
      if (!entryId) throw new Error(`No player matched "${q}".`);
      [sleeperId] = entryId;
      label = entryId[1].n;
    }

    const scoring = (opt('scoring') || hit?.league?.scoring || 'PPR').toUpperCase();
    const from = Number(opt('from') || week) || 1;
    const weeks = playerWeeks(store, sleeperId);
    const shape = shapeFor(weeks, { fromWeek: from, scoring });
    if (!shape) throw new Error(`${label} has no Sleeper projections for weeks ${from}–${LAST_WEEK}.`);

    const f = hit?.p?.fp || {};
    const totals = { fp: f.rosPoints, wwo: f.wwo?.rosDerived, fd: f.fd?.rosDerived, fanduel: f.fanduel?.rosDerived };
    const named = Object.entries(totals).filter(([, v]) => v != null);

    console.log(`\n${label}  (${store.players[sleeperId]?.p || '?'} ${store.players[sleeperId]?.t || ''}, sleeper ${sleeperId})`);
    if (hit) console.log(`  ${hit.league.nickname} · ${hit.team.name}${hit.team.isMine ? '  <-- you' : ''}`);
    console.log(`  ${scoring} scoring, weeks ${from}–${shape.throughWeek}, ${shape.played} games${shape.byes.length ? ` (bye wk ${shape.byes.join(', ')})` : ''}`);
    console.log(`\n  Sleeper's own remaining total: ${shape.total}`);
    console.log('  Rest-of-season totals from every source that publishes one:');
    if (!named.length) console.log('    (none — run `enrich` for a rostered player to see these)');
    for (const [k, v] of named) console.log(`    ${k.padEnd(9)} ${String(v).padStart(7)}`);

    console.log('\n  WK  OPP    SLEEPER   SHARE' + named.map(([k]) => `  ${k.toUpperCase().padStart(7)}`).join('') + '   BLENDED');
    for (let w = from; w <= shape.throughWeek; w++) {
      const cell = weeks[w] || weeks[String(w)];
      const est = perWeekEstimates(totals, shape, w);
      const share = shape.share[w] ?? 0;
      console.log(
        `  ${String(w).padStart(2)}  ${(cell?.opp || 'BYE').padEnd(5)} ${String(shape.points[w] ?? 0).padStart(8)}` +
        `  ${(share * 100).toFixed(1).padStart(5)}%` +
        named.map(([k]) => `  ${String(est?.sources?.[k] ?? '—').padStart(7)}`).join('') +
        `   ${String(est?.blended ?? '—').padStart(7)}`,
      );
    }
    console.log('\n  SHARE is this week\'s slice of the player\'s remaining Sleeper projection.');
    console.log('  Every other column is that source\'s OWN season total on Sleeper\'s calendar —');
    console.log('  a redistribution, not a projection. Where a source publishes a real weekly');
    console.log('  number (FantasyPros, VegasEdge, Sleeper) that number is used instead.');
    if (f.weekPoints != null) console.log(`\n  For comparison, FantasyPros' published week-${week} projection: ${f.weekPoints}`);
  },

  // ------------------------------------------------------- demand signals

  /** Every matchup in every league, live — and the season points ledger. */
  async 'matchups:sync'() {
    await matchupsSync({ season: opt('season'), week: opt('week'), leagues: loadLatest().leagues });
  },

  /** This week's board for one league (or all), printed. */
  async matchups() {
    const { readWeek, storedWeeks, isFinal } = await import('./matchups.js');
    const { season, week } = resolveWeek({ season: opt('season') ?? config.season, week: opt('week') ?? config.week });
    const data = readWeek(season, week);
    if (!data) throw new Error(`No scores for week ${week} — run \`matchups:sync\` first.`);
    const model = loadLatest();
    const q = positional.join(' ').toLowerCase();
    for (const l of model.leagues) {
      if (q && !(l.nickname || '').toLowerCase().includes(q)) continue;
      const m = data.leagues[l.key];
      console.log(`\n=== ${l.nickname} (${l.host}) week ${week} ===`);
      if (!m?.ok) { console.log(`  ${m?.error || 'not synced'}`); continue; }
      for (const x of m.matchups) {
        const [a, b] = x.sides;
        const state = isFinal(x) ? 'FINAL' : (x.isPreGame ? 'pre' : `${x.minutesLeft ?? '?'}m left`);
        const fmt1 = (s) => `${(s?.name || '—').slice(0, 26).padEnd(27)}${String((s?.points ?? 0).toFixed(2)).padStart(7)}`;
        console.log(`  ${state.padEnd(9)} ${fmt1(a)}   ${fmt1(b)}`);
      }
    }
    console.log(`\n  weeks stored: ${storedWeeks(season).join(', ') || 'none'}`);
  },

  async 'buzz:sync'() {
    await buzzSync({ season: opt('season'), week: opt('week'), days: opt('days') || 2, date: opt('date') });
  },

  /** Yahoo's board for one day, printed. No sync, no files. */
  async buzz() {
    const date = opt('date') || recentDates(1)[0];
    const day = await fetchDay({ date });
    const rows = day.players.slice(0, Number(opt('limit') || 30));
    console.log(`Yahoo BuzzIndex ${date} — ${day.players.length} players\n`);
    console.log('    ADDS   DROPS     NET  ROS%  PLAYER                    POS TM');
    for (const p of rows) {
      console.log(
        `  ${String(p.adds ?? '-').padStart(6)}  ${String(p.drops ?? '-').padStart(6)}  ${String(p.net ?? '-').padStart(6)}` +
        `  ${String((p.pctRostered ?? '-') + '%').padStart(4)}  ${(p.name || '').slice(0, 24).padEnd(25)} ${(p.position || '').padEnd(3)} ${p.team || ''}`,
      );
    }
  },

  async 'trend:sync'() {
    await trendSync({ season: opt('season'), week: opt('week') });
  },

  /** Sleeper's trending board, sorted by how fast the rate is accelerating. */
  async trend() {
    const d = await fetchTrending();
    const sortByVelocity = flag('velocity');
    const rows = d.players
      .filter((p) => !sortByVelocity || p.ratio != null)
      .sort((a, b) => (sortByVelocity ? (b.ratio ?? 0) - (a.ratio ?? 0) : (b.addCount ?? 0) - (a.addCount ?? 0)))
      .slice(0, Number(opt('limit') || 30));
    console.log(`Sleeper trending — ${d.players.length} players, windows ${d.windows.join('h/')}h` +
      `, sorted by ${sortByVelocity ? 'acceleration' : 'adds'}\n`);
    console.log('     ADDS/24H   ADDS/HR   SURGE  PLAYER                    POS TM');
    for (const p of rows) {
      console.log(
        `  ${String(p.addCount ?? '-').padStart(9)} ${String(p.recentPerHr ?? '-').padStart(9)} ` +
        `${String(p.ratio != null ? p.ratio + 'x' : (p.fresh ? 'new' : '-')).padStart(7)}  ` +
        `${(p.name || p.sleeperId).slice(0, 24).padEnd(25)} ${(p.position || '').padEnd(3)} ${p.team || ''}`,
      );
    }
  },

  /** What the joined signal looks like for one player, across both boards. */
  async signal() {
    const { season } = resolveWeek({ season: opt('season') ?? config.season });
    const S = loadSignals({ season });
    if (!S.ok) throw new Error('No signal data — run `buzz:sync` and `trend:sync` first.');
    const name = positional.join(' ');
    if (!name) {
      console.log(`buzz ${S.buzzDate}${S.buzzStale ? ' (STALE)' : ''} · trending ${S.trendFetchedAt} · ` +
        `${S.counts.sleeper} Sleeper / ${S.counts.yahoo} Yahoo`);
      return void console.log('\n  signal <player name> [--position RB]');
    }
    const g = S.signalFor({ name, position: opt('position') });
    if (!g) return void console.log(`${name} — not on either board (outside every top 50).`);
    console.log(`${name}\n`);
    console.log(`  heat          ${g.heat}/100`);
    console.log(`  sleeper       ${g.slAdds ?? '-'} adds / ${S.windows[1]}h · ${g.addsPerHr ?? '-'} per hr now · ` +
      `${g.surge != null ? g.surge + 'x prior rate' : (g.fresh ? 'no prior activity' : 'rate unknown')}`);
    console.log(`  yahoo ${g.yDate || '-'}  ${g.yAdds ?? '-'} adds, ${g.yDrops ?? '-'} drops, net ${g.yNet ?? '-'}` +
      `${g.yAddsChange != null ? ` (${g.yAddsChange > 0 ? '+' : ''}${g.yAddsChange} vs prior day)` : ''}`);
    console.log(`  rostered      ${g.yRostered ?? '-'}% of Yahoo leagues, started ${g.yStarted ?? '-'}%`);
    if (g.note) console.log(`  note          ${g.note}`);
  },

  async 'vegas:check'() {
    const info = vegas.tokenInfo();
    if (!info) return void console.log('VEGAS_TOKEN not set or unparseable.');
    console.log(`account:  ${info.email}`);
    console.log(`expires:  ${info.expiresAt.toISOString()} (${info.expired ? 'EXPIRED' : 'valid'})`);
    try {
      const r = await vegas.checkToken();
      console.log(`request:  OK — QB board returned ${r.sample} players`);
    } catch (err) {
      console.log(`request:  ${err.message.split('\n')[0]}`);
    }
  },

  async 'vegas:sync'() {
    const books = opt('bookmaker')?.split(',') || ['Average'];
    await vegas.vegasSync({ season: opt('season'), week: opt('week'), bookmakers: books });
  },

  async 'vegas:dist'() {
    await vegas.vegasDistSync({
      season: opt('season'), week: opt('week'),
      scoring: opt('scoring') || 'PPR', bookmaker: opt('bookmaker') || 'Average', limit: opt('limit'),
    });
  },

  async 'vegas:rankings'() {
    const rows = await vegas.fetchBoard({ board: opt('position')?.toLowerCase() || 'flex', bookmaker: opt('bookmaker') || 'Average' });
    rows.sort((a, b) => (b.points ?? 0) - (a.points ?? 0));
    console.log(`${rows.length} players — ${opt('bookmaker') || 'Average'}\n`);
    console.log('   PTS  PLAYER                     POS TM    RUYD   REYD   REC  TD%   VOLATILITY');
    for (const p of rows.slice(0, Number(opt('limit') || 30))) {
      console.log(
        `  ${String(p.points ?? '-').padStart(5)}  ${(p.name || '').slice(0, 25).padEnd(26)} ${(p.position || '').padEnd(3)} ${(p.team || '').padEnd(4)} ` +
        `${String(Math.round(p.rushingYds ?? 0)).padStart(5)} ${String(Math.round(p.receivingYds ?? 0)).padStart(6)} ` +
        `${String((p.receptions ?? 0).toFixed(1)).padStart(5)} ${String(((p.tdProb ?? 0) * 100).toFixed(0) + '%').padStart(5)}  ${p.volatility || ''}`,
      );
    }
  },

  /** Side-by-side Vegas vs FantasyPros for the whole board. */
  async compare() {
    const { season, week } = resolveWeek({ season: opt('season') ?? config.season, week: opt('week') ?? config.week });
    const idMap = await loadIdMap({ season });
    const m = enrich({ season, week, bookmaker: opt('bookmaker') || 'Average', idMap });
    const partial = flag('include-partial');
    const rows = m.leagues.flatMap((l) => l.teams.flatMap((t) => t.players))
      .filter((p) => p.fp?.vegas?.points != null && p.fp?.weekPoints != null)
      .filter((p) => partial || p.fp.vegas.complete);
    const seen = new Map();
    for (const p of rows) if (!seen.has(p.fpId)) seen.set(p.fpId, p);
    let list = [...seen.values()];
    const pos = opt('position');
    if (pos) list = list.filter((p) => String(p.position).toUpperCase() === pos.toUpperCase());
    const sortKey = flag('by-diff') ? ((p) => Math.abs(p.fp.vegasVsFp ?? 0)) : ((p) => p.fp.vegas.points ?? 0);
    list.sort((a, b) => sortKey(b) - sortKey(a));
    console.log(`Vegas (${m.bookmaker}) vs FantasyPros — week ${m.enrichedWeek}, ${list.length} rostered players`);
    console.log(partial
      ? '  including partially-priced players (points may be TD-probability only)\n'
      : '  fully-priced players only; --include-partial to show the rest\n');
    console.log('  PLAYER                     POS TM    VEGAS    FP    DIFF  FP RK  VOLATILITY');
    for (const p of list.slice(0, Number(opt('limit') || 40))) {
      const d = p.fp.vegasVsFp;
      const flagStr = p.fp.vegas.complete ? '' : ` partial(${p.fp.vegas.missingProps.length})`;
      console.log(
        `  ${(p.name || '').slice(0, 25).padEnd(26)} ${(p.position || '').padEnd(3)} ${(p.team || '').padEnd(4)} ` +
        `${String(p.fp.vegas.points).padStart(6)} ${String(p.fp.weekPoints).padStart(6)} ` +
        `${(d == null ? '-' : (d > 0 ? '+' : '') + d).padStart(7)} ${String(p.fp.weekRank ?? '-').padStart(6)}  ${p.fp.vegas.volatility || ''}${flagStr}`,
      );
    }
  },

  async dashboard() {
    const { out } = await buildDashboard({ season: opt('season'), week: opt('week') });
    console.log(`\nOpen it:  open ${out}`);
  },

  async export() {
    // Prefer the enriched model so the CSVs carry projections/vegas/ids too.
    const enrichedPath = join(DATA, 'enriched.json');
    const model = existsSync(enrichedPath) ? JSON.parse(readFileSync(enrichedPath, 'utf8')) : loadLatest();
    if (!existsSync(enrichedPath)) console.log('(no data/enriched.json — run `enrich` first for projection columns)');
    const { dir, counts } = exportCsv(model);
    console.log(`Wrote CSVs to ${dir}`);
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k}.csv — ${v} rows`);
  },

  async endpoints() {
    console.log('Per-league endpoints (param: key=<league key>)\n');
    for (const [name, ep] of Object.entries(ENDPOINTS)) {
      console.log(`  ${name.padEnd(14)} ${ep.verified ? 'OK  ' : 'thin'} ${ep.path.padEnd(30)} ${ep.note}`);
    }
    console.log('\nAccount endpoint (param: email=<account email>)\n  userLeagues    OK   getUserLeaguesJSON             every league + its key');
  },

  async help() {
    console.log(`ff — FantasyPros MyPlaybook scraper

  leagues                     list every league on the account
  scrape [--league <name>]    pull all endpoints -> data/raw + data/latest.json
         [--limit N] [--all] [--endpoints a,b]
  leagues:on|off <name>       toggle a league in/out of every sync
  leagues:only <name>...      keep only these active
  leagues:all                 reactivate everything
  roster [name]               print resolved rosters from the last scrape
  transactions [name]         print add/drop history from the last scrape
  players [--refresh] [query] build/search the fpId -> player dictionary
  export                      write leagues/rosters/transactions CSVs
  endpoints                   show the discovered API surface

 FantasyPros public API v2 (needs FP_API_KEY):
  fp:check                    validate the API key, show resolved season/week
  fp:sync                     pull players/news/injuries + week & ROS rankings
                              and projections + points -> data/fp/
       [--week N] [--season Y] [--positions QB,RB] [--scoring PPR,HALF]
  fp:rankings  [--position RB] [--scoring PPR] [--week N] [--ros]
  fp:projections [--position RB] [--scoring PPR] [--week N] [--ros]
  fp:injuries  [--week N]
  fp:news      [--limit N] [--category injury|recap|transaction|rumor|breaking]
       fp:sync --source hybrid|scrape|api   (default hybrid: scrape the bulk,
       spend ~3 API calls on players/external-ids + points scored)

 Public-page scraping (NO API key needed):
  fp:scrape                   same dataset from public pages -> data/fp/
       [--week N] [--scoring PPR,HALF] [--positions QB,RB] [--news-pages N]
  scrape:rankings [--position RB] [--scoring PPR] [--ros] [--limit N]
  scrape:news     [--pages N] [--position RB] [--team SF]

 VegasEdgeFantasy (needs VEGAS_TOKEN):
  vegas:check                 validate the session cookie, show expiry
  vegas:sync [--bookmaker A,B] pull QB/RB/WR/TE boards -> data/vegas/
  vegas:dist [--scoring PPR]  per-player floor/ceiling/boom/bust distributions
  vegas:rankings [--position flex|qb|rb|wr|te] [--bookmaker X] [--limit N]

 WinWithOdds (no auth):
  wwo:sync                    weekly proj/floor/ceiling/actuals + season-long

 First Down Studio (no auth):
  fd:sync                     weekly + season projections, joined by Sleeper id

 FanDuel Research / numberFire (no auth):
  fanduel:sync                weekly standard + PPR + rest-of-season

LEAGUE EDITS — your corrections, in data/league-overrides.json
  league [name]               show a league's overrides + team ids
  league:name <league> <name> rename a league
  league:team <league> <id> <name>       rename a team
  league:mine <league> <id> [id...]      which teams are yours (first = primary)
  league:division <league> <id> <name>   assign a team to a division
  league:playoffs <league> --rule R [--teams N] [--wildcards N] [--tiebreak T]
                              how seeds are decided (run with no flags to list rules)
  league:waivers <league> [--type T] [--claim-days N] [--process-day 0-6]
  league:scoring <league> [<Stat> <points> | <Stat> --clear]
  league:import <file.json>   apply a patch exported from the dashboard

PIPELINE
  sync                        every source, skipping whatever is still fresh
  sync --force                ignore freshness, fetch everything
  sync --only buzz,trend      run just these steps
  sync --skip vegas-dist      run everything but these
  sync --max-age 30           override the per-source staleness limit (minutes)
  sync --dry-run              show what would run, fetch nothing
  sync --watch N              keep going, a pass every N minutes. Each pass
                              still honours every source's own TTL, so this is
                              how often we CHECK, not how often we fetch
  status                      per-source age, the site's own update time, and
                              whether the site moved between our last two pulls
  status --weeks              + per-week recompute times for Sleeper projections

WEEK-BY-WEEK PROJECTIONS — the only source that publishes one per week
  sleeper:proj                live week always; rest of season when it is stale
       [--full]               force all 18 weeks
       [--week N]             that week only
  proj <player> [--scoring PPR] [--from N]
                              a player's week-by-week curve, and every source's
                              rest-of-season total spread across it
  proj:ages                   when the site last recomputed each week

LEAGUE-WIDE SCORES — works on ESPN and Yahoo, not just Sleeper
  matchups:sync               every matchup in every league -> data/scores/
  matchups [league]           this week's board, printed

DEMAND SIGNALS — who the rest of fantasy football is adding, right now
  buzz:sync [--days N] [--date YYYY-MM-DD]   Yahoo BuzzIndex -> data/buzz/
  buzz  [--date YYYY-MM-DD] [--limit N]      one day's board, printed
  trend:sync                                 Sleeper trending -> data/trend/
  trend [--velocity] [--limit N]             live adds, or adds acceleration
  signal <player name> [--position RB]       both boards for one player
  compare [--position RB] [--by-diff] [--bookmaker X]
                              Vegas vs FantasyPros side by side

 Dashboard:
  dashboard                   build dist/dashboard.html (league switcher + pages)

 Joined views:
  enrich                      join FP data onto rosters -> data/enriched.json
  lineup [league]             your team w/ week + ROS projections, ranks, injuries
`);
  },
};

// Own-property only: `ff constructor` otherwise resolved to Object's and died
// with a TypeError from the prototype chain instead of naming the mistake.
const known = Object.hasOwn(commands, cmd || '');
if (cmd && cmd !== 'help' && !known) {
  console.error(`Unknown command: ${cmd}\n`);
  await commands.help();
  process.exit(1);
}
const fn = known ? commands[cmd] : commands.help;
fn().catch((err) => { console.error(`\nError: ${err.message}`); process.exit(1); });
