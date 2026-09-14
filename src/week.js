/**
 * NFL season/week resolution.
 *
 * The regular season kicks off the Thursday after Labor Day (first Monday of
 * September), and weeks roll over on Tuesday. Both the season and the week can
 * be pinned explicitly via FP_SEASON / FP_WEEK when that heuristic is wrong
 * (or when you want data for a week other than the current one).
 */

const MS_DAY = 86_400_000;

function laborDay(year) {
  const d = new Date(Date.UTC(year, 8, 1));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1); // first Monday in Sept
  return d;
}

/** Thursday of week 1. */
export function kickoff(year) {
  const d = laborDay(year);
  d.setUTCDate(d.getUTCDate() + 3);
  return d;
}

/** The season a given date belongs to (Jan–Feb still belongs to the prior season). */
export function currentSeason(now = new Date()) {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() <= 1 ? y - 1 : y;
}

/**
 * Current NFL week, 1–18. Before kickoff returns 0, which the API treats as
 * preseason/draft — the correct value for both rankings and projections.
 */
export function currentWeek(now = new Date(), season = currentSeason(now)) {
  const start = kickoff(season);
  if (now < start) return 0;
  // Week N runs Thu..Mon; roll to N+1 on Tuesday, so shift the grid back two days.
  const week = Math.floor((now - start + 2 * MS_DAY) / (7 * MS_DAY)) + 1;
  return Math.min(Math.max(week, 0), 18);
}

export function resolve({ season, week } = {}, now = new Date()) {
  const s = Number(season) || currentSeason(now);
  const w = week === undefined || week === null || week === '' ? currentWeek(now, s) : Number(week);
  return { season: s, week: w };
}
