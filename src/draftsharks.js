import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { get, pool } from './http.js';
import { DATA } from './config.js';
import { resolve as resolveWeek } from './week.js';
import { record } from './freshness.js';
import { writeJsonAtomic } from './jsonfile.js';
import { LAST_WEEK } from './sleeperproj.js';
import { scoringsInUse } from './fpsync.js';
import { nameKey } from './sleeper.js';
import { normPos, normTeam, parseMatchup } from './teams.js';

/**
 * Draft Sharks weekly rankings — a second per-week projection, not a curve.
 *
 * Sleeper is the only API in this stack that publishes a number for week 12
 * in September, but that number is whatever Sleeper's nightly batch last
 * wrote. Draft Sharks re-ranks each week independently
 * (`/weekly-rankings/7/ppr` … `/weekly-rankings/18/ppr`) and moves when news
 * moves: a teammate on IR shows up in weeks 2–4 here on the same day, even
 * if Sleeper's week-4 projection has not been touched since last night.
 *
 * The public page SSR-renders the top 25; the rest of the board (250 players)
 * is the same table behind HTMX `GET /weekly-rankings/load-table`. Rest-of-
 * season totals come from `/ros-rankings/load-table`. Last-Modified on the
 * response is the site's own clock.
 *
 * There are no stable cross-site ids. The join is name + position, same as
 * WinWithOdds.
 */

const BASE = 'https://www.draftsharks.com';
const UA_HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  Referer: 'https://www.draftsharks.com/weekly-rankings/ppr',
  'HX-Request': 'true',
};

/** Scoring format -> the slug Draft Sharks puts in the URL and the load-table query. */
export const SCORING_SLUG = { PPR: 'ppr', HALF: 'half-ppr', STD: '' };

const dir = (season) => join(DATA, 'draftsharks', String(season));
const filePath = (season, scoring) => join(dir(season), `${String(scoring).toLowerCase()}.json`);

const numOr = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[%+,]/g, '').trim());
  return Number.isFinite(n) ? n : null;
};

function attr(block, name) {
  const m = block.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return m ? m[1] : null;
}

function cellValue(block, attribute) {
  const re = new RegExp(
    `<(?:td|span)[^>]*data-attribute="${attribute}"[^>]*data-value="([^"]*)"`,
    'i',
  );
  const a = block.match(re);
  if (a) return a[1];
  const re2 = new RegExp(
    `<(?:td|span)[^>]*data-value="([^"]*)"[^>]*data-attribute="${attribute}"`,
    'i',
  );
  const b = block.match(re2);
  return b ? b[1] : null;
}

function teamFrom(block) {
  const name = block.match(/player-details-group__team-name">([^<]+)/);
  if (name) return normTeam(name[1]);
  const alt = block.match(/\/img\/icons\/teams\/([A-Z]{2,3})\.svg/i);
  return alt ? normTeam(alt[1]) : null;
}

/**
 * One player row from a Draft Sharks rankings table.
 *
 * Weekly and ROS boards share the same tbody[data-player-row] wrapper and
 * differ only in which `data-attribute` cells they fill, so one parser
 * covers both: missing cells are null rather than zero.
 */
export function parsePlayerBlock(block) {
  const name = attr(block, 'data-player-name');
  const position = normPos(attr(block, 'data-fantasy-position'));
  if (!name || !position) return null;
  const matchupRaw = cellValue(block, 'matchup');
  const matchup = parseMatchup(matchupRaw);
  const sosRaw = cellValue(block, 'strength_of_schedule');
  const rankText = block.match(/rank-index[^>]*>\s*<span>(\d+)<\/span>/i);
  return {
    id: attr(block, 'data-key'),
    name,
    position,
    team: teamFrom(block),
    rank: rankText ? Number(rankText[1]) : numOr(attr(block, 'data-tier-overall')),
    posRank: numOr(attr(block, 'data-tier-positional')),
    matchup: matchupRaw,
    opp: matchup.bye ? null : matchup.opp,
    home: matchup.home,
    bye: matchup.bye || numOr(cellValue(block, 'player.team.bye')),
    sos: sosRaw != null ? numOr(String(sosRaw).replace('%', '')) : null,
    // Weekly board.
    proj: numOr(cellValue(block, 'weeklyPts')),
    d3: numOr(cellValue(block, 'weekly3dPts')),
    floor: numOr(cellValue(block, 'weeklyFloorPts')),
    ceiling: numOr(cellValue(block, 'weeklyCeilingPts')),
    consensus: numOr(cellValue(block, 'consensus_projection')),
    // ROS / season boards. rosWeeklyPts is a per-week average of the remainder;
    // fantasy_points is a season (or rest-of-season) total.
    rosWeekly: numOr(cellValue(block, 'rosWeeklyPts')),
    rosFloor: numOr(cellValue(block, 'rosWeeklyFloorPts') || cellValue(block, 'floor_points')),
    rosCeiling: numOr(cellValue(block, 'rosWeeklyCeilingPts') || cellValue(block, 'ceiling_points')),
    rosTotal: numOr(cellValue(block, 'fantasy_points')),
  };
}

export function parseRankingsTable(html) {
  const blocks = html.split(/<tbody\b/i).slice(1);
  const players = [];
  for (const raw of blocks) {
    const body = raw.includes('data-player-row') ? raw : null;
    if (!body) continue;
    const rec = parsePlayerBlock(body);
    if (rec) players.push(rec);
  }
  return players;
}

function loadUrl(kind, { week, scoring } = {}) {
  const slug = SCORING_SLUG[String(scoring || 'PPR').toUpperCase()];
  const q = new URLSearchParams();
  if (slug) q.set('pprSuperflexSlug', slug);
  if (kind === 'week') {
    q.set('week', String(week));
    return `${BASE}/weekly-rankings/load-table?${q}`;
  }
  return `${BASE}/ros-rankings/load-table?${q}`;
}

/** Draft Sharks sometimes sends `Last-Modified: 01 Jan 2000`, which is not a clock. */
function plausibleSourceAt(lm) {
  if (!lm) return null;
  const d = new Date(lm);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2015) return null;
  return d.toISOString();
}

