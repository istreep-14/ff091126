import { readTrend, WINDOWS } from './sleepertrend.js';
import { readDay, storedDates, buzzDate } from './buzz.js';
import { nameKey } from './sleeper.js';

/**
 * The demand side of the market, in one index.
 *
 * Every other source in this project answers "how many points will he score".
 * None of them answers "is he still going to be there in an hour", and on a
 * Thursday night that is the only question that decides a waiver claim. Two
 * sources answer it, and they answer it differently:
 *
 *   Sleeper   a rolling lookback, refreshed continuously, keyed by Sleeper id.
 *             Differencing the 6h and 24h windows gives a RATE and a change in
 *             rate — who is being added right now, not who was added this week.
 *
 *   Yahoo     a completed calendar day, keyed by Yahoo id, with % rostered and
 *             % started alongside. Coarser in time, but it is the only source
 *             that reports drops and trades at the same scale as adds, so it is
 *             what separates a real add wave from two-way churn.
 *
 * Neither is a projection and neither should be read as one. A player can be
 * the most-added in football and still be a bad add; what this tells you is how
 * long the window is open.
 */

const pct = (sortedDesc, value) => {
  if (value == null || !sortedDesc.length) return null;
  // Share of the board this player sits above, 0-100.
  let lo = 0, hi = sortedDesc.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sortedDesc[mid] > value) lo = mid + 1; else hi = mid; }
  return Math.round(((sortedDesc.length - lo) / sortedDesc.length) * 100);
};

/**
 * The better of two percentile ranks, or null when there is neither.
 *
 * The max, not a blend: the two boards cover different league populations, and
 * a player can be exploding on one while absent from the other's top 50 purely
 * because of where the cutoff fell. "Loud on at least one board" is the claim
 * being made; averaging would quietly punish a player for the other board's
 * truncation.
 *
 * The null handling is the part that was wrong. It read
 * `Math.max(a ?? 0, b ?? 0) || null`, so a player who IS on a board and sits
 * at its 0th percentile came back null — indistinguishable from a player on
 * neither board. Bottom of the board is a reading; not being on it is not.
 */
export function heatOf(a, b) {
  const vals = [a, b].filter((v) => v != null);
  return vals.length ? Math.max(...vals) : null;
}

/**
 * Loads both sources for a season and returns lookups keyed every way the rest
 * of the codebase can join on.
 *
 * `days` is how many stored Yahoo days to carry: the most recent is "today",
 * the one before it is what today is compared against. More than two are kept
 * as a small history so the UI can draw a trend without another fetch.
 */
