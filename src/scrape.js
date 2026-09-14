import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RAW, DATA } from './config.js';
import { resolveLeagues, fetchLeague, ENDPOINTS } from './fantasypros.js';
import { applyFilters } from './leaguestate.js';
import { loadDictionary } from './players.js';
import { normalize } from './normalize.js';
import { record } from './freshness.js';
import { pruneRaw } from './prune.js';
import { writeJsonAtomic } from './jsonfile.js';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

export async function scrape({ filter = null, limit = null, all = false, endpoints = Object.keys(ENDPOINTS), log = console.log } = {}) {
  const runDir = join(RAW, stamp());
  mkdirSync(runDir, { recursive: true });

  log('Resolving leagues…');
  const discovered = await resolveLeagues();
  /**
   * An account with no leagues at all is not a state this can be in — it is a
   * dead session reported as an empty list, and MyPlaybook returns 200 for it.
   *
   * Observed: a scrape found zero leagues, recorded zero failures, and wrote
   * the resulting empty model straight over `data/latest.json`, deleting the
   * four leagues everything downstream reads. The run looked completely
   * successful. Frequent syncing makes this more likely, not less, so the
   * refusal has to be here rather than in the caller.
   */
  if (!discovered.length) {
    throw new Error('MyPlaybook returned no leagues at all. That is a dead session, not an empty account '
      + '— refusing to overwrite data/latest.json. Check FP_EMAIL, then run `leagues`.');
  }
  const leagues = applyFilters(discovered, { all, filter, limit });
  const skipped = discovered.length - leagues.length;
  log(`  ${leagues.length} league(s)${skipped > 0 ? ` (${skipped} skipped — inactive or filtered)` : ''}`);
  if (!leagues.length) {
    throw new Error(`All ${discovered.length} league(s) were filtered out, so there is nothing to write. `
      + 'Run `leagues` to see what is active.');
  }

  log('Loading player dictionary…');
  const dict = await loadDictionary();
  log(`  ${dict.count} players`);

  const raw = [];
  for (const league of leagues) {
    const res = await fetchLeague(league, endpoints);
    const okCount = Object.values(res.endpoints).filter((e) => e.ok).length;
    const failed = Object.entries(res.endpoints).filter(([, e]) => !e.ok).map(([n]) => n);
    log(`  ${(res.host || '?').padEnd(8)} ${res.nickname} — ${okCount}/${endpoints.length} ok${failed.length ? ` (failed: ${failed.join(', ')})` : ''}`);
    raw.push(res);
    writeFileSync(join(runDir, `${league.key.replace(/[^a-z0-9]/gi, '_')}.json`), JSON.stringify(res, null, 2));
  }

  const model = normalize(raw, dict);
  writeFileSync(join(runDir, '_normalized.json'), JSON.stringify(model, null, 2));
  // Atomic, because this is the file every other command reads: a half-written
  // one reads as corrupt to all of them at once.
  writeJsonAtomic(join(DATA, 'latest.json'), model);

  record('scrape', {
    ok: leagues.map((l) => l.nickname || l.key),
    failed: raw.flatMap((r) => Object.entries(r.endpoints).filter(([, e]) => !e.ok)
      .map(([n, e]) => ({ label: `${r.nickname}/${n}`, error: e.error }))),
    // MyPlaybook publishes no recompute time. `model.generatedAt` is OUR clock,
    // and reporting it as the site's is exactly the conflation freshness.js
    // exists to prevent — `status` showed "site said 25m" about ourselves.
    sourceAt: null,
    items: model.leagues.reduce((a, l) => a + l.playerCount, 0),
  });

  // One snapshot directory per scrape, forever, was the only unbounded growth
  // in data/ that nothing ever looked at again past the newest few.
  const pruned = pruneRaw();
  if (pruned) log(`Pruned ${pruned} old raw snapshot(s)`);

  log(`\nRaw snapshots: ${runDir}`);
  log(`Normalized:    ${join(DATA, 'latest.json')}`);
  return { model, runDir };
}