async function fetchTable(url) {
  const res = await get(url, { asText: true, withHeaders: true, headers: UA_HEADERS });
  const html = res.body;
  const players = parseRankingsTable(html);
  if (!players.length) throw new Error(`no player rows at ${url}`);
  const lm = res.headers?.['last-modified'];
  const sourceAt = plausibleSourceAt(lm);
  return { players, sourceAt, etag: res.headers?.etag ?? null };
}

export function readDraftSharks(season, scoring = 'PPR') {
  const p = filePath(season, scoring);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** nameKey -> player record in the stored season file. */
export function playerByKey(store, name, position) {
  if (!store) return null;
  const pos = normPos(position);
  return store.players?.[nameKey(name, pos)]
    || store.players?.[nameKey(name, position)]
    || null;
}

const empty = (season, scoring) => ({ season, scoring, fetchedAt: null, weeks: {}, ros: null, players: {} });

function upsertPlayer(store, rec, { week = null, ros = false } = {}) {
  const key = nameKey(rec.name, rec.position);
  const prev = store.players[key] || { n: rec.name, p: rec.position, t: rec.team, id: rec.id, w: {} };
  prev.n = rec.name;
  prev.p = rec.position;
  prev.t = rec.team ?? prev.t;
  prev.id = rec.id ?? prev.id;
  if (week != null) {
    prev.w[week] = {
      proj: rec.proj,
      d3: rec.d3,
      floor: rec.floor,
      ceiling: rec.ceiling,
      consensus: rec.consensus,
      opp: rec.opp,
      home: rec.home,
      sos: rec.sos,
      rank: rec.rank,
      bye: rec.bye === true || rec.bye === week,
    };
  }
  if (ros) {
    prev.ros = {
      proj: rec.rosTotal ?? null,
      weekly: rec.rosWeekly,
      floor: rec.rosFloor,
      ceiling: rec.rosCeiling,
      consensus: rec.consensus,
      sos: rec.sos,
      rank: rec.rank,
    };
  }
  store.players[key] = prev;
}

/**
 * Fetch some or all weeks (and the ROS board) for one scoring format.
 *
 * Same merge-not-replace contract as Sleeper projections: the live week can
 * be re-pulled on its own without discarding week 12, which is the point of
 * having a source that moves when news moves.
 */
export async function dsSync({ season, week, weeks = null, scoring = null, ros = true, log = console.log, formats = null } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season, week });
  const wantWeeks = (weeks && weeks.length ? weeks : Array.from({ length: LAST_WEEK }, (_, i) => i + 1))
    .map(Number).filter((w) => w >= 1 && w <= LAST_WEEK);
  const scorings = formats || (scoring ? [String(scoring).toUpperCase()] : scoringsInUse());

  log(`Draft Sharks — season ${yr}, week ${wk}; ${scorings.join('/')} ; `
    + `${wantWeeks.length === 1 ? `week ${wantWeeks[0]}` : `weeks ${wantWeeks[0]}–${wantWeeks[wantWeeks.length - 1]}`}`
    + (ros ? ' + ROS' : ''));

  const ok = [], failed = [];
  let newest = null, items = 0;

  for (const sc of scorings) {
    const store = readDraftSharks(yr, sc) || empty(yr, sc);
    const jobs = wantWeeks.map((w) => ({ kind: 'week', week: w, scoring: sc }));
    if (ros) jobs.push({ kind: 'ros', scoring: sc });

    const results = await pool(jobs, async (job) => {
      const url = loadUrl(job.kind, job);
      try {
        const r = await fetchTable(url);
        return { ...job, ...r };
      } catch (err) {
        const label = job.kind === 'ros' ? `${sc} ROS` : `${sc} wk${job.week}`;
        log(`  FAIL ${label} — ${err.message.split('\n')[0]}`);
        failed.push({ label, error: err.message });
        return null;
      }
    }, { concurrency: 2 });

    const now = new Date().toISOString();
    for (const r of results) {
      if (!r) continue;
      if (r.kind === 'week') {
        for (const p of Object.values(store.players)) delete p.w[r.week];
        for (const p of r.players) upsertPlayer(store, p, { week: r.week });
        store.weeks[r.week] = { sourceAt: r.sourceAt, etag: r.etag, players: r.players.length, fetchedAt: now };
        ok.push(`${sc} week ${r.week} (${r.players.length})`);
        log(`  ok   ${sc.padEnd(4)} wk${String(r.week).padStart(2)} ${String(r.players.length).padStart(3)} players`
          + (r.sourceAt ? `  site ${r.sourceAt}` : ''));
      } else {
        for (const p of r.players) upsertPlayer(store, p, { ros: true });
        store.ros = { sourceAt: r.sourceAt, etag: r.etag, players: r.players.length, fetchedAt: now };
        ok.push(`${sc} ROS (${r.players.length})`);
        log(`  ok   ${sc.padEnd(4)} ROS  ${String(r.players.length).padStart(3)} players`
          + (r.sourceAt ? `  site ${r.sourceAt}` : ''));
      }
      if (r.sourceAt && (!newest || r.sourceAt > newest)) newest = r.sourceAt;
    }
    store.fetchedAt = now;
    store.scoring = sc;
    mkdirSync(dir(yr), { recursive: true });
    writeJsonAtomic(filePath(yr, sc), store, { indent: 0 });
    items += Object.keys(store.players).length;
  }

  const rep = record('draftsharks', {
    ok, failed, sourceAt: newest, season: yr, week: wk,
    items, note: `${scorings.join(', ')} · ${wantWeeks.length} week(s)${ros ? ' + ROS' : ''}`,
  });
  log(`  ${ok.length} ok, ${failed.length} failed`);
  return rep;
}

