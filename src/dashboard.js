import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DATA, FPDIR, ROOT } from './config.js';
import { LEAGUE_SCORING_TO_API } from './fpapi.js';
import { resolve as resolveWeek } from './week.js';
import { fetchLeagueDetail, loadDetailCache, writeDetailCache } from './leaguedata.js';
import { fetchAdvanced } from './mpbadvanced.js';
import { loadIdMap } from './idmap.js';
import { loadSignals } from './signals.js';
import { report as freshnessReport } from './freshness.js';
import { readWeek as readScores, seasonTotals, storedWeeks, completeWeeks, isFinal } from './matchups.js';
import { load as loadOverrides, forLeague, applyToLeague, describeRule, SEED_RULES, TIEBREAK } from './overrides.js';
import { readProjections, playerWeeks, weekReport, SCORING_KEY } from './sleeperproj.js';
import { shapeFor, perWeekEstimates } from './weekshape.js';

/**
 * Builds the compact payload the dashboard runs on.
 *
 * enriched.json is ~2MB, most of it expert `note` prose and raw stat blocks the
 * UI never shows. This strips to what the pages render, and adds a free-agent
 * pool computed from the FP ranking boards minus every rostered player.
 */

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

/** fpId -> Yahoo id, from the FP players dump. Only the API sync supplies it. */
function yahooIdIndex(season) {
  const data = readJson(join(FPDIR, String(season), 'players.json'));
  const idx = new Map();
  for (const p of data?.players || []) if (p.yahoo_id != null) idx.set(p.player_id, String(p.yahoo_id));
  return idx;
}

/** Every player on the FP boards for one scoring format, thinned for transport. */
function buildPool(season, week, scoring, { signals, fpToSleeper = {}, yahooIds = new Map(), sleeperProj = null } = {}) {
  const sc = String(scoring).toLowerCase();
  const out = new Map();
  for (const [scope, dir] of [
    ['week', join(FPDIR, String(season), `week-${week}`, 'rankings', sc)],
    ['ros', join(FPDIR, String(season), 'ros', 'rankings', sc)],
  ]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const board = readJson(join(dir, f));
      for (const p of board?.players || []) {
        const id = p.player_id;
        if (!id) continue;
        const rec = out.get(id) || { i: id, n: p.player_name, t: p.player_team_id, p: p.player_position_id };
        if (scope === 'week') {
          rec.wk = p.r2p_pts != null ? Number(p.r2p_pts) : null;
          rec.rk = p.rank_ecr ?? null;
          rec.pr = p.pos_rank ?? null;
          rec.g = p.start_sit_grade ?? null;
          rec.opp = p.player_opponent ?? null;
          rec.own = p.player_owned_avg ?? null;
          rec.bye = p.player_bye_week ?? null;
        } else {
          rec.ros = p.r2p_pts != null ? Number(p.r2p_pts) : null;
          rec.rosRk = p.rank_ecr ?? null;
        }
        out.set(id, rec);
      }
    }
  }
  // The pool is the waiver board, so it is the one place the demand signal
  // matters most — a free agent with no projection movement but a 20x add rate
  // is the whole reason this data is here.
  for (const rec of out.values()) {
    const sid = fpToSleeper[rec.i]?.sleeperId ?? null;
    rec.s = sid;
    const sig = signals?.signalFor({ sleeperId: sid, yahooId: yahooIds.get(rec.i), name: rec.n, position: rec.p });
    if (sig) rec.sig = slimSignal(sig);

    // The waiver board is where a per-week number earns its keep: a free agent
    // whose only published figure is a season total cannot otherwise be
    // compared against the starter he would replace.
    const weeks = playerWeeks(sleeperProj, sid);
    if (!weeks) continue;
    const shape = shapeFor(weeks, { fromWeek: week, scoring });
    if (!shape) continue;
    const cell = weeks[week] ?? weeks[String(week)];
    rec.slwk = cell?.[SCORING_KEY[scoring] || 'ppr'] ?? null;
    rec.slros = shape.total;
    const est = perWeekEstimates({ fp: rec.ros }, shape, week);
    if (est) rec.rpw = { sh: est.share, src: est.sources, bl: est.blended, bye: est.bye };
  }
  return [...out.values()];
}

/**
 * The signal, thinned for transport. Short keys because this rides on every
 * player in a pool of ~800, twice over.
 */
