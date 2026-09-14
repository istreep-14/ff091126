import { get, pool } from './http.js';
import { config, requireEmail } from './config.js';

const base = (sport = 'nfl') => `https://mpb${sport}.fantasypros.com/api`;

/**
 * Per-league endpoints, all keyed by the league's `key` param.
 * `verified` marks endpoints confirmed to return data on ESPN/Yahoo/Sleeper leagues.
 */
export const ENDPOINTS = {
  rosters:      { path: 'getLeagueRostersJSON',      verified: true,  note: 'teams + rostered fpIds' },
  settings:     { path: 'getLeagueSettingsJSON',     verified: true,  note: 'scoring, roster slots, playoffs, draft, waivers' },
  transactions: { path: 'getLeagueTransactionsJSON', verified: true,  note: 'adds/drops w/ player names' },
  waiver:       { path: 'getLeagueWaiverJSON',       verified: true,  note: 'league metadata only (thin)' },
  lineup:       { path: 'getLeagueLineupJSON',       verified: false, note: 'returns [] in testing' },
};

/** Enumerate every league on the account. The email alone is the credential. */
export async function getUserLeagues(email = requireEmail()) {
  const data = await get(`${base()}/getUserLeaguesJSON?email=${encodeURIComponent(email)}`);
  if (!data || data.error) throw new Error(`getUserLeagues failed: ${data?.error || 'empty response'}`);
  return data;
}

/** Fetch one endpoint for one league key. */
export async function fetchEndpoint(name, key, sport = 'nfl') {
  const ep = ENDPOINTS[name];
  if (!ep) throw new Error(`Unknown endpoint: ${name}`);
  return get(`${base(sport)}/${ep.path}?key=${encodeURIComponent(key)}`);
}

/** Fetch every endpoint for one league. Individual failures are captured, not thrown. */
export async function fetchLeague(league, names = Object.keys(ENDPOINTS)) {
  const out = { key: league.key, nickname: league.nickname || league.name, host: league.host, sport: league.sport || 'nfl' };
  const results = await pool(names, async (name) => {
    try {
      return [name, { ok: true, data: await fetchEndpoint(name, league.key, out.sport) }];
    } catch (err) {
      return [name, { ok: false, error: err.message }];
    }
  }, { concurrency: 2 });
  out.endpoints = Object.fromEntries(results);
  return out;
}

/** Resolve the league list from the account email plus any extra standalone keys. */
export async function resolveLeagues() {
  const leagues = [];
  if (config.email) {
    const user = await getUserLeagues();
    leagues.push(...(user.leagues || []));
  }
  for (const key of config.extraKeys) {
    if (leagues.some((l) => l.key === key)) continue;
    // A standalone key still identifies itself via its own rosters payload.
    try {
      const d = await fetchEndpoint('rosters', key);
      leagues.push({ key, host: d?.host, nickname: d?.nickname || d?.name, sport: d?.sport || 'nfl', standalone: true });
    } catch {
      leagues.push({ key, host: 'unknown', nickname: '(unreachable)', sport: 'nfl', standalone: true });
    }
  }
  return leagues;
}
