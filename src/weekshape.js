import { LAST_WEEK, SCORING_KEY } from './sleeperproj.js';

/**
 * Turning a rest-of-season total into a per-week number.
 *
 * Three sources here (WinWithOdds, First Down, FanDuel) publish a full-season
 * total and nothing weekly. `enrich` already derives rest-of-season from that
 * by subtracting the points a player has actually scored, which leaves one
 * number standing for every remaining game at once. That number cannot be put
 * next to a weekly projection, and it cannot answer the only question a lineup
 * decision asks, which is about one specific Sunday.
 *
 * Dividing it by the number of games left would be worse than useless: it
 * would hand a bye week the same value as a divisional game, and it would say
 * a player with a brutal week-12 matchup is worth exactly what he is worth in
 * week 16.
 *
 * Sleeper publishes a projection for every player for every week, so the
 * SHAPE of a season is available even where a source only published its total.
 * Normalising that shape into per-week shares that sum to 1 strips out
 * Sleeper's own opinion about how good the player is — the shares carry
 * schedule, byes and opponent, and no level at all — so multiplying another
 * source's total by them redistributes that source's number without importing
 * Sleeper's. The weekly estimates always add back up to the total they came
 * from.
 *
 * WHAT THIS IS NOT
 *
 * It is not a projection. It is one source's season total, arranged on another
 * source's calendar, and it is labelled `derived` everywhere it appears for
 * that reason. Where a source publishes a real weekly number, that number is
 * always preferred and this is never computed over the top of it.
 */

/**
 * Per-week shares of a player's remaining projected season.
 *
 * Returns null when there is nothing to divide — no weekly data for the
 * player, or every remaining week projecting zero. A null is the honest
 * answer: a flat split would look like knowledge and contain none.
 */
export function shapeFor(weeks, { fromWeek, throughWeek = LAST_WEEK, scoring = 'PPR', byeWeeks = null } = {}) {
  if (!weeks || fromWeek == null) return null;
  const key = SCORING_KEY[String(scoring || '').toUpperCase()] || 'ppr';
  const from = Math.max(1, Number(fromWeek));
  const through = Math.min(LAST_WEEK, Number(throughWeek) || LAST_WEEK);
  if (through < from) return null;

  const points = {};
  const byes = [];
  let total = 0;
  for (let w = from; w <= through; w++) {
    const cell = weeks[w] ?? weeks[String(w)];
    const scheduledBye = Array.isArray(byeWeeks) ? byeWeeks.includes(w) : null;
    // A missing Sleeper row used to be treated as a bye. That is how a player
    // Sleeper simply had not projected yet (or dropped from the board) showed
    // up as "bye" against a week the schedule said they were playing — and is
    // why toggling the Sleeper column did not line up with sleeper.com.
    // An explicit bye list (from the NFL schedule) wins; without one, an
    // absent cell is still a bye because that is how Sleeper encodes them.
    if (scheduledBye === true || (!cell && scheduledBye !== false)) {
      byes.push(w);
      points[w] = 0;
      continue;
    }
    if (!cell) { points[w] = 0; continue; }
    const v = cell[key];
    points[w] = typeof v === 'number' && Number.isFinite(v) ? v : 0;
    total += points[w];
  }
  if (total <= 0) return null;

  const share = {};
  for (const w of Object.keys(points)) share[w] = points[w] / total;
  return {
    fromWeek: from,
    throughWeek: through,
    scoring: key,
    source: 'sleeper',
    /** Remaining-season total in this source's own units. */
    total: round(total, 2),
    weeks: through - from + 1,
    played: through - from + 1 - byes.length,
    /** Weeks that actually have a positive projection, not just a slot. */
    covered: Object.values(points).filter((v) => v > 0).length,
    byes,
    share,
    points,
  };
}

/**
 * The same shape contract, from a bare week -> points map.
 *
 * Draft Sharks (and anything else that publishes a real weekly number) should
 * not have to pretend to be a Sleeper cell just to redistribute a season
 * total. `byeWeeks` is the NFL schedule, not "the source had no row".
 */
