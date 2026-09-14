import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { post } from './http.js';
import { record } from './freshness.js';
import { DATA } from './config.js';
import { nameKey } from './sleeper.js';
import { resolve as resolveWeek } from './week.js';

/**
 * FanDuel Research (numberFire) — a fifth projection source.
 *
 * The research pages render nothing useful server-side; the tables are filled
 * from a GraphQL endpoint at /research/api/graphql, which is what this calls
 * directly. Errors come back redacted (`{"errors":[{}]}`), so a bad argument
 * looks like a generic failure — the enums below are the ones the site itself
 * uses.
 *
 * Rows carry numberFire ids only, so the join is name + position.
 */

const ENDPOINT = 'https://www.fanduel.com/research/api/graphql';
const REFERER = 'https://www.fanduel.com/research/nfl/fantasy/fantasy-football-projections';

/** Position groups. NFL_SKILL covers QB/RB/WR/TE in one call. */
export const POSITIONS = ['NFL_SKILL', 'NFL_KICKER', 'NFL_D_ST'];

/** GraphQL union members. Note overallRank exists only on NflSkill. */

/**
 * Projection sets:
 *   WEEKLY    this week, standard scoring
 *   PPR       this week, full PPR
 *   REMAINING rest of season
 *   DAILY     needs a slateId, so it is not synced
 */
export const TYPES = { WEEKLY: 'WEEKLY', PPR: 'PPR', REMAINING: 'REMAINING' };

const QUERY = `query GetProjections($input: ProjectionsInput!) {
  getProjections(input: $input) {
    __typename
    ... on NflSkill {
      player { numberFireId name position }
      team { abbreviation }
      gameInfo { homeTeam { abbreviation } awayTeam { abbreviation } gameTime }
      fantasy positionRank overallRank opponentDefensiveRank
      passingYards passingTouchdowns interceptionsThrown
      rushingAttempts rushingYards rushingTouchdowns
      receptions targets receivingYards receivingTouchdowns
    }
    ... on NflKicker {
      player { numberFireId name position }
      team { abbreviation }
      gameInfo { gameTime }
      fantasy positionRank opponentDefensiveRank
      fieldGoalsMade extraPointsMade
    }
    ... on NflDefenseSt {
      player { numberFireId name position }
      team { abbreviation }
      gameInfo { gameTime }
      fantasy positionRank opponentOffensiveRank
      pointsAllowed yardsAllowed sacks interceptions
    }
  }
}`;

async function query(input) {
  const json = await post(ENDPOINT, { query: QUERY, variables: { input } }, { headers: { Referer: REFERER } });
  if (json?.errors) {
    // The endpoint redacts error detail in production, so report the arguments.
    throw new Error(`FanDuel rejected ${JSON.stringify(input)} (errors are redacted server-side)`);
  }
  return json?.data?.getProjections || [];
}

const shape = (r) => ({
  numberFireId: r.player?.numberFireId ?? null,
  name: r.player?.name ?? null,
  position: r.player?.position ?? null,
  team: r.team?.abbreviation ?? null,
  key: nameKey(r.player?.name, String(r.player?.position || '').split(',')[0]),
  fantasy: r.fantasy ?? null,
  positionRank: r.positionRank ?? null,
  overallRank: r.overallRank ?? null,
  opponentDefensiveRank: r.opponentDefensiveRank ?? null,
  opponentOffensiveRank: r.opponentOffensiveRank ?? null,
  gameTime: r.gameInfo?.gameTime ?? null,
  passingYards: r.passingYards ?? null,
  rushingYards: r.rushingYards ?? null,
  receivingYards: r.receivingYards ?? null,
  receptions: r.receptions ?? null,
  targets: r.targets ?? null,
});

/**
 * One projection set across the position groups that set covers.
 * PPR only exists for skill players — receptions do not affect K or D/ST, and
 * asking for those combinations is rejected.
 */
export async function fetchSet(type) {
  const positions = type === 'PPR' ? ['NFL_SKILL'] : POSITIONS;
  // The position groups are independent queries against the same endpoint.
  const groups = await Promise.all(positions.map((position) => query({ sport: 'NFL', type, position })));
  return groups.flat().map(shape);
}

export async function fanduelSync({ season, week, log = console.log } = {}) {
  const { season: yr, week: wk } = resolveWeek({ season, week });
  const dir = join(DATA, 'fanduel', String(yr));
  mkdirSync(dir, { recursive: true });
  const ok = [], failed = [];
  log(`FanDuel Research (numberFire) — season ${yr}, week ${wk}`);

  const files = { WEEKLY: `week-${wk}-standard`, PPR: `week-${wk}-ppr`, REMAINING: 'remaining' };
  let items = 0;
  for (const [type, file] of Object.entries(files)) {
    try {
      const players = await fetchSet(type);
      writeFileSync(join(dir, `${file}.json`), JSON.stringify({ season: yr, week: wk, type, fetchedAt: new Date().toISOString(), players }, null, 2));
      log(`  ok   ${type.padEnd(10)} ${String(players.length).padStart(4)} players`);
      ok.push(type);
      items = Math.max(items, players.length);
    } catch (err) {
      log(`  FAIL ${type} — ${err.message}`);
      failed.push({ label: type, error: err.message });
    }
  }

  // FanDuel publishes no recompute time and no usable ETag, so `sourceAt` is
  // genuinely unknown here — recording null is the honest answer, and means the
  // freshness report shows this source governed by our clock alone.
  const rep = record('fanduel', { ok, failed, sourceAt: null, season: yr, week: wk, items,
    note: 'no site-published update time' });
  log(`  ${ok.length} ok, ${failed.length} failed -> ${dir}`);
  return rep;
}
