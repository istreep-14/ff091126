import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, FPDIR, VEGASDIR } from './config.js';
import { nameKey } from './sleeper.js';
import { LEAGUE_SCORING_TO_API } from './fpapi.js';
import { resolve as resolveWeek } from './week.js';
import { loadSignals } from './signals.js';

/**
 * Joins the FantasyPros universal dataset onto the scraped league rosters, so
 * every rostered player carries this week's rank/projection, its rest-of-season
 * rank/projection, and current injury status.
 *
 * Degrades cleanly: whatever slice of data/fp/ exists gets joined, the rest is null.
 */

const POINTS_KEY = { PPR: 'points_ppr', HALF: 'points_half', STD: 'points' };

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

function readDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(join(dir, f))).filter(Boolean);
}

/**
 * fpId -> rank for one scoring format.
 *
 * Also carries `points` from `r2p_pts` when present: the public ranking boards
 * embed projected points directly, so a scraped sync needs no separate
 * projections file. The API sync leaves r2p_pts absent and supplies projections
 * separately; both paths are handled.
 */
function rankIndex(dir) {
  const idx = new Map();
  for (const board of readDir(dir)) {
    for (const p of board.players || []) {
      const id = Number(p.player_id);
      const prev = idx.get(id);
      // Positional boards don't overlap, but guard anyway: keep the better rank.
      if (!prev || Number(p.rank_ecr) < prev.rank) {
        idx.set(id, {
          rank: Number(p.rank_ecr),
          tier: p.tier ?? null,
          position: p.player_position_id,
          points: p.r2p_pts != null && p.r2p_pts !== '' ? Number(p.r2p_pts) : null,
          posRank: p.pos_rank ?? null,
          startSitGrade: p.start_sit_grade ?? null,
          tag: p.tag ?? null,
          opponent: p.player_opponent ?? null,
          rankMin: p.rank_min != null ? Number(p.rank_min) : null,
          rankMax: p.rank_max != null ? Number(p.rank_max) : null,
          rankAve: p.rank_ave != null ? Number(p.rank_ave) : null,
          rankStd: p.rank_std != null ? Number(p.rank_std) : null,
          owned: p.player_owned_avg ?? null,
          note: p.note ?? null,
        });
      }
    }
  }
  return idx;
}

/** fpId -> projection stat block. */
function projIndex(dir) {
  const idx = new Map();
  for (const board of readDir(dir)) {
    for (const p of board.players || []) {
      const stats = Array.isArray(p.stats) ? p.stats[0] : p.stats;
      idx.set(Number(p.fpid), { name: p.name, team: p.team_id, position: p.position_id, stats: stats || {} });
    }
  }
  return idx;
}

function injuryIndex(weekDir) {
  const idx = new Map();
  const data = readJson(join(weekDir, 'injuries.json'));
  for (const i of data?.injuries || data?.players || []) {
    const id = Number(i.player_id ?? i.fpid);
    if (id) idx.set(id, { status: i.status ?? null, type: i.injury_type ?? null, comment: i.comment ?? null, updated: i.injury_update_date ?? null });
  }
  return idx;
}

/** fpId -> actual fantasy points scored so far (API only; no scraped equivalent). */
function pointsIndex(root, scoring) {
  const idx = new Map();
  const data = readJson(join(root, 'points', `${String(scoring).toLowerCase()}.json`));
  for (const p of data?.players || []) {
    idx.set(Number(p.player_id), { games: p.games ?? null, points: p.points ?? null, average: p.average ?? null, weeks: p.weeks ?? null });
  }
  return idx;
}

/** fpId -> host-site player ids (API only). Lets you cross-reference ESPN/Yahoo. */
function externalIdIndex(root) {
  const idx = new Map();
  const data = readJson(join(root, 'players.json'));
  for (const p of data?.players || []) {
    if (!p.espn_id && !p.yahoo_id && !p.cbs_id) continue;
    idx.set(Number(p.player_id), { espn: p.espn_id ?? null, yahoo: p.yahoo_id ?? null, cbs: p.cbs_id ?? null });
  }
  return idx;
}

