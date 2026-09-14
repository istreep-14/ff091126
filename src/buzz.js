import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { get, pool } from './http.js';
import { DATA } from './config.js';
import { nameKey } from './sleeper.js';
import { resolve as resolveWeek } from './week.js';
import { record } from './freshness.js';

/**
 * Yahoo BuzzIndex — how many managers across ALL Yahoo leagues tried to add,
 * drop or trade each player on a given day.
 *
 * This is the fastest-moving signal available anywhere in the stack. Projection
 * sites republish on their own schedule (hours, sometimes a day); the buzz board
 * moves the moment a game ends or a beat writer posts. A Thursday-night
 * breakout shows up here as tens of thousands of adds before any projection
 * source has re-run, which is exactly the window in which a waiver claim is
 * still cheap.
 *
 * The board is a plain server-rendered HTML table behind no login. It is capped
 * at 50 rows per request, with no pagination, so coverage comes from fanning
 * out over position tabs and sort orders and merging by Yahoo player id:
 *
 *   pos    ALL | QB | RB | WR | TE | K | DEF     (each its own top 50)
 *   sort   BI_A adds | BI_D drops | BI_S total   (each a different top 50)
 *   date   YYYY-MM-DD, one day of transactions
 *
 * `bimtab` (A = available players, ALL = every player) is accepted and passed
 * through but not fanned out over: measured on a full week-1 board the two
 * return identical rows, because a player with enough adds to chart is by
 * definition not widely rostered yet. Whether a player is actually claimable is
 * answered against YOUR league's rosters anyway, not Yahoo's aggregate.
 */

const BASE = 'https://football.fantasysports.yahoo.com/f1/buzzindex';

export const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
export const SORTS = ['BI_A', 'BI_D', 'BI_S'];