const slimSignal = (g) => g && {
  h: g.heat ?? null,          // 0-100, better of the two boards' percentiles
  r: g.addsPerHr ?? null,     // Sleeper adds/hr over the short window
  v: g.surge ?? null,         // that rate against the preceding window
  a: g.slAdds ?? null,        // Sleeper adds, long window
  d: g.slDrops ?? null,
  ya: g.yAdds ?? null,        // Yahoo adds for the day
  yd: g.yDrops ?? null,
  yn: g.yNet ?? null,
  yr: g.yRostered ?? null,    // % of Yahoo leagues rostering him
  ys: g.yStarted ?? null,
  yc: g.yAddsChange ?? null,  // adds vs the previous day
  yrc: g.yRosteredChange ?? null,
  dt: g.yDate ?? null,        // which day the Yahoo half is from
  nt: g.note ?? null,         // Yahoo's own game note, e.g. "Final W 28-20 vs Dal"
  hist: g.history ?? null,
};

/**
 * One player, thinned for transport.
 *
 * `lp` is this LEAGUE's actual points for the week, from the host's own
 * scoring, and it is why the argument exists. `pts` beside it is FantasyPros'
 * season total under a generic format — a different number answering a
 * different question, and the one that was previously being shown as though it
 * were the league's.
 */
const slim = (p, leaguePts = null) => {
  const f = p.fp || {};
  const lp = leaguePts ? leaguePts.get(Number(p.fpId)) : null;
  return {
    i: p.fpId,
    n: p.name,
    t: p.team,
    p: p.position,
    bye: p.byeWeek ?? null,
    s: f.sleeperId ?? null,
    wk: f.weekPoints ?? null,
    rk: f.weekRank ?? null,
    pr: f.weekPosRank ?? null,
    ros: f.rosPoints ?? null,
    rosRk: f.rosRank ?? null,
    rosPr: f.rosPosRank ?? null,
    g: f.startSitGrade ?? null,
    opp: f.opponent ?? null,
    own: f.ownedPct ?? null,
    vg: f.vegas?.points ?? null,
    vc: f.vegas?.complete ?? null,
    vol: f.vegas?.volatility ?? null,
    vd: f.vegasVsFp ?? null,
    // VegasEdge's own distribution, so the market column carries a range the
    // same way WinWithOdds does rather than a bare point estimate.
    vdist: f.vegasDist ? {
      floor: f.vegasDist.floor ?? null,
      ceiling: f.vegasDist.ceiling ?? null,
      boom: f.vegasDist.boomPct ?? null,
      bust: f.vegasDist.bustPct ?? null,
      p: f.vegasDist.percentiles ?? null,
    } : null,
    sig: slimSignal(f.signal),
    inj: f.injury?.status ?? f.vegas?.injuryStatus ?? null,
    injT: f.injury?.type ?? null,
    pts: f.scored?.points ?? null,
    // League-scored week actual + the host's live-adjusted projection for him.
    lp: lp ? lp.pts : null,
    lproj: lp ? lp.proj : null,
    lslot: lp ? lp.slot : null,
    lgame: lp ? lp.game : null,
    // WinWithOdds: third projection source, plus this week's actual points.
    wwo: f.wwo ? {
      proj: f.wwo.proj ?? null,
      floor: f.wwo.floor ?? null,
      ceiling: f.wwo.ceiling ?? null,
      actual: f.wwo.actual ?? null,
      seasonProj: f.wwo.seasonProj ?? null,
      rosDerived: f.wwo.rosDerived ?? null,
      vsFp: f.wwo.wwoVsFp ?? null,
    } : null,
    // First Down Studio: fourth source, joined exactly by Sleeper id.
    fd: f.fd ? {
      proj: f.fd.proj ?? null,
      rank: f.fd.rank ?? null,
      seasonProj: f.fd.seasonProj ?? null,
      rosDerived: f.fd.rosDerived ?? null,
      vsFp: f.fd.vsFp ?? null,
      locked: !!f.fd.locked,
    } : null,
    /**
     * Sleeper: the only source with a projection for every week, which is why
     * it carries a curve and the others carry a number.
     *
     * `crv` is the remaining schedule as [week, points] pairs — the shape the
     * per-week estimates below are derived from, so the UI can show the
     * redistribution rather than just its output.
     */
    sl: f.sleeper ? {
      wk: f.sleeper.week ?? null,
      opp: f.sleeper.opponent ?? null,
      bye: !!f.sleeper.bye,
      ros: f.sleeper.rosTotal ?? null,
      left: f.sleeper.weeksLeft ?? null,
      byes: f.sleeper.byeWeeks ?? null,
      crv: f.weekShape ? Object.entries(f.weekShape.points).map(([w, v]) => [Number(w), v]) : null,
    } : null,
    /**
     * Every rest-of-season total on this player, put onto THIS week via the
     * Sleeper curve. `src` is per source, `bl` their mean. Derived, not
     * published — see src/weekshape.js.
     */
    rpw: f.rosPerWeek ? {
      sh: f.rosPerWeek.share,
      src: f.rosPerWeek.sources,
      bl: f.rosPerWeek.blended,
      n: f.rosPerWeek.n,
      bye: !!f.rosPerWeek.bye,
    } : null,
    // FanDuel / numberFire: fifth source, with opponent-strength rank.
    fdl: f.fanduel ? {
      proj: f.fanduel.proj ?? null,
      posRank: f.fanduel.posRank ?? null,
      oppRank: f.fanduel.oppRank ?? null,
      seasonProj: f.fanduel.seasonProj ?? null,
      rosDerived: f.fanduel.rosDerived ?? null,
      vsFp: f.fanduel.vsFp ?? null,
      halfDerived: !!f.fanduel.halfDerived,
    } : null,
  };
};