function newsIndex(root) {
  const idx = new Map();
  const data = readJson(join(root, 'news.json'));
  for (const n of data?.news || data?.items || []) {
    const id = Number(n.fpid ?? n.player_id);
    if (!id) continue;
    if (!idx.has(id)) idx.set(id, []);
    if (idx.get(id).length < 3) idx.get(id).push({ title: n.title || n.headline, date: n.created || n.updated, url: n.url });
  }
  return idx;
}

/** sleeperId -> vegas projection, for one bookmaker. */
function vegasIndex(season, week, bookmaker = 'Average') {
  const idx = new Map();
  const dir = join(VEGASDIR, String(season), `week-${week}`, String(bookmaker).toLowerCase());
  for (const board of readDir(dir)) {
    for (const p of board.players || []) {
      if (!p.sleeperId) continue;
      idx.set(String(p.sleeperId), {
        points: p.points ?? null,
        rushingYds: p.rushingYds ?? null,
        receivingYds: p.receivingYds ?? null,
        receptions: p.receptions ?? null,
        tdProb: p.tdProb ?? null,
        expectedTds: p.expectedTds ?? null,
        volatility: p.volatility ?? null,
        injuryStatus: p.injuryStatus ?? null,
        noOdds: !!p.noOdds,
        missingProps: p.missingProps ?? [],
        complete: p.complete !== false && !p.noOdds && !(p.missingProps ?? []).length,
      });
    }
  }
  return idx;
}

/**
 * VegasEdge distributions, keyed by Sleeper id with a name fallback.
 *
 * Separate from vegasIndex because it is a separate sync with separate
 * coverage: roughly half the board has a market thin enough that the
 * simulation refuses to run, and those players keep a point projection but get
 * no spread.
 */
function vegasDistIndex(season, week, scoring) {
  const sc = String(scoring || 'PPR').toLowerCase();
  const data = readJson(join(VEGASDIR, String(season), `week-${week}`, `distributions-${sc}.json`));
  const byId = new Map(), byName = new Map();
  for (const p of data?.players || []) {
    const rec = {
      proj: p.proj ?? null,
      floor: p.floor ?? null,
      ceiling: p.ceiling ?? null,
      percentiles: p.percentiles ?? null,
      boomPct: p.boomPct ?? null,
      bustPct: p.bustPct ?? null,
      boomThreshold: p.boomThreshold ?? null,
      bustThreshold: p.bustThreshold ?? null,
      volatility: p.volatility ?? null,
      cv: p.cv ?? null,
      booksUsed: p.booksUsed ?? null,
    };
    if (p.sleeperId) byId.set(String(p.sleeperId), rec);
    byName.set(nameKey(p.name, p.position), rec);
  }
  return { byId, byName };
}

/** WinWithOdds, keyed by normalised name+position (the source has no ids). */
function wwoIndex(season, week) {
  const dir = join(DATA, 'wwo', String(season));
  const weekly = readJson(join(dir, `week-${week}.json`));
  const seasonLong = readJson(join(dir, 'season-long.json'));
  const idx = new Map();
  for (const p of weekly?.players || []) {
    idx.set(p.key, { proj: p.proj, ceiling: p.ceiling, floor: p.floor, actual: p.actual });
  }
  for (const p of seasonLong?.players || []) {
    const prev = idx.get(p.key) || {};
    idx.set(p.key, { ...prev, seasonProj: p.seasonProj, delta7d: p.delta7d });
  }
  return idx;
}

