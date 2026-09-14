import { check, report, since, MAX_AGE_MIN } from './freshness.js';
import { resolve as resolveWeek } from './week.js';
import { config } from './config.js';

/**
 * One pipeline runner that asks "has this moved?" before paying to find out.
 *
 * `npm run all` was eleven unconditional network steps. Re-running it two
 * minutes later re-pulled every source, including the two that publish a
 * recompute time saying nothing had changed. That is the wrong default when the
 * whole reason to re-run is that ONE source (the demand signal) moves by the
 * minute and the rest move a few times a day.
 *
 * Each step declares a max age. A step under its age is skipped with a reason;
 * `--force`, `--only` and `--skip` override. Nothing here decides what data
 * means — it decides only whether to go and get it.
 */

/** Step order matters: joins read what the fetches wrote. */
export function steps(mods) {
  return [
    { name: 'scrape', label: 'MyPlaybook leagues + rosters', run: mods.scrape },
    { name: 'fp', label: 'FantasyPros boards, news, injuries', run: mods.fp },
    { name: 'sleeper-proj', label: 'Sleeper week-by-week projections', run: mods.sleeperProj },
    { name: 'vegas', label: 'VegasEdge projections', run: mods.vegas },
    { name: 'vegas-dist', label: 'VegasEdge distributions', run: mods.vegasDist },
    { name: 'wwo', label: 'WinWithOdds', run: mods.wwo },
    { name: 'firstdown', label: 'First Down Studio', run: mods.firstdown },
    { name: 'fanduel', label: 'FanDuel / numberFire', run: mods.fanduel },
    { name: 'buzz', label: 'Yahoo BuzzIndex', run: mods.buzz },
    { name: 'trend', label: 'Sleeper trending', run: mods.trend },
    { name: 'leaguedetail', label: 'Sleeper standings + matchups', run: mods.leaguedetail },
    { name: 'matchups', label: 'every league\'s live board + score ledger', run: mods.matchups },
    // Joins are local and cheap; they always run, because a skipped fetch still
    // leaves the previous fetch's data un-joined if a different source moved.
    { name: 'enrich', label: 'join every source onto rosters', run: mods.enrich, always: true },
    { name: 'dashboard', label: 'build dist/dashboard.html', run: mods.dashboard, always: true },
  ];
}

const list = (v) => (v ? String(v).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) : null);

export async function runPipeline(mods, { force = false, only = null, skip = null, maxAge = null, dryRun = false, log = console.log } = {}) {
  const { season, week } = resolveWeek({ season: config.season, week: config.week });
  const onlySet = list(only), skipSet = list(skip);
  const all = steps(mods);
  const results = [];

  log(`Pipeline — season ${season}, week ${week}${force ? ' (forced)' : ''}${dryRun ? ' (dry run)' : ''}\n`);

  for (const step of all) {
    if (!step.run) { results.push({ ...step, status: 'unavailable' }); continue; }
    // `--only` names which FETCHES to run. The joins are marked `always` and
    // are exempt, because the point of re-fetching one source is to see it on
    // the page: `--only trend` that leaves the dashboard on the previous pull
    // has done nothing at all. `--skip` still stops them, since that is an
    // explicit instruction rather than a selection.
    if (onlySet && !onlySet.includes(step.name) && !step.always) {
      results.push({ ...step, status: 'not selected' });
      continue;
    }
    if (skipSet && skipSet.includes(step.name)) {
      log(`  skip  ${step.name.padEnd(13)} — asked to skip`);
      results.push({ ...step, status: 'skipped' });
      continue;
    }

    let decision = { skip: false, reason: 'always runs' };
    if (!step.always) {
      // --only names a step explicitly, which is a request to run it.
      decision = check(step.name, { maxAgeMin: maxAge != null ? Number(maxAge) : null, force: force || !!onlySet });
    }
    if (decision.skip) {
      log(`  fresh ${step.name.padEnd(13)} — ${decision.reason}`);
      results.push({ ...step, status: 'fresh', ...decision });
      continue;
    }
    if (dryRun) {
      log(`  would ${step.name.padEnd(13)} — ${decision.reason}`);
      results.push({ ...step, status: 'would run', ...decision });
      continue;
    }

    const t0 = Date.now();
    try {
      await step.run({ season, week });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      log(`  done  ${step.name.padEnd(13)} — ${secs}s`);
      results.push({ ...step, status: 'ok', seconds: Number(secs) });
    } catch (err) {
      log(`  FAIL  ${step.name.padEnd(13)} — ${err.message.split('\n')[0]}`);
      results.push({ ...step, status: 'failed', error: err.message });
      // A failed fetch must not stop the joins: the other nine sources are on
      // disk and a dashboard built from them is strictly better than none.
      if (!step.always) continue;
    }
  }

  const ran = results.filter((r) => r.status === 'ok').length;
  const fresh = results.filter((r) => r.status === 'fresh').length;
  const failed = results.filter((r) => r.status === 'failed');
  log(`\n${ran} run, ${fresh} already fresh, ${failed.length} failed`);
  if (failed.length) for (const f of failed) log(`  ${f.name}: ${f.error.split('\n')[0]}`);
  return results;
}

/**
 * The freshness table, printed.
 *
 * Both clocks, side by side, plus whether the site republished between our
 * last two pulls. A row that is freshly fetched and has not moved is the case
 * that matters: it looks current and is not.
 */
export function printStatus(log = console.log) {
  const rows = report();
  if (!rows.length) return void log('No sync has been recorded yet — run `npm run sync`.');
  log('  SOURCE          FETCHED    SITE SAID   MOVED    ITEMS  STATE');
  for (const r of rows) {
    const limit = MAX_AGE_MIN[r.source] ?? 60;
    const moved = r.moved === null ? '—' : (r.moved ? 'yes' : 'no');
    const state = r.stale ? `stale (>${limit}m)` : 'fresh';
    log(
      `  ${r.source.padEnd(15)} ${String(r.age).padStart(8)}  ${String(r.sourceAge || '—').padStart(10)}  ${moved.padStart(5)}  ` +
      `${String(r.items ?? '—').padStart(7)}  ${state}` +
      (r.sourceStale ? ', site is behind' : '') +
      (r.failed ? `, ${r.failed} failed` : ''),
    );
  }
  log('\n  "site said" is the source\'s OWN recompute time where it publishes one;');
  log('  "moved" is whether that time changed between our last two pulls.');
  log('  VegasEdge, FanDuel and MyPlaybook publish none, so those are governed by our clock alone.');
}

/**
 * When each week of the Sleeper projection set was last recomputed upstream.
 *
 * The current week moves through the day and the rest of the season moves
 * overnight, so one age for the source as a whole would hide the only part of
 * it that is live.
 */
export function printProjectionAges(season, weekRows, log = console.log) {
  if (!weekRows.length) return void log('No Sleeper projections stored — run `sleeper:proj`.');
  log(`  Sleeper projections, season ${season} — when the SITE last recomputed each week\n`);
  log('  WK  SITE RECOMPUTED           AGE      PLAYERS  OUR PULL');
  for (const r of weekRows) {
    log(`  ${String(r.week).padStart(2)}  ${(r.sourceAt || '—').padEnd(25)} ${String(since(r.sourceAt)).padStart(7)}  `
      + `${String(r.players ?? '—').padStart(7)}  ${since(r.fetchedAt)}`);
  }
}

export { since };
