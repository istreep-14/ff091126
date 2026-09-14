import { writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Write JSON so a interrupted run cannot leave half a file behind.
 *
 * The state files here are read with a `try/catch` that falls back to an empty
 * default, so a truncated write does not surface as an error — it surfaces as
 * "you have no league overrides" or "nothing has ever been synced", and the
 * next write makes that permanent. Writing to a sibling and renaming means a
 * reader sees either the old file or the new one.
 */
export function writeJsonAtomic(path, value, { indent = 2 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, indent));
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
