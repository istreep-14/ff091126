import { readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, RAW } from './config.js';

/**
 * Bounded history for the directories that grow one file per run.
 *
 * data/raw/ gains a full snapshot directory every scrape, data/trend/ a
 * timestamped file every trend sync. Both are useful — the raw snapshots are
 * the only record of what an endpoint actually returned, and the trend files
 * are the only way to difference Sleeper's counters against our own clock
 * rather than trusting its window boundaries — but only the recent ones are.
 *
 * Deleting is deliberate and capped rather than age-based: a cap keeps a usable
 * history whether you sync hourly or monthly.
 */

export const KEEP_RAW = 20;
export const KEEP_TREND = 48;

function prune(dir, keep, isEntry) {
  if (!existsSync(dir)) return 0;
  const entries = readdirSync(dir).filter(isEntry).sort();
  const drop = entries.slice(0, Math.max(0, entries.length - keep));
  for (const name of drop) rmSync(join(dir, name), { recursive: true, force: true });
  return drop.length;
}

/** Keep the newest KEEP_RAW scrape snapshots. */
export const pruneRaw = (keep = KEEP_RAW) =>
  prune(RAW, keep, (f) => /^\d{4}-\d{2}-\d{2}T/.test(f));

/** Keep the newest KEEP_TREND trend pulls. `latest.json` is never a candidate. */
export const pruneTrend = (season, keep = KEEP_TREND) =>
  prune(join(DATA, 'trend', String(season)), keep, (f) => /^\d{4}-\d{2}-\d{2}T.*\.json$/.test(f));
