import { get } from './http.js';
import { config } from './config.js';

export const BASE = 'https://api.fantasypros.com/public/v2/json';

/** Positions worth pulling for a standard fantasy league. */
export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
export const SCORINGS = ['PPR', 'HALF', 'STD'];

/** MyPlaybook reports league scoring with these labels; map them to API values. */
export const LEAGUE_SCORING_TO_API = { PPR: 'PPR', HALF: 'HALF', STD: 'STD', STANDARD: 'STD' };

export class MissingApiKeyError extends Error {
  constructor() {
    super('FP_API_KEY is not set. Request one at https://secure.fantasypros.com/api-keys/request/ and add it to .env');
    this.name = 'MissingApiKeyError';
  }
}

export class ApiKeyRejectedError extends Error {
  constructor(url) {
    super(
      'FantasyPros returned 403 Forbidden after retries.\n' +
        '  This API answers 403 both for a bad key AND for throttling, so it can mean either:\n' +
        '    - the key is wrong / not yet propagated across the API gateway edges, or\n' +
        '    - the rate limit (1 req/sec) or daily quota (500/day on premium) is exhausted.\n' +
        '  Check the key at https://secure.fantasypros.com/api-keys/, or retry later.\n' +
        `  URL: ${url}`,
    );
    this.name = 'ApiKeyRejectedError';
  }
}

/**
 * The plan allows 1 request/second and 500/day, and the gateway signals
 * throttling with 403 (not 429), so requests are serialised through a single
 * queue with a minimum gap rather than relying on the generic retry path.
 */
const MIN_GAP_MS = config.apiGapMs || 2000;
let chain = Promise.resolve();
let lastAt = 0;
let requestCount = 0;

export const requestsUsed = () => requestCount;

function schedule(fn) {
  const run = chain.then(async () => {
    const wait = Math.max(0, lastAt + MIN_GAP_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    requestCount++;
    return fn();
  });
  // Keep the chain alive even when a call rejects.
  chain = run.then(() => {}, () => {});
  return run;
}

function url(path, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  const q = qs.toString();
  return `${BASE}${path}${q ? `?${q}` : ''}`;
}

async function call(path, params = {}) {
  if (!config.apiKey) throw new MissingApiKeyError();
  const u = url(path, params);
  // 403 is ambiguous here (bad key vs throttle), so retry a few times with
  // growing backoff before deciding the key is genuinely refused.
  const attempts = 6;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await schedule(() => get(u, { headers: { 'x-api-key': config.apiKey }, retries: 1 }));
    } catch (err) {
      lastErr = err;
      if (err.status !== 403) throw err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, Math.min(1500 * 2 ** i, 15000)));
    }
  }
  if (lastErr?.status === 403) throw new ApiKeyRejectedError(u);
  throw lastErr;
}

/* ---------------------------------------------------------------- Players */

/** Universal player database. `external_ids` maps FP ids onto host-site ids. */
export const players = ({ sport = 'nfl', player, update, ecr, external_ids, show } = {}) =>
  call(`/${sport}/players`, { player, update, ecr, external_ids, show });

/* ------------------------------------------------------- News & injuries */

export const news = ({ sport = 'nfl', fpid, limit = 100, category, order_by = 'created' } = {}) =>
  call(`/${sport}/news`, { fpid, limit, category, order_by });

export const injuries = ({ sport = 'nfl', year, week, include_probabilities = 'true', team_id, player_ids } = {}) =>
  call(`/${sport}/injuries`, { year, week, include_probabilities, team_id, player_ids });

/* -------------------------------------------------------------- Rankings */

/**
 * Consensus rankings. `week` selects the weekly board (week=0 is preseason/draft);
 * `type: 'ROS'` selects rest-of-season. Position and scoring are both meaningful.
 */
export const consensusRankings = ({ sport = 'nfl', season, position, scoring, week, type, experts, include_idp, filters } = {}) =>
  call(`/${sport}/${season}/consensus-rankings`, { position, scoring, week, type, experts, include_idp, filters });

export const rankings = ({ sport = 'nfl', season, week, player, min, range, rankstats, type } = {}) =>
  call(`/${sport}/${season}/rankings`, { week, player, min, range, rankstats, type });

export const rankingExperts = ({ sport = 'nfl', season, include_overall } = {}) =>
  call(`/${sport}/${season}/rankings/experts`, { include_overall });

export const comparePlayers = ({ sport = 'nfl', year, week, players: ps, experts, ranking_type, details } = {}) =>
  call(`/${sport}/compare-players`, { year, week, players: ps, experts, ranking_type, details });

/* ----------------------------------------------------------- Projections */

/**
 * NFL projections. `week` for a single week (0 = preseason), or `ros: true` for
 * rest-of-season. The payload carries points, points_ppr and points_half together,
 * so one call per position covers every scoring format.
 */
export const projections = ({ season, position, week, ros, players: ps, positions } = {}) =>
  call(`/nfl/${season}/projections`, { position, week, ros: ros ? 'true' : undefined, players: ps, positions });

/* --------------------------------------------------------- Points scored */

export const playerPoints = ({ season, start, end, position, scoring, min } = {}) =>
  call(`/nfl/${season}/player-points`, { start, end, position, scoring, min });

/** Cheap authenticated call used to validate a key. */
export const ping = () => players({ ecr: 'included' });