/** First Down Studio, keyed by Sleeper id — an exact join, no name matching. */
function firstdownIndex(season, week, scoring) {
  const dir = join(DATA, 'firstdown', String(season));
  const weekly = readJson(join(dir, `week-${week}.json`));
  const seasonRows = readJson(join(dir, 'season.json'));
  const field = { PPR: 'ppr', HALF: 'half', STD: 'std' }[String(scoring || 'PPR').toUpperCase()] || 'ppr';
  const rankField = { PPR: 'pprRank', HALF: 'halfRank', STD: 'stdRank' }[String(scoring || 'PPR').toUpperCase()] || 'pprRank';
  const idx = new Map();
  for (const p of weekly?.players || []) {
    if (!p.sleeperId) continue;
    idx.set(p.sleeperId, {
      proj: p[field] ?? null,
      rank: p[rankField] ?? null,
      opponent: p.opponent ?? null,
      locked: !!p.locked,
      injuryStatus: p.injuryStatus ?? null,
      expectedTds: p.expectedTds ?? null,
    });
  }
  for (const p of seasonRows?.players || []) {
    if (!p.sleeperId) continue;
    const prev = idx.get(p.sleeperId) || {};
    idx.set(p.sleeperId, { ...prev, seasonProj: p[field] ?? null, age: p.age ?? null, isRookie: !!p.isRookie });
  }
  return idx;
}

/**
 * FanDuel / numberFire, keyed by name+position.
 *
 * FanDuel publishes STANDARD and full PPR but no half-PPR set. Half-PPR is
 * exactly the midpoint — standard + 0.5*receptions, PPR being standard + 1.0*
 * receptions — so for HALF leagues the two are averaged. That is an identity,
 * not an approximation.
 */
function fanduelIndex(season, week, scoring) {
  const dir = join(DATA, 'fanduel', String(season));
  const std = readJson(join(dir, `week-${week}-standard.json`));
  const ppr = readJson(join(dir, `week-${week}-ppr.json`));
  const rem = readJson(join(dir, 'remaining.json'));
  const sc = String(scoring || 'PPR').toUpperCase();

  const stdIdx = new Map((std?.players || []).map((p) => [p.key, p]));
  const pprIdx = new Map((ppr?.players || []).map((p) => [p.key, p]));
  const remIdx = new Map((rem?.players || []).map((p) => [p.key, p]));

  const keys = new Set([...stdIdx.keys(), ...pprIdx.keys(), ...remIdx.keys()]);
  const out = new Map();
  for (const k of keys) {
    const S = stdIdx.get(k), P = pprIdx.get(k), R = remIdx.get(k);
    let proj = null, rank = null;
    if (sc === 'PPR') { proj = P?.fantasy ?? S?.fantasy ?? null; rank = P?.positionRank ?? S?.positionRank ?? null; }
    else if (sc === 'STD') { proj = S?.fantasy ?? null; rank = S?.positionRank ?? null; }
    else if (S?.fantasy != null && P?.fantasy != null) { proj = Number(((S.fantasy + P.fantasy) / 2).toFixed(2)); rank = P.positionRank ?? S.positionRank ?? null; }
    else { proj = S?.fantasy ?? P?.fantasy ?? null; rank = S?.positionRank ?? P?.positionRank ?? null; }

    out.set(k, {
      proj,
      posRank: rank,
      overallRank: (P || S)?.overallRank ?? null,
      oppRank: (P || S)?.opponentDefensiveRank ?? (S?.opponentOffensiveRank ?? null),
      seasonProj: R?.fantasy ?? null,
      seasonPosRank: R?.positionRank ?? null,
      halfDerived: sc === 'HALF' && S?.fantasy != null && P?.fantasy != null,
    });
  }
  return out;
}

