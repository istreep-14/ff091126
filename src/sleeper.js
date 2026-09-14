import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { get, NotModified } from './http.js';
import { record, entry } from './freshness.js';
import { CACHE } from './config.js';

/**
 * Sleeper's public player dump — the bridge between VegasEdge (which keys on
 * Sleeper ids) and FantasyPros (which keys on fpIds), and the source of
 * headshot URLs.
 *
 * The dump is ~15MB, so it is cached on disk and refreshed daily. Sleeper asks
 * that it be called at most once per day.
 *
 * Sleeper returns a strong ETag on this endpoint, so past the daily TTL the
 * refresh is a CONDITIONAL request: a 304 costs one round trip and keeps the
 * cache, where an unconditional GET spent 15MB to rediscover the same bytes.
 */

const URL = 'https://api.sleeper.app/v1/players/nfl';
const PATH = join(CACHE, 'sleeper-players.json');
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const thumbUrl = (sleeperId) => `https://sleepercdn.com/content/nfl/players/thumb/${sleeperId}.jpg`;
export const fullUrl = (sleeperId) => `https://sleepercdn.com/content/nfl/players/${sleeperId}.jpg`;

export async function loadSleeper({ refresh = false, log = null } = {}) {
  const cached = existsSync(PATH) ? JSON.parse(readFileSync(PATH, 'utf8')) : null;
  if (!refresh && cached && Date.now() - new Date(cached.fetchedAt).getTime() < MAX_AGE_MS) return cached;

  // Past the TTL, ask whether it changed before paying for it again.
  const known = entry('sleeper-players');
  let res;
  try {
    res = await get(URL, { withHeaders: true, etag: cached && known?.etag ? known.etag : null });
  } catch (err) {
    if (err instanceof NotModified && cached) {
      // Unchanged upstream: keep the bytes, move the clock forward so the TTL
      // does not re-ask on every call for the rest of the day.
      cached.fetchedAt = new Date().toISOString();
      writeFileSync(PATH, JSON.stringify(cached));
      record('sleeper-players', { ok: ['304 not modified'], items: cached.count, note: 'unchanged upstream' });
      log?.('  Sleeper player dump unchanged (304) — cache kept');
      return cached;
    }
    throw err;
  }
  const raw = res.body;
  // Keep only what the joins and the UI need; the full dump is mostly noise.
  const players = {};
  for (const [id, p] of Object.entries(raw)) {
    if (!p || p.sport !== 'nfl') continue;
    players[id] = {
      sleeperId: id,
      name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || null,
      position: p.position || null,
      team: p.team || null,
      status: p.status || null,
      injuryStatus: p.injury_status || null,
      age: p.age ?? null,
      yearsExp: p.years_exp ?? null,
      number: p.number ?? null,
      espnId: p.espn_id != null ? String(p.espn_id) : null,
      yahooId: p.yahoo_id != null ? String(p.yahoo_id) : null,
      rotowireId: p.rotowire_id != null ? String(p.rotowire_id) : null,
      fantasyDataId: p.fantasy_data_id != null ? String(p.fantasy_data_id) : null,
      sportradarId: p.sportradar_id || null,
      thumb: thumbUrl(id),
      image: fullUrl(id),
    };
  }
  const dict = { fetchedAt: new Date().toISOString(), count: Object.keys(players).length, players };
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(PATH, JSON.stringify(dict));
  record('sleeper-players', { ok: ['players'], items: dict.count, etag: res.headers?.etag ?? null });
  return dict;
}

/** Normalised name key for cross-source matching: strips suffixes, punctuation, accents. */
export function nameKey(name, position = '') {
  const n = String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${n}|${String(position || '').toUpperCase()}`;
}
