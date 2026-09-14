import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { STATE } from './config.js';

/**
 * Per-league on/off state, so a 10-league account can sync only what matters.
 *
 * Leagues are ACTIVE BY DEFAULT — a league absent from the state file is
 * treated as active, so discovering a new league never silently skips it.
 * Only explicit deactivations are recorded.
 */

export function loadState() {
  if (!existsSync(STATE)) return { leagues: {} };
  try {
    const s = JSON.parse(readFileSync(STATE, 'utf8'));
    return { leagues: s.leagues || {} };
  } catch {
    return { leagues: {} };
  }
}

export function saveState(state) {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify({ updatedAt: new Date().toISOString(), ...state }, null, 2));
}

export const isActive = (state, key) => state.leagues[key]?.active !== false;

/** Match leagues by key, or by case-insensitive substring of the nickname. */
export function match(leagues, query) {
  if (!query) return [];
  const q = String(query).toLowerCase();
  return leagues.filter((l) => l.key === query || (l.nickname || l.name || '').toLowerCase().includes(q));
}

export function setActive(leagues, query, active) {
  const state = loadState();
  const hits = match(leagues, query);
  for (const l of hits) {
    state.leagues[l.key] = { ...(state.leagues[l.key] || {}), active, nickname: l.nickname || l.name, host: l.host };
  }
  saveState(state);
  return hits;
}

/** Deactivate everything except the matched leagues. */
export function setOnly(leagues, queries) {
  const state = loadState();
  const keep = new Set(queries.flatMap((q) => match(leagues, q)).map((l) => l.key));
  for (const l of leagues) {
    state.leagues[l.key] = {
      ...(state.leagues[l.key] || {}),
      active: keep.has(l.key),
      nickname: l.nickname || l.name,
      host: l.host,
    };
  }
  saveState(state);
  return leagues.filter((l) => keep.has(l.key));
}

/**
 * Apply state + ad-hoc filters to a league list.
 * `all` ignores the active flags; `filter` narrows by name/key; `limit` truncates.
 */
export function applyFilters(leagues, { all = false, filter = null, limit = null } = {}) {
  const state = loadState();
  let out = all ? leagues : leagues.filter((l) => isActive(state, l.key));
  if (filter) {
    out = match(out, filter);
    if (!out.length) throw new Error(`No league matched "${filter}"`);
  }
  if (limit != null && Number(limit) > 0) out = out.slice(0, Number(limit));
  return out;
}
