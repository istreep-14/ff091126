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
function loadEnvFile() {
  const p = join(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnvFile();

export const config = {
  email: process.env.FP_EMAIL || '',
  extraKeys: (process.env.FP_EXTRA_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean),
  concurrency: Number(process.env.FP_CONCURRENCY || 3),
  delayMs: Number(process.env.FP_DELAY_MS || 250),
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
