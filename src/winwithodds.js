import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { get } from './http.js';
import { DATA } from './config.js';
import { nameKey } from './sleeper.js';
import { resolve as resolveWeek } from './week.js';
import { record } from './freshness.js';

/**
 * WinWithOdds — a third projection source, derived from betting markets but
 * published differently from VegasEdge: it ships a FLOOR and CEILING alongside
 * the median projection, plus actual points scored.
 *
 * Data sits in a plain HTML table (the page's `rowData` JS array is empty and
 * filled client-side), so the table is parsed directly. Column ORDER differs
 * between the weekly and season-long pages, so columns are mapped by header
 * name rather than index.
 *
 * There are no player ids anywhere on the page — the join is name + position.
 *
 * Each page also carries its own recompute time in a `rankings-updated-at`
 * block. That is the site's clock, not ours, and it is the only thing that
 * actually says whether a re-fetch would return anything new — so it is parsed
 * and recorded rather than thrown away with the rest of the markup.
 */

const WEEKLY = 'https://www.winwithodds.com/weekly_full_stats';
const SEASON = 'https://www.winwithodds.com/season_long_full_stats';

const clean = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&#039;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

const numOrNull = (v) => {
  if (v == null) return null;
  const t = String(v).replace(/[, ]/g, '').trim();
  if (t === '' || t === '-' || t === '—') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** The site's own "last updated" stamp, as an ISO string, or null. */
export function parseUpdatedAt(html) {
  const m = html.match(/rankings-updated-at[\s\S]{0,200}?<time[^>]*datetime="([^"]+)"/i)
    || html.match(/<time[^>]*datetime="([^"]+)"/i);
  if (!m) return null;
  const d = new Date(m[1]);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Parse the first table on the page into objects keyed by its header labels. */
export function parseStatsTable(html) {
  const tm = html.match(/<table[^>]*>[\s\S]*?<\/table>/);
  if (!tm) return [];
  const t = tm[0];
  const headers = [...t.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => clean(m[1]));
  if (!headers.length) return [];
  const rows = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  const out = [];
  for (const r of rows) {
    const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => clean(m[1]));
    if (!cells.length) continue;
    const rec = {};
    headers.forEach((h, i) => { rec[h] = cells[i] ?? null; });
    out.push(rec);
  }
  return out;
}

const pick = (rec, ...names) => {
  for (const n of names) if (rec[n] !== undefined) return rec[n];
  return null;
};

function shapeWeekly(rec) {
  const name = pick(rec, 'Name');
  const position = pick(rec, 'Position');
  if (!name || !position) return null;
  return {
    name,
    position,
    key: nameKey(name, position),
    proj: numOrNull(pick(rec, 'Projections')),
    ceiling: numOrNull(pick(rec, 'Ceiling')),
    floor: numOrNull(pick(rec, 'Floor')),
    actual: numOrNull(pick(rec, 'Actuals')),
    receptions: numOrNull(pick(rec, 'Receptions')),
    recYds: numOrNull(pick(rec, 'Rec Yards')),
    recTds: numOrNull(pick(rec, 'Rec TDs')),
    rushYds: numOrNull(pick(rec, 'Rush Yards')),
    rushTds: numOrNull(pick(rec, 'Rush TDs')),
    passYds: numOrNull(pick(rec, 'Pass Yards')),
    passTds: numOrNull(pick(rec, 'Pass TDs')),
    ints: numOrNull(pick(rec, 'Ints')),
    fumbles: numOrNull(pick(rec, 'Fumbles')),
  };
}

function shapeSeason(rec) {
  const name = pick(rec, 'Name');
  const position = pick(rec, 'Position');
  if (!name || !position) return null;
  return {
    name,
    position,
    key: nameKey(name, position),
    // NOTE: this is a FULL-SEASON total and already includes points scored to
    // date — it is not a rest-of-season number. ROS is derived in enrich by
    // subtracting actual points scored.
    seasonProj: numOrNull(pick(rec, 'Projections')),
    delta7d: numOrNull(pick(rec, '7-Day Δ', '7-Day Delta')),
    bonusEv: numOrNull(pick(rec, 'Bonus EV')),
    passYds: numOrNull(pick(rec, 'Pass Yards')),
    passTds: numOrNull(pick(rec, 'Pass TDs')),
    rushYds: numOrNull(pick(rec, 'Rush Yards')),
    rushTds: numOrNull(pick(rec, 'Rush TDs')),
    recYds: numOrNull(pick(rec, 'Rec Yards')),
    recTds: numOrNull(pick(rec, 'Rec TDs')),
    receptions: numOrNull(pick(rec, 'Receptions')),
  };
}

export async function fetchWeekly() {
  const html = await get(WEEKLY, { asText: true });
  return { players: parseStatsTable(html).map(shapeWeekly).filter(Boolean), updatedAt: parseUpdatedAt(html) };
}

export async function fetchSeasonLong() {
  const html = await get(SEASON, { asText: true });
  return { players: parseStatsTable(html).map(shapeSeason).filter(Boolean), updatedAt: parseUpdatedAt(html) };
}

export async function wwoSync({ season, week, log = console.log } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season, week });
  log(`WinWithOdds — season ${yr}, week ${wk}`);
  const dir = join(DATA, 'wwo', String(yr));
  mkdirSync(dir, { recursive: true });
  const ok = [], failed = [];
  let sourceAt = null;

  // The two pages are independent; fetching them one after the other doubled
  // the wall time of this sync for no reason.
  const [weekly, seasonRows] = await Promise.allSettled([fetchWeekly(), fetchSeasonLong()]);

  if (weekly.status === 'fulfilled') {
    const { players, updatedAt } = weekly.value;
    writeFileSync(join(dir, `week-${wk}.json`), JSON.stringify({ season: yr, week: wk, source: WEEKLY, updatedAt, players }, null, 2));
    const withActual = players.filter((p) => p.actual != null && p.actual > 0).length;
    log(`  ok   weekly        ${String(players.length).padStart(4)} players, ${withActual} with actual points${updatedAt ? `, site updated ${updatedAt}` : ''}`);
    ok.push('weekly');
    sourceAt = updatedAt;
  } else {
    log(`  FAIL weekly — ${weekly.reason.message}`);
    failed.push({ label: 'weekly', error: weekly.reason.message });
  }

  if (seasonRows.status === 'fulfilled') {
    const { players, updatedAt } = seasonRows.value;
    writeFileSync(join(dir, 'season-long.json'), JSON.stringify({ season: yr, source: SEASON, updatedAt, players }, null, 2));
    log(`  ok   season-long   ${String(players.length).padStart(4)} players`);
    ok.push('season');
    if (!sourceAt) sourceAt = updatedAt;
  } else {
    log(`  FAIL season-long — ${seasonRows.reason.message}`);
    failed.push({ label: 'season', error: seasonRows.reason.message });
  }

  const rep = record('wwo', { ok, failed, sourceAt, season: yr, week: wk,
    items: weekly.status === 'fulfilled' ? weekly.value.players.length : 0 });
  log(`  ${ok.length} ok, ${failed.length} failed -> ${dir}`);
  return rep;
}