const clean = (s) => String(s || '').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;|&#x27;/g, "'")
  .replace(/&quot;/g, '"').replace(/&#x[0-9a-f]+;/gi, '').replace(/&#\d+;/g, '')
  .replace(/\s+/g, ' ').trim();

const int = (v) => {
  const t = String(v ?? '').replace(/[,%\s]/g, '');
  if (!t || t === '-' || t === '—') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** YYYY-MM-DD for a Date, in US Eastern — the day boundary Yahoo counts on. */
export function buzzDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/** The last N calendar days ending today, most recent first. */
export function recentDates(days = 1, from = new Date()) {
  return Array.from({ length: days }, (_, i) => buzzDate(new Date(from.getTime() - i * 86_400_000)));
}

export function url({ date, pos = 'ALL', sort = 'BI_A', bimtab = 'A', src = 'combined', trendtab = 'O' }) {
  const q = new URLSearchParams({ sort, date, src, bimtab, trendtab, pos });
  return `${BASE}?${q}`;
}

/**
 * One row of the buzz table.
 *
 * The player cell is a block of markup, not a string: the id lives in a
 * data attribute, the team and position in a `TM - POS` span, and the injury
 * designation in its own abbreviation element. Each is pulled out by structure
 * rather than by slicing the flattened text, which varies with how many note
 * and video badges Yahoo decided to hang off the name.
 */
export function parseRow(tr) {
  const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
  if (tds.length < 7) return null;
  const cell = tds[0];

  const id = cell.match(/data-ys-playerid="(\d+)"/)?.[1] || null;
  const name = clean(cell.match(/<a[^>]*class="[^"]*\bname\b[^"]*"[^>]*>([\s\S]*?)<\/a>/)?.[1] || '');
  if (!name) return null;

  const tp = clean(cell.match(/<span class="Fz-xxs">([^<]*)<\/span>/)?.[1] || '');
  const [team, position] = tp.split('-').map((s) => s.trim());

  // Injury/status abbreviation, e.g. Q, O, IR, SUSP — rendered in its own span.
  const status = clean(cell.match(/class="[^"]*ysf-player-status[^"]*"[^>]*>([\s\S]*?)<\//)?.[1] || '')
    || clean(cell.match(/<abbr[^>]*title="[^"]*"[^>]*>([\s\S]*?)<\/abbr>/)?.[1] || '') || null;

  const note = clean(cell.match(/class="ysf-player-detail[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] || '') || null;
  const headshot = cell.match(/<img[^>]+src="([^"]+)"/)?.[1] || null;

  const adds = int(clean(tds[4]));
  const drops = int(clean(tds[3]));
  return {
    yahooId: id,
    name,
    team: team || null,
    position: position || null,
    key: nameKey(name, position),
    status: status && status.length <= 5 ? status : null,
    pctRostered: int(clean(tds[1])),
    pctStarted: int(clean(tds[2])),
    drops,
    adds,
    trades: int(clean(tds[5])),
    total: int(clean(tds[6])),
    // Positive means the market is buying. This, not raw adds, is what ranks a
    // waiver board: a player with 30k adds and 28k drops is churn, not a target.
    net: adds != null && drops != null ? adds - drops : null,
    gameNote: note,
    headshot,
  };
}

export function parseBuzz(html) {
  const t = html.match(/<table[^>]*class="[^"]*Tst-table[^"]*"[^>]*>[\s\S]*?<\/table>/)?.[0];
  if (!t) return [];
  return [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) => parseRow(m[1])).filter(Boolean);
}

export async function fetchBoard(params) {
  return parseBuzz(await get(url(params), { asText: true }));
}

/**
 * Every board for one date, merged. A player seen on several boards keeps the
 * highest counts observed — the boards are the same underlying numbers sliced
 * differently, so disagreement is a truncation artefact, never new information.
 */
export async function fetchDay({ date, positions = POSITIONS, sorts = SORTS, bimtab = 'A', log = console.log } = {}) {
  const jobs = positions.flatMap((pos) => sorts.map((sort) => ({ date, pos, sort, bimtab })));
  const merged = new Map();
  let failed = 0;
  await pool(jobs, async (j) => {
    let rows;
    try {
      rows = await fetchBoard(j);
    } catch (err) {
      failed++;
      log(`    FAIL ${j.bimtab}/${j.pos}/${j.sort} — ${err.message.split('\n')[0]}`);
      return;
    }
    for (const r of rows) {
      const k = r.yahooId || r.key;
      const prev = merged.get(k);
      if (!prev) { merged.set(k, { ...r }); continue; }
      for (const f of ['adds', 'drops', 'trades', 'total', 'pctRostered', 'pctStarted']) {
        if (r[f] != null && (prev[f] == null || r[f] > prev[f])) prev[f] = r[f];
      }
      prev.net = prev.adds != null && prev.drops != null ? prev.adds - prev.drops : prev.net;
      if (!prev.status && r.status) prev.status = r.status;
      if (!prev.gameNote && r.gameNote) prev.gameNote = r.gameNote;
    }
  }, { concurrency: 3 });
  const players = [...merged.values()].sort((a, b) => (b.adds ?? 0) - (a.adds ?? 0));
  return { date, players, boards: jobs.length, failed };
}

const dir = (season) => join(DATA, 'buzz', String(season));

export function readDay(season, date) {
  const p = join(dir(season), `${date}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

/** Every stored day for a season, newest first. */
export function storedDates(season) {
  const d = dir(season);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, -5)).sort().reverse();
}

export async function buzzSync({ season, week, days = 2, date = null, log = console.log } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season, week });
  const dates = date ? [date] : recentDates(Number(days) || 1);
  log(`Yahoo BuzzIndex — season ${yr}, week ${wk}; ${dates.length} day(s): ${dates.join(', ')}`);
  mkdirSync(dir(yr), { recursive: true });
  const report = { season: yr, week: wk, fetchedAt: new Date().toISOString(), days: [] };

  for (const d of dates) {
    const day = await fetchDay({ date: d, log });
    writeFileSync(join(dir(yr), `${d}.json`), JSON.stringify({ ...day, season: yr, week: wk, fetchedAt: new Date().toISOString() }, null, 2));
    const top = day.players[0];
    log(`  ok   ${d}  ${String(day.players.length).padStart(4)} players` +
        (top ? ` · top ${top.name} ${top.adds ?? '-'} adds` : '') + (day.failed ? ` · ${day.failed} boards failed` : ''));
    report.days.push({ date: d, players: day.players.length, failed: day.failed });
  }

  // Yahoo's board IS a date, so the newest day fetched is the source clock —
  // the one case in the stack where site time is exactly known.
  const newest = dates[0];
  record('buzz', {
    ok: report.days.map((d) => `${d.date} (${d.players})`),
    failed: report.days.filter((d) => d.failed).map((d) => ({ label: d.date, error: `${d.failed} boards failed` })),
    sourceAt: newest ? new Date(`${newest}T12:00:00Z`).toISOString() : null,
    season: yr, week: wk,
    items: report.days.reduce((a, d) => a + d.players, 0),
    note: `days: ${dates.join(', ')}`,
  });
  log(`  -> ${dir(yr)}`);
  return report;
}