const FULL_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Live week (and ROS) every time; the other seventeen weeks when the file is
 * incomplete or the nightly-scale refresh has since come due.
 *
 * Draft Sharks is the source that is supposed to move when news moves, so the
 * current week is cheap to re-ask and the rest of the season is not left to
 * rot for a week.
 */
export async function dsSyncAuto({ season, week, log = console.log } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season, week });
  const formats = scoringsInUse();
  const sample = readDraftSharks(yr, formats[0] || 'PPR');
  const complete = sample && Array.from({ length: LAST_WEEK }, (_, i) => i + 1).every((w) => sample.weeks?.[w]);
  const fullAge = sample?.fetchedAt && sample.weeks?.[LAST_WEEK]?.fetchedAt
    ? Date.now() - new Date(sample.weeks[LAST_WEEK].fetchedAt).getTime()
    : Infinity;
  const wantFull = !complete || fullAge >= FULL_MAX_AGE_MS;
  // News that changes week 4 but not week 1 is the reason this source exists.
  // Re-ask the next three remaining weeks on the short cadence, not only Sunday.
  const lookahead = [];
  for (let w = Math.max(1, wk); w <= Math.min(LAST_WEEK, wk + 2); w++) lookahead.push(w);
  if (!wantFull) log(`  (rest of season pulled ${Math.round(fullAge / 60000)}m ago — weeks ${lookahead.join(', ')} + ROS)`);
  return dsSync({
    season: yr, week: wk, log, formats,
    weeks: wantFull ? null : lookahead,
    ros: true,
  });
}

/** Per-week report, newest week first-ish, for the freshness strip. */
export function dsWeekReport(season, scoring = 'PPR') {
  const store = readDraftSharks(season, scoring);
  if (!store) return [];
  const rows = Object.entries(store.weeks || {})
    .map(([week, w]) => ({ week: Number(week), sourceAt: w.sourceAt, fetchedAt: w.fetchedAt, players: w.players }));
  if (store.ros) rows.push({ week: 'ros', sourceAt: store.ros.sourceAt, fetchedAt: store.ros.fetchedAt, players: store.ros.players });
  return rows.sort((a, b) => String(a.week).localeCompare(String(b.week), undefined, { numeric: true }));
}
