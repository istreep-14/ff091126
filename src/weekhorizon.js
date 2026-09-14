import { LAST_WEEK } from './sleeperproj.js';

/**
 * The look-ahead window a projection number is answering.
 *
 * Every player view used to toggle between "this week" and "rest of season".
 * That hid the case the Week by Week page exists for: the next three Sundays
 * are not the same player as the season total, and a teammate landing on IR
 * shows up in weeks 2–4 long before it shows up in a rest-of-season number.
 *
 * Encoded as a short key so it can live in localStorage and the URL:
 *   w-7     week 7
 *   n-3     next 3 remaining weeks (from `now`, skipping nothing — byes still
 *           sit in the window so a three-week look includes a bye if it falls
 *           there)
 *   p       fantasy playoffs, weeks 15–17
 *   ros     rest of season (now through 18)
 *   szn     full season (1 through 18)
 */

export const PLAYOFF_FROM = 15;
export const PLAYOFF_TO = 17;

export function parseHorizon(raw, { now = 1, lastWeek = LAST_WEEK } = {}) {
  const cur = clampWeek(now, lastWeek);
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'ros') return { kind: 'ros', from: cur, to: lastWeek, key: 'ros' };
  if (s === 'szn' || s === 'season') return { kind: 'season', from: 1, to: lastWeek, key: 'szn' };
  if (s === 'p' || s === 'playoffs') {
    const from = Math.max(cur, PLAYOFF_FROM);
    const to = Math.min(lastWeek, PLAYOFF_TO);
    return { kind: 'playoffs', from, to, key: 'p' };
  }
  const week = s.match(/^w-?(\d+)$/) || s.match(/^week-?(\d+)$/);
  if (week) {
    const w = clampWeek(Number(week[1]), lastWeek);
    return { kind: 'week', from: w, to: w, key: `w-${w}` };
  }
  const next = s.match(/^n-?(\d+)$/);
  if (next) {
    const n = Math.max(1, Math.min(lastWeek, Number(next[1])));
    const to = Math.min(lastWeek, cur + n - 1);
    return { kind: 'next', n, from: cur, to, key: `n-${n}` };
  }
  const range = s.match(/^r-?(\d+)-(\d+)$/);
  if (range) {
    let a = clampWeek(Number(range[1]), lastWeek);
    let b = clampWeek(Number(range[2]), lastWeek);
    if (b < a) [a, b] = [b, a];
    return { kind: 'range', from: a, to: b, key: `r-${a}-${b}` };
  }
  return { kind: 'week', from: cur, to: cur, key: `w-${cur}` };
}

export function weeksIn(horizon) {
  if (!horizon) return [];
  const out = [];
  for (let w = horizon.from; w <= horizon.to; w++) out.push(w);
  return out;
}

export function isSingleWeek(horizon) {
  return !!horizon && horizon.from === horizon.to;
}

export function isCurrentWeek(horizon, now) {
  return isSingleWeek(horizon) && horizon.from === Number(now);
}

export function labelHorizon(horizon, { now = 1 } = {}) {
  if (!horizon) return '—';
  if (horizon.kind === 'ros') return now > 1 ? `Weeks ${horizon.from}–${horizon.to}` : 'Rest of season';
  if (horizon.kind === 'season') return 'Full season';
  if (horizon.kind === 'playoffs') return horizon.from > horizon.to ? 'Playoffs (passed)' : `Playoffs (wk ${horizon.from}–${horizon.to})`;
  if (horizon.kind === 'week') return `Week ${horizon.from}`;
  if (horizon.kind === 'next') return horizon.n === 1 ? `Week ${horizon.from}` : `Next ${horizon.n} weeks`;
  if (horizon.kind === 'range') return `Weeks ${horizon.from}–${horizon.to}`;
  return horizon.key;
}

/** Dropdown options for a given "now". */
export function horizonOptions({ now = 1, lastWeek = LAST_WEEK } = {}) {
  const cur = clampWeek(now, lastWeek);
  const opts = [
    { value: `w-${cur}`, label: `Week ${cur} (this week)` },
  ];
  for (const n of [2, 3, 4]) {
    if (cur + n - 1 <= lastWeek) opts.push({ value: `n-${n}`, label: `Next ${n} weeks` });
  }
  if (cur <= PLAYOFF_TO) opts.push({ value: 'p', label: 'Playoffs (15–17)' });
  opts.push({ value: 'ros', label: 'Rest of season' });
  opts.push({ value: 'szn', label: 'Full season' });
  opts.push({ value: '—', label: '—— Weeks ——', disabled: true });
  for (let w = 1; w <= lastWeek; w++) {
    opts.push({ value: `w-${w}`, label: `Week ${w}${w === cur ? ' · now' : ''}` });
  }
  return opts;
}

function clampWeek(w, lastWeek) {
  const n = Number(w);
  if (!Number.isFinite(n)) return 1;
  return Math.min(lastWeek, Math.max(1, Math.round(n)));
}
