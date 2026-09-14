import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FPDIR, DATA, config } from './config.js';
import { pool } from './http.js';
import * as fp from './fpapi.js';
import { ApiKeyRejectedError, MissingApiKeyError } from './fpapi.js';
import { resolve as resolveWeek } from './week.js';

/**
 * Pulls the FantasyPros universal dataset for a season:
 *   - players (with host-site external ids)
 *   - news + injuries
 *   - consensus rankings: CURRENT WEEK and REST OF SEASON, per position per scoring
 *   - projections:        CURRENT WEEK and REST OF SEASON, per position
 *   - player points scored, season to date
 *
 * Everything lands under data/fp/<season>/ and is safe to re-run.
 */

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');

function save(dir, name, data) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(data, null, 2));
}

/** Which scoring formats to pull — driven by the leagues actually on the account. */
export function scoringsInUse() {
  const latest = join(DATA, 'latest.json');
  if (!existsSync(latest)) return ['PPR'];
  const model = JSON.parse(readFileSync(latest, 'utf8'));
  const found = new Set();
  for (const l of model.leagues) {
    const api = fp.LEAGUE_SCORING_TO_API[String(l.scoring || '').toUpperCase()];
    if (api) found.add(api);
  }
  return found.size ? [...found] : ['PPR'];
}

/**
 * The public API answers 403 for throttling as well as for a bad key, and the
 * quota is 500 requests/day. Public-page scraping has neither limit and carries
 * MORE per-player detail for rankings (projected points, start/sit grade,
 * opponent, expert spread). So the default split is:
 *
 *   scraping -> rankings, projections, news, injuries   (unlimited, richer)
 *   API      -> players+external_ids, player-points     (no scraped equivalent)
 *
 * This costs ~3 API requests per run instead of ~45.
 */
export async function apiSupplement({ season, week, scorings = null, log = console.log } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season: season ?? config.season, week: week ?? config.week });
  const formats = scorings || scoringsInUse();
  const root = join(FPDIR, String(yr));
  const report = { season: yr, week: wk, source: 'api-supplement', fetchedAt: new Date().toISOString(), ok: [], failed: [] };

  const task = async (label, dir, name, fn) => {
    try {
      const data = await fn();
      save(dir, name, data);
      log(`  ok   ${label}${data?.players?.length ? ` (${data.players.length})` : ''}`);
      report.ok.push(label);
    } catch (err) {
      log(`  skip ${label} — ${err.message.split('\n')[0]}`);
      report.failed.push({ label, error: err.message });
    }
  };

  log('API supplement (data with no public-page equivalent)');
  await task('players + espn/yahoo/cbs ids', root, 'players', () =>
    fp.players({ ecr: 'included', external_ids: 'espn:yahoo:cbs:fleaflicker:fantrax:mfl' }),
  );
  for (const sc of formats) {
    await task(`player-points ${sc}`, join(root, 'points'), sc.toLowerCase(), () =>
      fp.playerPoints({ season: yr, start: 1, end: Math.max(wk, 1), scoring: sc }),
    );
  }
  log(`  ${report.ok.length} ok, ${report.failed.length} skipped, ${fp.requestsUsed()} API requests`);
  return report;
}

export async function fpSync({
  season,
  week,
  positions = fp.POSITIONS,
  scorings = null,
  log = console.log,
} = {}) {
  const { season: yr, week: wk } = resolveWeek({ season: season ?? config.season, week: week ?? config.week });
  const formats = scorings || scoringsInUse();
  const root = join(FPDIR, String(yr));
  const weekDir = join(root, `week-${wk}`);
  const rosDir = join(root, 'ros');

  log(`FantasyPros universal sync — season ${yr}, week ${wk}`);
  log(`  scoring formats: ${formats.join(', ')}`);
  log(`  positions:       ${positions.join(', ')}`);

  const report = { season: yr, week: wk, fetchedAt: new Date().toISOString(), ok: [], failed: [] };
  const task = async (label, dir, name, fn) => {
    try {
      const data = await fn();
      save(dir, name, data);
      const n = data?.players?.length ?? data?.news?.length ?? data?.injuries?.length ?? data?.count ?? '';
      log(`  ok   ${label}${n !== '' ? ` (${n})` : ''}`);
      report.ok.push(label);
      return data;
    } catch (err) {
      // A rejected key fails every remaining call identically — stop immediately
      // rather than grinding through dozens of guaranteed failures.
      if (err instanceof ApiKeyRejectedError || err instanceof MissingApiKeyError) throw err;
      log(`  FAIL ${label} — ${err.message.split('\n')[0]}`);
      report.failed.push({ label, error: err.message });
      return null;
    }
  };

  // --- account-wide reference data -------------------------------------
  log('\nreference data');
  await task('players (+espn/yahoo/cbs ids)', root, 'players', () =>
    fp.players({ ecr: 'included', external_ids: 'espn:yahoo:cbs:fleaflicker:fantrax:mfl' }),
  );
  await task('news', root, 'news', () => fp.news({ limit: 100 }));
  await task(`injuries (week ${wk})`, weekDir, 'injuries', () => fp.injuries({ year: yr, week: wk }));
  await task('ranking experts', root, 'experts', () => fp.rankingExperts({ season: yr, include_overall: 'true' }));

  // --- current week -----------------------------------------------------
  log(`\nweek ${wk} — rankings`);
  const weekRankJobs = formats.flatMap((sc) => positions.map((pos) => ({ sc, pos })));
  await pool(weekRankJobs, ({ sc, pos }) =>
    task(`rankings ${sc} ${pos} wk${wk}`, join(weekDir, 'rankings', slug(sc)), slug(pos), () =>
      fp.consensusRankings({ season: yr, position: pos, scoring: sc, week: wk, experts: 'show' }),
    ), { concurrency: 1 },
  );

  log(`\nweek ${wk} — projections`);
  await pool(positions, (pos) =>
    task(`projections ${pos} wk${wk}`, join(weekDir, 'projections'), slug(pos), () =>
      fp.projections({ season: yr, position: pos, week: wk }),
    ), { concurrency: 1 },
  );

  // --- rest of season ---------------------------------------------------
  log('\nrest of season — rankings');
  await pool(weekRankJobs, ({ sc, pos }) =>
    task(`ROS rankings ${sc} ${pos}`, join(rosDir, 'rankings', slug(sc)), slug(pos), () =>
      fp.consensusRankings({ season: yr, position: pos, scoring: sc, type: 'ROS', experts: 'show' }),
    ), { concurrency: 1 },
  );

  log('\nrest of season — projections');
  await pool(positions, (pos) =>
    task(`ROS projections ${pos}`, join(rosDir, 'projections'), slug(pos), () =>
      fp.projections({ season: yr, position: pos, ros: true }),
    ), { concurrency: 1 },
  );

  // --- points scored ----------------------------------------------------
  log('\npoints scored (season to date)');
  await pool(formats, (sc) =>
    task(`player-points ${sc}`, join(root, 'points'), slug(sc), () =>
      fp.playerPoints({ season: yr, start: 1, end: Math.max(wk, 1), scoring: sc }),
    ), { concurrency: 1 },
  );

  report.apiRequests = fp.requestsUsed();
  save(root, '_sync-report', report);
  log(`\n${report.ok.length} ok, ${report.failed.length} failed, ${report.apiRequests} API requests -> ${root}`);
  return report;
}