export function loadSignals({ season, days = 3 } = {}) {
  const trend = readTrend(season);
  const dates = storedDates(season).slice(0, Math.max(2, days));
  const buzzDays = dates.map((d) => readDay(season, d)).filter(Boolean);

  // --- Sleeper, by sleeper id (and by name, for callers with no id) ------
  const bySleeper = new Map();
  const slByKey = new Map();
  const rateBoard = [];
  for (const p of trend?.players || []) {
    if (p.recentPerHr != null) rateBoard.push(p.recentPerHr);
    bySleeper.set(String(p.sleeperId), p);
    if (p.name) slByKey.set(nameKey(p.name, p.position), p);
  }
  rateBoard.sort((a, b) => b - a);

  // --- Yahoo, by yahoo id and by name key -------------------------------
  //
  // Days are folded newest-LAST so a fresher day overwrites an older one. The
  // current day is deliberately not treated as the only day: pulled at 9am it
  // holds a few dozen rows, and dropping everyone who has not charted yet
  // today would blank out the entire board every morning. Each record carries
  // the date it came from, so a stale row reads as stale rather than as
  // current-day silence.
  const today = buzzDays[0] || null;
  const perDayBoards = new Map(buzzDays.map((d) => [d.date,
    d.players.map((p) => p.adds).filter((x) => x != null).sort((a, b) => b - a)]));

  const buzzById = new Map();
  const buzzByKey = new Map();
  for (const day of [...buzzDays].reverse()) {
    const board = perDayBoards.get(day.date) || [];
    for (const p of day.players) {
      const was = buzzById.get(String(p.yahooId)) || buzzByKey.get(p.key) || null;
      const rec = {
        ...p,
        date: day.date,
        // The previous day's counts, and the change. A player whose adds
        // doubled overnight is mid-wave; one whose adds halved has already been
        // claimed in most leagues and the cheap window has closed.
        prevDate: was?.date ?? null,
        prevAdds: was?.adds ?? null,
        prevPctRostered: was?.pctRostered ?? null,
        addsChange: p.adds != null && was?.adds != null ? p.adds - was.adds : null,
        rosteredChange: p.pctRostered != null && was?.pctRostered != null ? p.pctRostered - was.pctRostered : null,
        addsPctile: pct(board, p.adds),
      };
      if (p.yahooId) buzzById.set(String(p.yahooId), rec);
      buzzByKey.set(p.key, rec);
    }
  }

  // Per-day history, oldest first, for sparklines.
  const history = new Map();
  for (const day of [...buzzDays].reverse()) {
    for (const p of day.players) {
      const k = String(p.yahooId || p.key);
      if (!history.has(k)) history.set(k, []);
      history.get(k).push({ date: day.date, adds: p.adds, drops: p.drops, pctRostered: p.pctRostered });
    }
  }

  /**
   * One player's demand signal, merged from whichever sources matched.
   *
   * Pass every id you have; each is tried in turn. A player missing from both
   * boards is not "cold" — he is simply not in the top 50 of any slice — so
   * this returns null rather than zeroes, and callers must not treat the
   * absence as a score.
   */
  function signalFor({ sleeperId, yahooId, name, position } = {}) {
    const key = name ? nameKey(name, position) : null;
    const s = (sleeperId && bySleeper.get(String(sleeperId))) || (key && slByKey.get(key)) || null;
    const y = (yahooId && buzzById.get(String(yahooId))) || (key && buzzByKey.get(key)) || null;
    if (!s && !y) return null;

    const addsPerHr = s?.recentPerHr ?? null;

    return {
      // Sleeper — the live half.
      addsPerHr,
      addsPctile: addsPerHr != null ? pct(rateBoard, addsPerHr) : null,
      surge: s?.ratio ?? null,
      fresh: !!s?.fresh,
      slAdds: s?.addCount ?? null,
      slDrops: s?.dropCount ?? null,
      slNet: s?.net ?? null,
      windows: s ? { short: WINDOWS[0], long: WINDOWS[1] } : null,
      // Yahoo — the daily half.
      yAdds: y?.adds ?? null,
      yDrops: y?.drops ?? null,
      yNet: y?.net ?? null,
      yTrades: y?.trades ?? null,
      yRostered: y?.pctRostered ?? null,
      yStarted: y?.pctStarted ?? null,
      yAddsChange: y?.addsChange ?? null,
      yRosteredChange: y?.rosteredChange ?? null,
      yPctile: y?.addsPctile ?? null,
      yDate: y?.date ?? null,
      note: y?.gameNote ?? null,
      history: history.get(String(yahooId ?? key)) ?? null,
      /**
       * A single sortable number, 0-100, and the only derived value here.
       *
       * It is the better of the player's two percentile ranks, not a weighted
       * blend: the sources cover different league populations and a player can
       * be exploding on one and absent from the other's top 50 purely because
       * of where the cutoff fell. Taking the max means "loud on at least one
       * board", which is the claim being made; averaging would quietly punish a
       * player for the other board's truncation.
       */
      heat: heatOf(addsPerHr != null ? pct(rateBoard, addsPerHr) : null, y?.addsPctile ?? null),
    };
  }

  return {
    ok: !!(trend || today),
    trendFetchedAt: trend?.fetchedAt ?? null,
    buzzDate: today?.date ?? null,
    buzzStale: today ? today.date !== buzzDate() : null,
    dates,
    windows: WINDOWS,
    counts: { sleeper: bySleeper.size, yahoo: buzzByKey.size },
    signalFor,
  };
}
