import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { get, pool } from './http.js';
import { VEGASDIR, config } from './config.js';
import { resolve as resolveWeek } from './week.js';
import { record } from './freshness.js';

/**
 * VegasEdgeFantasy — sportsbook-derived projections for the current week.
 *
 * Auth is the `access_token` cookie (a JWT) from a logged-in browser session;
 * there is no public API key. The token expires, so `checkToken` reports that
 * before a sync wastes requests.
 *
 * Players are keyed by SLEEPER player id, which is also what
 * sleepercdn.com uses for headshots — see src/sleeper.js.
 */

const BASE = 'https://vegasedgefantasy.com';

/** Endpoints that return data. K and DST have no Vegas board. */
export const BOARDS = ['qb', 'rb', 'wr', 'te'];

/** Books confirmed to return rows. Others 200 with an empty body. */
export const BOOKMAKERS = ['Average', 'DraftKings', 'FanDuel', 'BetMGM', 'Fanatics'];

export class VegasAuthError extends Error {
  constructor(msg) {
    super(
      `${msg}\n` +
        '  VEGAS_TOKEN is the `access_token` cookie from a logged-in vegasedgefantasy.com session.\n' +
        '  Copy it from DevTools > Application > Cookies and put it in .env. It expires roughly monthly.',
    );
    this.name = 'VegasAuthError';
  }
}

function headers() {
  if (!config.vegasToken) throw new VegasAuthError('VEGAS_TOKEN is not set.');
  return {
    Cookie: `access_token=${config.vegasToken}`,
    Referer: `${BASE}/inseason`,
    Accept: '*/*',
  };
}

/** Decode the JWT payload without verifying — just to report expiry locally. */
export function tokenInfo(token = config.vegasToken) {
  if (!token) return null;
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    return { email: p.email, subject: p.sub, expiresAt: new Date(p.exp * 1000), expired: p.exp * 1000 <= Date.now() };
  } catch {
    return null;
  }
}

export async function fetchBoard({ board = 'flex', bookmaker = 'Average' } = {}) {
  const info = tokenInfo();
  if (info?.expired) throw new VegasAuthError(`VEGAS_TOKEN expired ${info.expiresAt.toISOString().slice(0, 10)}.`);
  const url = `${BASE}/${board}/rankings?bookmaker=${encodeURIComponent(bookmaker)}`;
  let data;
  try {
    data = await get(url, { headers: headers() });
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw new VegasAuthError('VegasEdge rejected the token.');
    throw err;
  }
  if (!Array.isArray(data)) return [];
  return data.map((p) => ({
    sleeperId: String(p.PlayerID),
    name: p.Player,
    position: p.Position,
    team: p.Team,
    points: p.FantasyPoints,
    rushingYds: p.RushingYds ?? null,
    receivingYds: p.ReceivingYds ?? null,
    receptions: p.Receptions ?? null,
    tdProb: p.TD_Prob ?? null,
    expectedTds: p.ExpectedTds ?? null,
    volatility: p.volatility_tag ?? null,
    noOdds: !!p.no_odds,
    missingProps: p.missing_props ?? [],
    missingFromBook: !!p.missing_from_book,
    // A projection is only comparable when every prop priced. Players without a
    // full market get points derived from TD probability alone, which reads as a
    // huge disagreement with FantasyPros when it is really just missing data.
    complete: !p.no_odds && !p.missing_from_book && !(p.missing_props ?? []).length,
    injuryStatus: p.InjuryStatus || null,
    injuryBodyPart: p.InjuryBodyPart || null,
  }));
}

export async function checkToken() {
  const info = tokenInfo();
  const rows = await fetchBoard({ board: 'qb', bookmaker: 'Average' });
  return { ...info, ok: rows.length > 0, sample: rows.length };
}

/** Pull every position board for one bookmaker and write it under data/vegas/. */
export async function vegasSync({ season, week, bookmakers = ['Average'], boards = BOARDS, log = console.log } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season: season ?? config.season, week: week ?? config.week });
  const info = tokenInfo();
  if (info) log(`VegasEdge — ${info.email}, token valid to ${info.expiresAt.toISOString().slice(0, 10)}`);
  log(`  season ${yr}, week ${wk}; books: ${bookmakers.join(', ')}`);

  const dir = join(VEGASDIR, String(yr), `week-${wk}`);
  mkdirSync(dir, { recursive: true });
  const report = { season: yr, week: wk, fetchedAt: new Date().toISOString(), ok: [], failed: [] };

  const jobs = bookmakers.flatMap((bk) => boards.map((b) => ({ bk, b })));
  await pool(jobs, async ({ bk, b }) => {
    try {
      const rows = await fetchBoard({ board: b, bookmaker: bk });
      const bkDir = join(dir, bk.toLowerCase());
      mkdirSync(bkDir, { recursive: true });
      writeFileSync(join(bkDir, `${b}.json`), JSON.stringify({ season: yr, week: wk, bookmaker: bk, board: b, players: rows }, null, 2));
      log(`  ok   ${bk.padEnd(11)} ${b.toUpperCase().padEnd(4)} ${String(rows.length).padStart(4)} players`);
      report.ok.push(`${bk}/${b}`);
    } catch (err) {
      if (err instanceof VegasAuthError) throw err;
      log(`  FAIL ${bk}/${b} — ${err.message}`);
      report.failed.push({ label: `${bk}/${b}`, error: err.message });
    }
  }, { concurrency: 2 });

  // VegasEdge publishes no recompute time and no usable validator (responses
  // are cf-cache-status: DYNAMIC), so there is nothing to compare against but
  // our own clock. Recorded as such rather than left blank.
  record('vegas', { ok: report.ok, failed: report.failed, sourceAt: null, season: yr, week: wk,
    items: report.ok.length, note: 'no site-published update time' });
  log(`\n${report.ok.length} ok, ${report.failed.length} failed -> ${dir}`);
  return report;
}

