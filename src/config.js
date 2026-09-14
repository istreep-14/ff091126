import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = join(ROOT, 'data');
export const RAW = join(DATA, 'raw');
export const CACHE = join(DATA, 'cache');
export const EXPORT = join(DATA, 'export');
export const FPDIR = join(DATA, 'fp');
export const VEGASDIR = join(DATA, 'vegas');
export const STATE = join(DATA, 'leagues-state.json');

// Minimal .env reader — no dependency needed for KEY=value lines.
/**
 * Parse a `.env` file's text into key/value pairs.
 *
 * Exported for the tests. The value-level handling here is not decoration: a
 * key with a stray space on the end reads as a REJECTED key, which is the
 * least diagnosable failure this file has, and `FP_WEEK=3 # pinned` parsed as
 * NaN and then went into a file path.
 */
export function parseEnv(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    const quoted = /^(["']).*\1$/.test(v);
    // An unquoted trailing `# comment` is not part of the value, and neither
    // is trailing whitespace.
    if (!quoted) v = v.replace(/\s+#.*$/, '').trim();
    out.set(m[1], quoted ? v.slice(1, -1) : v);
  }
  return out;
}

function loadEnvFile() {
  const p = join(ROOT, '.env');
  if (!existsSync(p)) return;
  // The real environment always wins over the file.
  for (const [k, v] of parseEnv(readFileSync(p, 'utf8'))) {
    if (process.env[k] == null) process.env[k] = v;
  }
}
loadEnvFile();

export const config = {
  email: process.env.FP_EMAIL || '',
  extraKeys: (process.env.FP_EXTRA_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean),
  concurrency: Number(process.env.FP_CONCURRENCY || 3),
  delayMs: Number(process.env.FP_DELAY_MS || 250),
  // Per-request deadline. 0 disables it.
  timeoutMs: Number(process.env.FP_TIMEOUT_MS || 30_000),
  // Minimum gap between FantasyPros API v2 calls. The key is rate-limited per
  // day AND per burst; fpapi.js read this straight off process.env, so it was
  // the one tunable documented nowhere.
  apiGapMs: Number(process.env.FP_API_GAP_MS || 1200),
  // FantasyPros public API v2 (separate credential from the MyPlaybook league keys)
  apiKey: process.env.FP_API_KEY || '',
  season: process.env.FP_SEASON || null,
  week: process.env.FP_WEEK || null,
  // VegasEdgeFantasy session cookie (JWT). Separate site, separate login.
  vegasToken: process.env.VEGAS_TOKEN || '',
};

export function requireEmail() {
  if (!config.email) {
    throw new Error('FP_EMAIL is not set. Copy .env.example to .env and fill in your FantasyPros email.');
  }
  return config.email;
}