export function shapeFromPoints(pointsByWeek, { fromWeek, throughWeek = LAST_WEEK, byeWeeks = [], source = null } = {}) {
  if (!pointsByWeek || fromWeek == null) return null;
  const from = Math.max(1, Number(fromWeek));
  const through = Math.min(LAST_WEEK, Number(throughWeek) || LAST_WEEK);
  if (through < from) return null;
  const byeSet = new Set((byeWeeks || []).map(Number));

  const points = {};
  const byes = [];
  let total = 0;
  for (let w = from; w <= through; w++) {
    if (byeSet.has(w)) { byes.push(w); points[w] = 0; continue; }
    const v = pointsByWeek[w] ?? pointsByWeek[String(w)];
    points[w] = typeof v === 'number' && Number.isFinite(v) ? v : 0;
    total += points[w];
  }
  if (total <= 0) return null;
  const share = {};
  for (const w of Object.keys(points)) share[w] = points[w] / total;
  return {
    fromWeek: from,
    throughWeek: through,
    scoring: null,
    source,
    total: round(total, 2),
    weeks: through - from + 1,
    played: through - from + 1 - byes.length,
    covered: Object.values(points).filter((v) => v > 0).length,
    byes,
    share,
    points,
  };
}

/**
 * Prefer the curve that actually moved with the news.
 *
 * Draft Sharks re-ranks each week independently, so a three-week spike from a
 * teammate's injury lands here the same day. Sleeper's weeks 2–18 often have
 * not been recomputed since the overnight batch. When Draft Sharks has a
 * remaining-season shape, that is the one other sources should be spread on;
 * Sleeper is the fallback, not the only lens.
 */
function isUsable(s) {
  return !!(s && s.total > 0 && s.share);
}

/** Enough of a remaining-season curve to spread another source across. */
function isRich(s) {
  if (!isUsable(s)) return false;
  const covered = s.covered ?? Object.values(s.points || {}).filter((v) => v > 0).length;
  const need = Math.min(3, s.played || 3);
  return covered >= need;
}

export function preferredShape(...shapes) {
  return shapes.find(isRich) || shapes.find(isUsable) || null;
}

/**
 * Spread a rest-of-season total across the remaining weeks.
 * Sums back to `rosTotal`, so the two readings never disagree.
 */
export function splitRos(rosTotal, shape) {
  if (rosTotal == null || !shape) return null;
  const out = {};
  for (const [w, s] of Object.entries(shape.share)) out[w] = round(rosTotal * s, 2);
  return out;
}

/** One week out of that split. The number a lineup decision actually wants. */
export function weekFromRos(rosTotal, shape, week) {
  if (rosTotal == null || !shape) return null;
  const s = shape.share[week] ?? shape.share[String(week)];
  return s == null ? null : round(rosTotal * s, 2);
}

/**
 * Every rest-of-season figure on a player, put onto one week.
 *
 * `sources` is `{ label: rosTotal }`. Labels with no total are skipped rather
 * than carried as null, so a consumer can tell "this source has no ROS number"
 * from "this source says zero". The blend is a plain mean of whatever
 * answered — these are independent estimates of the same quantity, and there
 * is no basis here for weighting one above another.
 */
export function perWeekEstimates(sources, shape, week) {
  if (!shape) return null;
  const share = shape.share[week] ?? shape.share[String(week)];
  if (share == null) return null;
  const out = { week: Number(week), share: round(share, 4), bye: shape.byes.includes(Number(week)), sources: {} };
  const vals = [];
  for (const [label, total] of Object.entries(sources || {})) {
    if (total == null || !Number.isFinite(Number(total))) continue;
    const v = round(Number(total) * share, 2);
    out.sources[label] = v;
    vals.push(v);
  }
  if (!vals.length) return null;
  out.blended = round(vals.reduce((a, b) => a + b, 0) / vals.length, 2);
  out.n = vals.length;
  return out;
}

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
