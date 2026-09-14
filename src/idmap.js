import { readFileSync, existsSync, readdirSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FPDIR, CACHE } from './config.js';
import { loadSleeper, nameKey, thumbUrl } from './sleeper.js';
import { record } from './freshness.js';

/**
 * Bridges the three id spaces in play:
 *
 *   FantasyPros fpId  <- MyPlaybook rosters, FP rankings/projections
 *   Sleeper id        <- VegasEdge projections, sleepercdn headshots
 *   ESPN / Yahoo id   <- host sites, via the FP players endpoint
 *
 * Matching is tried strongest-first: espn id, then yahoo id, then normalised
 * name + position. Measured on the week-1 Vegas board: 74 by espn id, 329 by
 * name, 6 unmatched (players absent from FantasyPros entirely).
 *
 * The map is CACHED WITH A TTL, not just per season. Keyed on season alone it
 * never rebuilt inside a season, so any player who first appeared on an FP
 * board mid-week — precisely the waiver-relevant ones — had no Sleeper id, and
 * every join keyed on it (Vegas projection, First Down, headshot, trending)
 * silently returned nothing for them. A stale map is not a stale number here;
 * it is a missing row.
 */

const MAP_PATH = join(CACHE, 'idmap.json');
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

function collectFpPlayers(season) {
  const root = join(FPDIR, String(season));
  const out = new Map(); // fpId -> {name, position, espnId, yahooId}

  // Ranking boards: broadest name coverage.
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      try {
        for (const pl of JSON.parse(readFileSync(p, 'utf8')).players || []) {
          if (!pl.player_id) continue;
          const prev = out.get(pl.player_id) || {};
          out.set(pl.player_id, {
            ...prev,
            name: prev.name || pl.player_name,
            position: prev.position || pl.player_position_id,
            team: prev.team || pl.player_team_id,
          });
        }
      } catch { /* skip unreadable board */ }
    }
  };
  walk(root);

  // players.json carries the host-site ids when the API supplied it.
  const pj = join(root, 'players.json');
  if (existsSync(pj)) {
    try {
      for (const p of JSON.parse(readFileSync(pj, 'utf8')).players || []) {
        const prev = out.get(p.player_id) || {};
        out.set(p.player_id, {
          ...prev,
          name: prev.name || p.player_name,
          position: prev.position || p.position_id,
          team: prev.team || p.team_id,
          espnId: p.espn_id != null ? String(p.espn_id) : prev.espnId,
          yahooId: p.yahoo_id != null ? String(p.yahoo_id) : prev.yahooId,
        });
      }
    } catch { /* ignore */ }
  }
  return out;
}

export async function buildIdMap({ season, refresh = false } = {}) {
  const sleeper = await loadSleeper({ refresh });
  const fp = collectFpPlayers(season);

  const sleeperByEspn = new Map();
  const sleeperByYahoo = new Map();
  const sleeperByName = new Map();
  for (const p of Object.values(sleeper.players)) {
    if (p.espnId) sleeperByEspn.set(p.espnId, p.sleeperId);
    if (p.yahooId) sleeperByYahoo.set(p.yahooId, p.sleeperId);
    if (p.name) {
      const k = nameKey(p.name, p.position);
      // Prefer an active roster player when names collide.
      if (!sleeperByName.has(k) || (p.team && p.status === 'Active')) sleeperByName.set(k, p.sleeperId);
    }
  }

  const fpToSleeper = {};
  const stats = { espn: 0, yahoo: 0, name: 0, unmatched: 0 };
  for (const [fpId, p] of fp) {
    let sid = null;
    let how = null;
    if (p.espnId && sleeperByEspn.has(p.espnId)) { sid = sleeperByEspn.get(p.espnId); how = 'espn'; }
    else if (p.yahooId && sleeperByYahoo.has(p.yahooId)) { sid = sleeperByYahoo.get(p.yahooId); how = 'yahoo'; }
    else if (p.name) {
      const k = nameKey(p.name, p.position);
      if (sleeperByName.has(k)) { sid = sleeperByName.get(k); how = 'name'; }
    }
    if (sid) { fpToSleeper[fpId] = { sleeperId: sid, via: how, thumb: thumbUrl(sid) }; stats[how]++; }
    else stats.unmatched++;
  }

  const sleeperToFp = {};
  for (const [fpId, v] of Object.entries(fpToSleeper)) sleeperToFp[v.sleeperId] = Number(fpId);

  const map = { builtAt: new Date().toISOString(), season, stats, fpCount: fp.size, fpToSleeper, sleeperToFp };
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(MAP_PATH, JSON.stringify(map));
  record('idmap', { ok: [`${Object.keys(fpToSleeper).length} matched`], season,
    items: fp.size, note: `${stats.unmatched} unmatched (espn ${stats.espn}, yahoo ${stats.yahoo}, name ${stats.name})` });
  return map;
}

export async function loadIdMap({ season, refresh = false } = {}) {
  if (!refresh && existsSync(MAP_PATH)) {
    const m = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
    const fresh = m.builtAt && Date.now() - new Date(m.builtAt).getTime() < MAX_AGE_MS;
    // Rebuild when the FP boards have grown too: a new week's boards add
    // players the cached map has never seen, and that is exactly when a stale
    // map silently drops them.
    const sameSize = m.fpCount == null || m.fpCount >= countFpPlayers(season);
    if (m.season === season && fresh && sameSize) return m;
  }
  return buildIdMap({ season, refresh });
}

/** How many distinct fpIds the boards currently hold. Cheap staleness probe. */
function countFpPlayers(season) {
  try {
    return collectFpPlayers(season).size;
  } catch {
    return 0;
  }
}
