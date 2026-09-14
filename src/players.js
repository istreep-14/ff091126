import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { get, pool } from './http.js';
import { CACHE } from './config.js';

const DICT_PATH = join(CACHE, 'players.json');
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // refresh twice a day

/**
 * FantasyPros embeds `ecrData` on its public ranking pages, and its `player_id`
 * is the SAME id MyPlaybook uses as `fpId` on rosters.
 *
 * Each board is stored under its own slot. Ranks are NOT merged across boards:
 * a PPR overall rank, a standard overall rank and a positional rank are three
 * different scales, and collapsing them produces numbers that mean nothing.
 */
const SOURCES = [
  { url: 'https://www.fantasypros.com/nfl/rankings/ppr-cheatsheets.php', slot: 'ppr' },
  { url: 'https://www.fantasypros.com/nfl/rankings/half-point-ppr-cheatsheets.php', slot: 'half' },
  { url: 'https://www.fantasypros.com/nfl/rankings/cheatsheets.php', slot: 'std' },
  { url: 'https://www.fantasypros.com/nfl/rankings/ros-ppr-overall.php', slot: 'rosPpr' },
  { url: 'https://www.fantasypros.com/nfl/rankings/qb.php', slot: 'pos' },
  { url: 'https://www.fantasypros.com/nfl/rankings/ppr-rb.php', slot: 'pos' },
  { url: 'https://www.fantasypros.com/nfl/rankings/ppr-wr.php', slot: 'pos' },
  { url: 'https://www.fantasypros.com/nfl/rankings/ppr-te.php', slot: 'pos' },
  { url: 'https://www.fantasypros.com/nfl/rankings/k.php', slot: 'pos' },
  { url: 'https://www.fantasypros.com/nfl/rankings/dst.php', slot: 'pos' },
];

/** Maps a league's `scoring` value to the overall board that applies to it. */
export const SCORING_SLOT = { PPR: 'ppr', HALF: 'half', STD: 'std', STANDARD: 'std' };

function parseEcr(html) {
  const m = html.match(/var\s+ecrData\s*=\s*(\{.*?\});/s);
  if (!m) return [];
  try {
    return JSON.parse(m[1]).players || [];
  } catch {
    return [];
  }
}

export async function buildDictionary() {
  const pages = await pool(
    SOURCES,
    async (src) => {
      try {
        return { slot: src.slot, players: parseEcr(await get(src.url, { asText: true })) };
      } catch {
        return { slot: src.slot, players: [] };
      }
    },
    { concurrency: 3 },
  );

  const byId = new Map();
  for (const { slot, players } of pages) {
    for (const p of players) {
      if (!p.player_id) continue;
      const rec = byId.get(p.player_id) || { fpId: p.player_id, ranks: {}, tiers: {} };
      // Identity fields: first non-empty value wins.
      rec.name ||= p.player_name;
      rec.team ||= p.player_team_id;
      rec.position ||= p.player_position_id;
      rec.eligibility ||= p.player_eligibility;
      rec.byeWeek ||= p.player_bye_week;
      rec.url ||= p.player_page_url;

      const rank = Number(p.rank_ecr);
      if (Number.isFinite(rank)) {
        // Positional boards overlap (a WR appears only on ppr-wr), so a plain
        // assignment is right; for the rare duplicate keep the better rank.
        rec.ranks[slot] = Math.min(rank, rec.ranks[slot] ?? Infinity);
        if (p.tier != null) rec.tiers[slot] = p.tier;
      }
      byId.set(p.player_id, rec);
    }
  }

  const dict = {
    fetchedAt: new Date().toISOString(),
    count: byId.size,
    slots: ['ppr', 'half', 'std', 'rosPpr', 'pos'],
    players: Object.fromEntries(byId),
  };
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(DICT_PATH, JSON.stringify(dict, null, 2));
  return dict;
}

export async function loadDictionary({ refresh = false } = {}) {
  if (!refresh && existsSync(DICT_PATH)) {
    const dict = JSON.parse(readFileSync(DICT_PATH, 'utf8'));
    if (Date.now() - new Date(dict.fetchedAt).getTime() < MAX_AGE_MS) return dict;
  }
  return buildDictionary();
}

/**
 * Resolve an fpId into a player record.
 * `scoring` selects which overall board `ecrOverall` reports, so the rank always
 * matches the league it is shown in. Unknown ids come back labelled, never dropped.
 */
export function resolve(dict, fpId, scoring = null) {
  const p = dict.players[fpId];
  if (!p) {
    return { fpId, name: `Unknown (fpId ${fpId})`, team: null, position: null, ecrOverall: null, ecrPosition: null, ecrBoard: null, unresolved: true };
  }
  const slot = SCORING_SLOT[String(scoring || '').toUpperCase()] || 'ppr';
  return {
    fpId: p.fpId,
    name: p.name,
    team: p.team,
    position: p.position,
    byeWeek: p.byeWeek,
    ecrOverall: p.ranks[slot] ?? null,
    ecrPosition: p.ranks.pos ?? null,
    ecrRestOfSeason: p.ranks.rosPpr ?? null,
    ecrBoard: slot,
    tier: p.tiers[slot] ?? null,
    url: p.url,
  };
}
