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

/** The last week of the regular season. Week 0 is preseason/draft. */
export const LAST_WEEK = 18;

const unset = (v) => v === undefined || v === null || v === '';

/**
 * Season and week, pinned or inferred.
 *
 * Both are validated, because both end up in file PATHS. `--week fifteen`
 * resolved to NaN and wrote `data/fp/2026/week-NaN/`, which then read back as
 * an empty week forever; `--season twentysix` resolved to the current season
 * and quietly gave you data for a year you did not ask for. Neither failed,
 * which is the problem — an argument that cannot be honoured has to say so.
 */
export function resolve({ season, week } = {}, now = new Date()) {
  let s;
  if (unset(season)) {
    s = currentSeason(now);
  } else {
    s = Number(season);
    if (!Number.isInteger(s) || s < 1990 || s > 2200) {
      throw new Error(`Invalid season "${season}" — expected a four-digit year.`);
    }
  }

  let w;
  if (unset(week)) {
    w = currentWeek(now, s);
  } else {
    w = Number(week);
    if (!Number.isInteger(w) || w < 0 || w > LAST_WEEK) {
      throw new Error(`Invalid week "${week}" — expected an integer 0–${LAST_WEEK} (0 is preseason).`);
    }
  }
  return { season: s, week: w };
}