/* ------------------------------------------------------------- distributions
 *
 * The rankings board publishes a point ESTIMATE only. The same site computes a
 * full distribution behind /player/{name}/boombust — the 10K-sample alt-line
 * simulation the site's boom/bust panel draws — and that is the half worth
 * keeping: WinWithOdds ships floor and ceiling, and without this VegasEdge is
 * the only market source in the stack with no spread at all.
 *
 * The endpoint reweights the sample per request at whatever scoring you pass,
 * so the projection it returns is directly comparable to a league's own
 * numbers, unlike the board's, which uses the account's default scoring.
 *
 * Keyed by NAME, not by id — the only endpoint on the site that is.
 */

/** Scoring parameters, in the shape the endpoint expects. */
export const SCORING_PRESETS = {
  PPR:  { ppr: 1,   pts_per_rush_yd: 0.1, pts_per_rec_yd: 0.1, td_points: 6, pts_per_pass_yd: 0.04, pass_td_points: 4, int_points: -2 },
  HALF: { ppr: 0.5, pts_per_rush_yd: 0.1, pts_per_rec_yd: 0.1, td_points: 6, pts_per_pass_yd: 0.04, pass_td_points: 4, int_points: -2 },
  STD:  { ppr: 0,   pts_per_rush_yd: 0.1, pts_per_rec_yd: 0.1, td_points: 6, pts_per_pass_yd: 0.04, pass_td_points: 4, int_points: -2 },
};

/**
 * One player's distribution. Returns null when the market is too thin to
 * simulate (`data_complete:false`) — a partial distribution is worse than none,
 * for the same reason a partial projection is.
 */
export async function fetchDistribution(name, { scoring = 'PPR' } = {}) {
  const sc = SCORING_PRESETS[String(scoring).toUpperCase()] || SCORING_PRESETS.PPR;
  const q = new URLSearchParams(Object.fromEntries(Object.entries(sc).map(([k, v]) => [k, String(v)])));
  let d;
  try {
    d = await get(`${BASE}/player/${encodeURIComponent(name)}/boombust?${q}`, { headers: headers() });
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw new VegasAuthError('VegasEdge rejected the token.');
    if (err.status === 404) return null;
    throw err;
  }
  if (!d || d.data_complete === false || d.projection == null) return null;
  const pc = d.percentiles || {};
  return {
    name: d.player_name ?? name,
    position: d.position ?? null,
    team: d.team ?? null,
    week: d.week ?? null,
    proj: d.projection ?? null,
    // p10/p90 are the honest floor/ceiling pair: the same span WinWithOdds
    // publishes, so the two sources' ranges are read on one scale.
    floor: pc.p10 ?? null,
    ceiling: pc.p90 ?? null,
    percentiles: { p5: pc.p5 ?? null, p10: pc.p10 ?? null, p25: pc.p25 ?? null, p50: pc.p50 ?? null, p75: pc.p75 ?? null, p90: pc.p90 ?? null, p95: pc.p95 ?? null },
    boomThreshold: d.boom_threshold ?? null,
    bustThreshold: d.bust_threshold ?? null,
    boomPct: d.boom_pct ?? null,
    bustPct: d.bust_pct ?? null,
    volatility: d.tag ?? null,
    cv: d.tag_cv ?? null,
    booksUsed: d.n_books_used ?? null,
  };
}

/**
 * Distributions for every player on the already-synced boards, for one scoring
 * format. Run after `vegasSync`, which is where the name list comes from.
 */
export async function vegasDistSync({ season, week, scoring = 'PPR', bookmaker = 'Average', limit = 0, log = console.log } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season: season ?? config.season, week: week ?? config.week });
  const dir = join(VEGASDIR, String(yr), `week-${wk}`);
  const boardDir = join(dir, String(bookmaker).toLowerCase());
  if (!existsSync(boardDir)) throw new Error(`No boards at ${boardDir} — run \`vegas:sync\` first.`);

  const roster = new Map();
  for (const f of readdirSync(boardDir).filter((x) => x.endsWith('.json'))) {
    for (const p of JSON.parse(readFileSync(join(boardDir, f), 'utf8')).players || []) {
      if (p.name && !roster.has(p.name)) roster.set(p.name, p.sleeperId || null);
    }
  }
  let names = [...roster.keys()];
  if (limit) names = names.slice(0, Number(limit));
  log(`VegasEdge distributions — season ${yr}, week ${wk}, ${scoring} scoring, ${names.length} players`);

  const out = [];
  let missing = 0, failed = 0;
  await pool(names, async (name) => {
    try {
      const d = await fetchDistribution(name, { scoring });
      if (!d) { missing++; return; }
      out.push({ ...d, sleeperId: roster.get(name) });
    } catch (err) {
      if (err instanceof VegasAuthError) throw err;
      failed++;
    }
  }, { concurrency: 4 });

  mkdirSync(dir, { recursive: true });
  const file = join(dir, `distributions-${String(scoring).toLowerCase()}.json`);
  writeFileSync(file, JSON.stringify({ season: yr, week: wk, scoring, bookmaker, fetchedAt: new Date().toISOString(), players: out }, null, 2));
  record('vegas-dist', { ok: [`${scoring} ${out.length} players`], failed: failed ? [{ label: 'boombust', error: `${failed} requests failed` }] : [],
    sourceAt: null, season: yr, week: wk, items: out.length, note: `${missing} markets too thin to simulate` });
  log(`  ok   ${out.length} with a full distribution, ${missing} too thin to simulate${failed ? `, ${failed} failed` : ''}`);
  log(`  -> ${file}`);
  return { file, count: out.length, missing, failed };
}
