/**
 * NFL team abbreviations are not one namespace.
 *
 * ESPN still says JAX and WSH; Sleeper, FantasyPros and DraftSharks say JAC
 * and WAS. A schedule scrape that cannot join onto a roster is just a list of
 * games, so everything that reads an opponent goes through here first.
 */

const ALIAS = {
  JAX: 'JAC',
  WSH: 'WAS',
  WAS: 'WAS',
  LA: 'LAR',
  STL: 'LAR',
  SD: 'LAC',
  OAK: 'LV',
  GB: 'GB',
};

/** FantasyPros DST vs Sleeper/DraftSharks DEF. */
export function normPos(position) {
  const p = String(position || '').toUpperCase();
  if (p === 'DEF' || p === 'DST' || p === 'D/ST') return 'DST';
  return p || null;
}

export function normTeam(abbr) {
  const t = String(abbr || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!t) return null;
  return ALIAS[t] || t;
}

/** "@IND" / "WAS" / "vs GB" / "at SF" -> { opp, home }. */
export function parseMatchup(raw) {
  const s = String(raw || '').trim();
  if (!s || /^bye$/i.test(s)) return { opp: null, home: null, bye: true };
  const m = s.match(/^@\s*([A-Za-z]{2,3})$/) || s.match(/^(?:at|@)\s+([A-Za-z]{2,3})$/i);
  if (m) return { opp: normTeam(m[1]), home: false, bye: false };
  const vs = s.match(/^(?:vs\.?|v\.?)\s*([A-Za-z]{2,3})$/i);
  if (vs) return { opp: normTeam(vs[1]), home: true, bye: false };
  const plain = s.match(/^([A-Za-z]{2,3})$/);
  if (plain) return { opp: normTeam(plain[1]), home: true, bye: false };
  return { opp: normTeam(s), home: null, bye: false };
}
