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
    if (onlySet && !onlySet.includes(step.name)) { results.push({ ...step, status: 'not selected' }); continue; }
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

/** The freshness table, printed. */
export function printStatus(log = console.log) {
  const rows = report();
  if (!rows.length) return void log('No sync has been recorded yet — run `npm run sync`.');
  log('  SOURCE          FETCHED    SITE SAID     ITEMS  STATE');
  for (const r of rows) {
    const limit = MAX_AGE_MIN[r.source] ?? 60;
    log(
      `  ${r.source.padEnd(15)} ${String(r.age).padStart(8)}  ${String(r.sourceAge || '—').padStart(10)}  ` +
      `${String(r.items ?? '—').padStart(6)}  ${r.stale ? `stale (>${limit}m)` : 'fresh'}` +
      (r.failed ? `, ${r.failed} failed` : ''),
    );
  }
  log('\n  "site said" is the source\'s OWN recompute time where it publishes one.');
  log('  VegasEdge and FanDuel publish none, so those are governed by our clock alone.');
}

export { since };