export function enrich({ season, week, bookmaker = 'Average', idMap = null } = {}) {
  const model = readJson(join(DATA, 'latest.json'));
  if (!model) throw new Error('No data/latest.json — run `npm run scrape` first.');

  const { season: yr, week: wk } = resolveWeek({ season, week });
  const root = join(FPDIR, String(yr));
  const weekDir = join(root, `week-${wk}`);
  const rosDir = join(root, 'ros');

  const have = existsSync(root);
  const weekProj = projIndex(join(weekDir, 'projections'));
  const rosProj = projIndex(join(rosDir, 'projections'));
  const injuries = injuryIndex(weekDir);
  const news = newsIndex(root);
  const externalIds = externalIdIndex(root);
  const vegasBySleeper = vegasIndex(yr, wk, bookmaker);
  const wwo = wwoIndex(yr, wk);
  // Demand-side signal: who the rest of fantasy football is adding, right now.
  const signals = loadSignals({ season: yr });
  const vdistCache = new Map();
  const vdistFor = (scoring) => {
    const sc = LEAGUE_SCORING_TO_API[String(scoring || '').toUpperCase()] || 'PPR';
    if (!vdistCache.has(sc)) vdistCache.set(sc, vegasDistIndex(yr, wk, sc));
    return vdistCache.get(sc);
  };
  const fanduelCache = new Map();
  const fanduelFor = (scoring) => {
    const sc = LEAGUE_SCORING_TO_API[String(scoring || '').toUpperCase()] || 'PPR';
    if (!fanduelCache.has(sc)) fanduelCache.set(sc, fanduelIndex(yr, wk, sc));
    return fanduelCache.get(sc);
  };
  const fdCache = new Map();
  const fdFor = (scoring) => {
    const sc = LEAGUE_SCORING_TO_API[String(scoring || '').toUpperCase()] || 'PPR';
    if (!fdCache.has(sc)) fdCache.set(sc, firstdownIndex(yr, wk, sc));
    return fdCache.get(sc);
  };
  const fpToSleeper = idMap?.fpToSleeper || {};
  const pointsCache = new Map();
  const pointsFor = (scoring) => {
    const sc = LEAGUE_SCORING_TO_API[String(scoring || '').toUpperCase()] || 'PPR';
    if (!pointsCache.has(sc)) pointsCache.set(sc, pointsIndex(root, sc));
    return pointsCache.get(sc);
  };
  const rankCache = new Map();
  const ranksFor = (scoring) => {
    const sc = LEAGUE_SCORING_TO_API[String(scoring || '').toUpperCase()] || 'PPR';
    if (!rankCache.has(sc)) {
      rankCache.set(sc, {
        week: rankIndex(join(weekDir, 'rankings', sc.toLowerCase())),
        ros: rankIndex(join(rosDir, 'rankings', sc.toLowerCase())),
      });
    }
    return rankCache.get(sc);
  };

  for (const league of model.leagues) {
    const ranks = ranksFor(league.scoring);
    const ptsKey = POINTS_KEY[LEAGUE_SCORING_TO_API[String(league.scoring || '').toUpperCase()] || 'PPR'];
    const scored = pointsFor(league.scoring);
    const fd = fdFor(league.scoring);
    const fduel = fanduelFor(league.scoring);
    const vdist = vdistFor(league.scoring);
    for (const team of league.teams) {
      for (const p of team.players) {
        const id = Number(p.fpId);
        const wp = weekProj.get(id);
        const rp = rosProj.get(id);
        const wr = ranks.week.get(id);
        const rr = ranks.ros.get(id);
        p.fp = {
          weekRank: wr?.rank ?? null,
          weekPosRank: wr?.posRank ?? null,
          weekTier: wr?.tier ?? null,
          rosRank: rr?.rank ?? null,
          rosPosRank: rr?.posRank ?? null,
          rosTier: rr?.tier ?? null,
          // Dedicated projections win; ranking-board r2p_pts is the fallback.
          weekPoints: wp?.stats?.[ptsKey] ?? wr?.points ?? null,
          rosPoints: rp?.stats?.[ptsKey] ?? rr?.points ?? null,
          weekStats: wp?.stats ?? null,
          opponent: wr?.opponent ?? null,
          startSitGrade: wr?.startSitGrade ?? null,
          tag: wr?.tag ?? null,
          expertSpread: wr ? { min: wr.rankMin, max: wr.rankMax, ave: wr.rankAve, std: wr.rankStd } : null,
          ownedPct: wr?.owned ?? rr?.owned ?? null,
          note: wr?.note ?? rr?.note ?? null,
          scored: scored.get(id) ?? null,
          externalIds: externalIds.get(id) ?? null,
          sleeperId: fpToSleeper[id]?.sleeperId ?? null,
          thumb: fpToSleeper[id]?.thumb ?? null,
          vegas: fpToSleeper[id] ? vegasBySleeper.get(fpToSleeper[id].sleeperId) ?? null : null,
          injury: injuries.get(id) ?? null,
          news: news.get(id) ?? null,
          wwo: wwo.get(nameKey(p.name, p.position)) ?? null,
          fd: (fpToSleeper[id]?.sleeperId && fd.get(fpToSleeper[id].sleeperId)) || null,
          fanduel: fduel.get(nameKey(p.name, p.position)) ?? null,
          vegasDist: (fpToSleeper[id] && vdist.byId.get(fpToSleeper[id].sleeperId))
            || vdist.byName.get(nameKey(p.name, p.position)) || null,
          signal: signals.signalFor({
            sleeperId: fpToSleeper[id]?.sleeperId,
            yahooId: externalIds.get(id)?.yahoo,
            name: p.name,
            position: p.position,
          }),
        };
      }
    }
  }

  // Vegas vs FantasyPros delta — positive means Vegas is higher.
  for (const l of model.leagues) {
    for (const t of l.teams) {
      for (const p of t.players) {
        const v = p.fp?.vegas?.points;
        const f = p.fp?.weekPoints;
        // Only a fully-priced Vegas line is a meaningful comparison.
        p.fp.vegasVsFp = v != null && f != null && p.fp.vegas.complete ? Number((v - f).toFixed(2)) : null;
        const d = p.fp?.fd;
        if (d) {
          d.vsFp = d.proj != null && f != null ? Number((d.proj - f).toFixed(2)) : null;
          // Season figure is a full-season total, same as WinWithOdds.
          const sp = p.fp?.scored?.points;
          d.rosDerived = d.seasonProj != null ? Number((d.seasonProj - (sp ?? 0)).toFixed(1)) : null;
        }
        const fdl = p.fp?.fanduel;
        if (fdl) {
          fdl.vsFp = fdl.proj != null && f != null ? Number((fdl.proj - f).toFixed(2)) : null;
          const sp2 = p.fp?.scored?.points;
          fdl.rosDerived = fdl.seasonProj != null ? Number((fdl.seasonProj - (sp2 ?? 0)).toFixed(1)) : null;
        }
        const w = p.fp?.wwo;
        if (w) {
          w.wwoVsFp = w.proj != null && f != null ? Number((w.proj - f).toFixed(2)) : null;
          // The season-long figure is a FULL-season total that already includes
          // points scored, so rest-of-season is the remainder, never the total.
          const scoredPts = p.fp?.scored?.points;
          w.rosDerived = w.seasonProj != null
            ? Number((w.seasonProj - (scoredPts ?? 0)).toFixed(1))
            : null;
        }
      }
    }
  }

  model.bookmaker = bookmaker;
  model.signals = { ok: signals.ok, buzzDate: signals.buzzDate, buzzStale: signals.buzzStale, trendFetchedAt: signals.trendFetchedAt, windows: signals.windows, counts: signals.counts };
  model.enrichedAt = new Date().toISOString();
  model.enrichedSeason = yr;
  model.enrichedWeek = wk;
  model.fpDataPresent = have;
  writeFileSync(join(DATA, 'enriched.json'), JSON.stringify(model, null, 2));
  return model;
}
