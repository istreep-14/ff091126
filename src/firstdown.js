import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { get } from './http.js';
import { DATA } from './config.js';
import { resolve as resolveWeek } from './week.js';
import { record } from './freshness.js';

/**
 * First Down Studio — a fourth projection source.
 *
 * It's a Next.js app, so the data ships server-rendered inside the App Router
 * flight payload (`self.__next_f.push`) rather than a JSON endpoint. Both pages
 * are parsed out of that payload.
 *
 * Crucially every row carries a SLEEPER ID, so this joins exactly rather than by
 * name like WinWithOdds.
 *
 * The two pages use different shapes:
 *   /rankings/<pos>         snake_case  snapshot.rows[]  ppr/halfppr/standard + *_erc ranks
 *   /season-rankings/<pos>  camelCase   rows[]           fantasyPointsByScoring{}
 * A single request returns every position, so <pos> only sets the default tab.
 */

const BASE = 'https://www.firstdown.studio';

/** Concatenate the Next.js flight chunks and undo their string escaping. */
function flight(html) {
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)].map((m) => m[1]);
  return chunks.join('')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '')
    .replace(/\\\\/g, '\\');
}

/** Pull a balanced JSON value that begins at `key` within the flight text. */
function balanced(text, key, open) {
  const i = text.indexOf(key);
  if (i < 0) return null;
  const start = i + key.length - 1;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, j + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

const numOr = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Weekly projections, per scoring format, with the site's own positional ranks. */
export async function fetchWeekly({ position = 'QB' } = {}) {
  const html = await get(`${BASE}/rankings/${position}`, { asText: true });
  const snap = balanced(flight(html), '"snapshot":{', '{');
  if (!snap || !Array.isArray(snap.rows)) throw new Error('no snapshot in /rankings payload');
  return {
    season: snap.season ?? null,
    week: snap.week ?? null,
    generatedAt: snap.generated_at ?? null,
    scoringVersion: snap.scoring_version ?? null,
    players: snap.rows.map((r) => ({
      sleeperId: r.sleeper_id != null ? String(r.sleeper_id) : null,
      name: r.name ?? null,
      team: r.team ?? null,
      position: r.position ?? null,
      opponent: r.opponent ?? null,
      kickoffAt: r.kickoff_at ?? null,
      game: r.game_details ?? null,
      locked: !!r.locked,
      injuryStatus: r.injury_status ?? null,
      ppr: numOr(r.ppr),
      half: numOr(r.halfppr),
      std: numOr(r.standard),
      pprRank: numOr(r.ppr_erc),
      halfRank: numOr(r.halfppr_erc),
      stdRank: numOr(r.standard_erc),
      receptions: numOr(r.receptions),
      rushYards: numOr(r.rushing_yards),
      recYards: numOr(r.receiving_yards),
      expectedTds: numOr(r.expected_touchdowns),
      // Which inputs came from betting markets vs the site's own model.
      statSources: r.stat_sources ?? null,
    })),
  };
}

/** Season page is position-scoped (weekly is not), so each is fetched in turn. */
export const SEASON_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K'];

/** Full-season projections. Like WinWithOdds, these are season totals. */
export async function fetchSeason({ position = 'QB' } = {}) {
  const html = await get(`${BASE}/season-rankings/${position}`, { asText: true });
  const rows = balanced(flight(html), '"rows":[', '[');
  if (!Array.isArray(rows)) throw new Error('no rows in /season-rankings payload');
  return {
    players: rows.map((r) => {
      const pts = r.fantasyPointsByScoring || {};
      return {
        sleeperId: r.sleeperId != null ? String(r.sleeperId) : null,
        name: r.displayName ?? null,
        team: r.team ?? null,
        position: r.position ?? null,
        age: numOr(r.age),
        isRookie: !!r.isRookie,
        avatar: r.avatar ?? null,
        ppr: numOr(pts.ppr),
        half: numOr(pts.halfPpr),
        std: numOr(pts.standard),
        passYards: numOr(r.passYards),
        passTds: numOr(r.passTds),
        rushYards: numOr(r.rushYards),
        recYards: numOr(r.recYards),
        receptions: numOr(r.receptions),
        adpPosRank: r.adpPosRank ?? null,
      };
    }),
  };
}

export async function fdSync({ season, week, log = console.log } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season, week });
  const dir = join(DATA, 'firstdown', String(yr));
  mkdirSync(dir, { recursive: true });
  const ok = [], failed = [];
  log(`First Down Studio — season ${yr}, week ${wk}`);

  // The weekly snapshot and all five season boards are independent requests.
  // Running them in sequence made this the slowest sync in the pipeline for no
  // reason other than the order the code was written in.
  const [weekly, ...seasons] = await Promise.allSettled([
    fetchWeekly(),
    ...SEASON_POSITIONS.map((position) => fetchSeason({ position })),
  ]);

  let sourceAt = null, items = 0;
  if (weekly.status === 'fulfilled') {
    writeFileSync(join(dir, `week-${wk}.json`), JSON.stringify(weekly.value, null, 2));
    const pos = weekly.value.players.reduce((a, p) => ((a[p.position] = (a[p.position] || 0) + 1), a), {});
    log(`  ok   weekly   ${String(weekly.value.players.length).padStart(4)} players  ${Object.entries(pos).map(([k, v]) => k + ':' + v).join(' ')}`);
    ok.push('weekly');
    // The snapshot's own generated_at — the site's clock, already parsed and
    // already written to disk, previously never surfaced anywhere.
    sourceAt = weekly.value.generatedAt ?? null;
    items = weekly.value.players.length;
  } else {
    log(`  FAIL weekly — ${weekly.reason.message}`);
    failed.push({ label: 'weekly', error: weekly.reason.message });
  }

  // Unlike the weekly page, the season page only returns the requested position.
  const seasonPlayers = [];
  SEASON_POSITIONS.forEach((pos, i) => {
    const r = seasons[i];
    if (r.status === 'fulfilled') {
      seasonPlayers.push(...r.value.players);
      log(`  ok   season ${pos.padEnd(3)} ${String(r.value.players.length).padStart(4)} players`);
      ok.push('season:' + pos);
    } else {
      log(`  FAIL season ${pos} — ${r.reason.message}`);
      failed.push({ label: 'season:' + pos, error: r.reason.message });
    }
  });
  if (seasonPlayers.length) {
    writeFileSync(join(dir, 'season.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), players: seasonPlayers }, null, 2));
  }

  const rep = record('firstdown', { ok, failed, sourceAt, season: yr, week: wk, items });
  log(`  ${ok.length} ok, ${failed.length} failed${sourceAt ? `, snapshot generated ${sourceAt}` : ''} -> ${dir}`);
  return rep;
}