/**
 * fpId -> this league's own numbers for the week, from the live board.
 *
 * The board is fetched per team, so it covers EVERY roster in the league, not
 * just the two teams in your matchup — which is what lets the roster tables,
 * the scoreboard and the matchup page all read the same league-scored number.
 */
function leaguePointsIndex(leagueScores) {
  const idx = new Map();
  if (!leagueScores?.ok) return idx;
  for (const m of leagueScores.matchups || []) {
    for (const side of m.sides || []) {
      for (const line of [...(side.starters || []), ...(side.bench || [])]) {
        if (line.fpId == null) continue;
        idx.set(Number(line.fpId), {
          pts: line.pts, proj: line.proj, slot: line.slot, game: line.game,
        });
      }
    }
  }
  return idx;
}

/** A lineup slot, thinned the way `slim` thins a player. */
const slimLine = (x) => ({
  slot: x.slot, pos: x.pos, i: x.fpId, n: x.name, t: x.team, opp: x.opp,
  ecr: x.ecr, proj: x.proj, proj0: x.proj0, pts: x.pts,
  game: x.game, score: x.score, clock: x.clock, pre: x.pre, over: x.over,
  min: x.min, inj: x.inj,
});

export async function buildPayload({ season, week, log = console.log } = {}) {
  const model = readJson(join(DATA, 'enriched.json')) || readJson(join(DATA, 'latest.json'));
  if (!model) throw new Error('No data — run `scrape` then `enrich` first.');
  const { season: yr, week: wk } = resolveWeek({ season: season ?? model.enrichedSeason, week: week ?? model.enrichedWeek });

  log(`Building dashboard payload — season ${yr}, week ${wk}`);

  const signals = loadSignals({ season: yr });
  if (signals.ok) {
    log(`  signals — Sleeper ${signals.counts.sleeper} trending, Yahoo buzz ${signals.counts.yahoo} over ${signals.dates.join(', ')}`);
  } else {
    log('  signals — none (run `buzz:sync` and `trend:sync`)');
  }

  // Read the league-detail cache ONCE, not once per league, and let every
  // league answer from it when it is fresh. Building the dashboard used to fire
  // four Sleeper endpoints per league on every run, immediately after `scrape`
  // had pulled the same leagues.
  // Your corrections, applied over the scrape. Done here rather than in
  // normalize so a re-scrape can never clobber them and the dashboard always
  // reflects the current override file without re-scraping.
  const overrides = loadOverrides();

  // This week's live board and the season points ledger. Both come from disk —
  // `matchups:sync` is what fills them, so a dashboard build never fetches
  // scores itself.
  const scores = readScores(yr, wk);
  const totals = seasonTotals(yr, { throughWeek: wk });
  const complete = completeWeeks(yr, { throughWeek: wk });
  const weeksOnDisk = storedWeeks(yr);

  const detailCache = loadDetailCache(yr, wk);
  const refreshedDetail = { ...(detailCache?.leagues || {}) };
  let detailFetched = 0, detailCached = 0;

  const leagues = [];
  for (const l of model.leagues) {
    const ov = forLeague(l.key, overrides);
    const leaguePts = leaguePointsIndex(scores?.leagues?.[l.key]);
    applyToLeague(l, ov);
    log(`  ${(l.host || '').padEnd(8)} ${l.nickname}${l.nicknameScraped ? ` (was "${l.nicknameScraped}")` : ''}`);
    const [detail, adv] = await Promise.all([
      fetchLeagueDetail(l, wk, { season: yr, cache: detailCache }),
      fetchAdvanced(l),
    ]);
    if (detail.cached) detailCached++; else if (detail.supported) { detailFetched++; refreshedDetail[l.key] = detail; }
    const flag = (r) => (r.ok ? 'ok' : (r.inactive ? 'inactive' : 'err'));
    log(`      matchup:${flag(adv.matchup)} standings:${flag(adv.standings)} insights:${flag(adv.insights)}`
      + (detail.cached ? `  detail: cached ${detail.cachedAgeMin ?? '?'}m` : (detail.supported ? '  detail: fetched' : '')));
    leagues.push({
      key: l.key,
      name: l.nickname,
      host: l.host,
      scoring: l.scoring,
      status: l.status,
      leagueId: l.leagueId,
      url: l.url,
      myTeamId: l.myTeamId,
      myTeamName: l.myTeamName,
      rosterSlots: l.rosterSlots,
      /**
       * The league's real scoring table, plus your corrections to it.
       *
       * `scraped` is MyPlaybook's reading of the host's rules; `host` is the
       * host's own table where it publishes one (Sleeper does, and its version
       * is the more complete of the two); `over` is what you set in League
       * Setup. All three are carried separately so a disagreement between them
       * is visible instead of silently resolved.
       */
      scoringSystem: l.scoringSystem || null,
      scoringOverride: ov.scoring || {},
      playoffs: l.playoffs,
      waiverType: l.waiverType,
      faabBudget: l.faabBudget,
      teams: l.teams.map((t) => {
        const tot = totals.get(l.key)?.get(String(t.teamId)) || null;
        return {
          id: t.teamId,
          name: t.name,
          nameScraped: t.nameScraped ?? null,
          logo: t.logo,
          mine: !!t.isMine,
          primary: !!t.isPrimary,
          division: t.division ?? null,
          // Accumulated from the weeks we have actually stored, and only from
          // weeks where every matchup finished. Carried with a week count so
          // the UI never presents a two-week sum as a season.
          totals: tot,
          players: t.players.map((p) => slim(p, leaguePts)),
        };
      }),
      transactions: l.transactions.slice(0, 80),
      // Every matchup in the league this week, for every host — the MyPlaybook
      // matchup endpoint answers per teamId, so ESPN and Yahoo get a full board
      // even though neither exposes one any other way.
      matchups: (() => {
        const m = scores?.leagues?.[l.key];
        if (!m?.ok) return { ok: false, reason: m?.error || 'not synced — run `matchups:sync`' };
        return {
          ok: true,
          week: wk,
          rows: m.matchups.map((x) => ({
            status: x.status, pre: x.isPreGame, final: isFinal(x),
            minutesLeft: x.minutesLeft, winProb: x.winProbability, result: x.result,
            sides: x.sides.map((s) => ({
              id: s.teamId, name: s.name, logo: s.logo,
              pts: s.points, proj: s.projected, proj0: s.projected0,
              // The full lineup for EVERY team, which is what lets the matchup
              // page open any pairing in the league rather than only yours.
              starters: (s.starters || []).map(slimLine),
              bench: (s.bench || []).map(slimLine),
            })),
          })),
        };
      })(),
      divisions: l.divisions || [],
      // The override record itself rides along, so the dashboard's league
      // editor starts from what is on disk rather than from an empty form.
      overrides: {
        nickname: ov.nickname,
        myTeamIds: ov.myTeamIds,
        primaryTeamId: ov.primaryTeamId,
        teams: ov.teams,
        divisions: ov.divisions,
        playoffs: ov.playoffs,
        waivers: ov.waivers,
        scoring: ov.scoring,
        notes: ov.notes,
      },
      // Which weeks are complete for THIS league — the denominator behind any
      // accumulated points total.
      completeWeeks: complete.get(l.key) || [],
      /**
       * Seeding is computed IN THE PAGE, not here.
       *
       * It used to be computed server-side off Sleeper's standings, which meant
       * it silently never ran for ESPN or Yahoo — the two hosts with no detail
       * endpoint — so a rule configured for those leagues did nothing at all.
       * The page already merges records, divisions and live scores from every
       * source into one row set; seeding belongs on those same rows, or the
       * bracket and the table it sits in disagree about who is winning.
       */
      seedRule: ov.playoffs?.rule ? { ...ov.playoffs, describe: describeRule(ov.playoffs) } : null,
      detail: detail.supported
        ? { supported: true, standings: detail.standings.map(({ playerIds, starters, ...rest }) => rest), matchups: detail.matchups, settings: detail.settings }
        : { supported: false, reason: detail.reason },
      // MyPlaybook advanced data — only served for the FantasyPros-active league.
      adv: {
        inactive: adv.inactive,
        matchup: adv.matchup.ok ? adv.matchup : { ok: false, inactive: !!adv.matchup.inactive, error: adv.matchup.error },
        standings: adv.standings.ok ? adv.standings : { ok: false, inactive: !!adv.standings.inactive, error: adv.standings.error },
        insights: adv.insights.ok ? adv.insights : { ok: false, inactive: !!adv.insights.inactive, error: adv.insights.error },
        startSit: adv.startSit.ok ? adv.startSit : { ok: false, inactive: !!adv.startSit.inactive, error: adv.startSit.error },
      },
    });
  }

  if (detailFetched) writeDetailCache(yr, wk, refreshedDetail);
  if (detailCached || detailFetched) log(`  league detail — ${detailCached} from cache, ${detailFetched} fetched`);

  // One pool per scoring format in use; the UI subtracts rostered ids per league.
  const formats = [...new Set(model.leagues.map((l) => LEAGUE_SCORING_TO_API[String(l.scoring || '').toUpperCase()] || 'PPR'))];
  const idMap = await loadIdMap({ season: yr }).catch(() => ({ fpToSleeper: {} }));
  const yahooIds = yahooIdIndex(yr);
  const sleeperProj = readProjections(yr);
  const pools = {};
  for (const sc of formats) pools[sc] = buildPool(yr, wk, sc, { signals, fpToSleeper: idMap.fpToSleeper, yahooIds, sleeperProj });

  const payload = {
    generatedAt: new Date().toISOString(),
    season: yr,
    week: wk,
    bookmaker: model.bookmaker || 'Average',
    leagues,
    pools,
    signals: {
      ok: signals.ok,
      buzzDate: signals.buzzDate,
      buzzStale: signals.buzzStale,
      dates: signals.dates,
      trendFetchedAt: signals.trendFetchedAt,
      windows: signals.windows,
      counts: signals.counts,
    },
    // Per-source ages, so the UI can say how old each number is rather than
    // implying everything on the page was fetched at the same moment. Each row
    // carries both clocks and whether the site republished between our last
    // two pulls — a source fetched a minute ago that has not moved since this
    // morning is the case that looks fine and is not.
    freshness: freshnessReport(),
    // Sleeper recomputes the live week through the day and the rest of the
    // season overnight, so its weeks have genuinely different ages.
    projectionAges: weekReport(yr),
    scoreWeeks: weeksOnDisk,
    // The vocabulary the league editor offers, defined once in overrides.js so
    // the UI and the CLI cannot drift apart on what a rule is called.
    rules: {
      seed: Object.fromEntries(Object.entries(SEED_RULES).map(([k, v]) => [k, v.label])),
      tiebreak: Object.fromEntries(Object.entries(TIEBREAK).map(([k, v]) => [k, v.label])),
    },
  };
  log(`  ${leagues.length} leagues, pools: ${formats.map((f) => `${f}=${pools[f].length}`).join(' ')}`);
  return payload;
}

/** Injects the payload into the HTML shell and writes the standalone file. */
export async function buildDashboard({ season, week, out = join(ROOT, 'dist', 'dashboard.html'), log = console.log } = {}) {
  const payload = await buildPayload({ season, week, log });
  const shell = readFileSync(join(ROOT, 'src', 'dashboard.template.html'), 'utf8');
  // Escape everything that can end a script block or break the parse: `<` for
  // `</script>`, and U+2028/U+2029, which are literal line terminators in JS
  // source but legal inside a JSON string — a player note containing one would
  // produce an unterminated string at parse time.
  const json = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  // A function replacement, because a string one would interpret `$&`, `$'` and
  // `$$` in the payload as substitution patterns — a team named "Money$$" was
  // enough to silently corrupt the JSON and blank the whole page.
  const html = shell.replace('/*__DATA__*/null', () => json);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  log(`\n${out} (${kb} KB)`);
  return { out, payload };
}
