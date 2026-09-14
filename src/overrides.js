import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DATA } from './config.js';

/**
 * The things the hosts get wrong, or never say at all.
 *
 * Everything else in this project is read-only: a scrape of what ESPN, Yahoo
 * and Sleeper report. This file is the one place YOUR corrections live, and it
 * is deliberately separate from the scraped model so a re-scrape can never
 * overwrite them.
 *
 * Five kinds of correction, each because the upstream data genuinely cannot
 * carry it:
 *
 *   nickname       league and per-team display names. Hosts expose a team name
 *                  that managers change mid-season; a stable local name is what
 *                  makes a 12-team standings table readable across weeks.
 *
 *   mine           WHICH teams are yours. MyPlaybook reports exactly one
 *                  `teamId` per league, which is wrong for anyone co-managing
 *                  or running two teams in a 14-team league. A list, not a
 *                  scalar, with one marked primary.
 *
 *   divisions      ESPN leagues have them, the MyPlaybook endpoints do not
 *                  return them, and seeding cannot be computed without them.
 *
 *   playoffs       how seeds are actually decided. Every league invents its
 *                  own rule and no host exposes it in a machine-readable form.
 *                  See SEED_RULES.
 *
 *   scoring        stat-by-stat point values. The hosts DO report a scoring
 *                  table, but incompletely — MyPlaybook's Sleeper reading lists
 *                  no defensive stats for a league that scores them — so this
 *                  overlays it rather than replacing it.
 */

const PATH = join(DATA, 'league-overrides.json');

/**
 * Seeding rules, as leagues actually write them.
 *
 * These are the shapes seen in real leagues, not a general expression language:
 * a rule you cannot name is a rule nobody can verify later.
 *
 *   record         wins, then the tiebreaker, straight down the table.
 *   division-first N division winners are locked into the top N seeds, ordered
 *                  among themselves by the tiebreaker; everyone else follows on
 *                  record. This is the ESPN default.
 *   points-wildcard the top N seeds go by record; the LAST seed goes to the
 *                  highest points-for among teams that missed on record. The
 *                  Sleeper "seed 6 is most points scored among 6-12" rule.
 */
export const SEED_RULES = {
  record: {
    label: 'Best record',
    describe: (c) => `Seeds 1–${c.playoffTeams ?? '?'} by record, ties broken by ${TIEBREAK[c.tiebreak]?.label?.toLowerCase() ?? 'points for'}.`,
  },
  'division-first': {
    label: 'Division winners seeded first',
    describe: (c) => `Top ${c.divisionSeeds ?? 2} seeds are division winners; the rest by record, ties broken by ${TIEBREAK[c.tiebreak]?.label?.toLowerCase() ?? 'points for'}.`,
  },
  'points-wildcard': {
    label: 'Last seed by points scored',
    describe: (c) => `Seeds 1–${(c.playoffTeams ?? 6) - (c.wildcards ?? 1)} by record; the final ${c.wildcards ?? 1} by most points for among everyone who missed.`,
  },
};

export const TIEBREAK = {
  pointsFor: { label: 'Points for' },
  headToHead: { label: 'Head to head' },
  pointsAgainst: { label: 'Fewest points against' },
};

/** A league's override record, fully populated with nulls. */
export const emptyLeague = () => ({
  nickname: null,
  myTeamIds: [],
  primaryTeamId: null,
  teams: {},        // teamId -> { nickname, division }
  divisions: [],    // [{ id, name }]
  playoffs: {
    rule: null,           // key of SEED_RULES
    playoffTeams: null,
    divisionSeeds: null,
    wildcards: null,
    tiebreak: null,       // key of TIEBREAK
    startWeek: null,
    note: null,
  },
  /**
   * Stat -> points, overlaying whatever the host's scoring table says.
   *
   * MyPlaybook returns each league's scoring system, but not always completely
   * — its Sleeper reading carries no defensive stats for a league that scores
   * them. This is where you correct or complete it. Keys are the host's own
   * stat names (PassTD, IntQB, RecWR, PtsAllow…) and the value is points per
   * unit; a banded stat like FG is left to the scraped table.
   */
  scoring: {},
  waivers: {
    type: null,           // 'rolling' | 'faab' | 'reverse' | 'none'
    // How long a dropped player sits on waivers before clearing to free agency.
    claimDays: null,
    // Day of week (0=Sun) claims process, and the hour, local. Sleeper and ESPN
    // both have one; neither exposes it through any endpoint reachable here.
    processDay: null,
    processHour: null,
    note: null,
  },
  notes: null,
});

export function load() {
  if (!existsSync(PATH)) return { leagues: {} };
  try {
    const j = JSON.parse(readFileSync(PATH, 'utf8'));
    return { leagues: j.leagues || {} };
  } catch {
    return { leagues: {} };
  }
}

export function save(state) {
  mkdirSync(dirname(PATH), { recursive: true });
  writeFileSync(PATH, JSON.stringify({ updatedAt: new Date().toISOString(), leagues: state.leagues }, null, 2));
  return PATH;
}

/** One league's overrides, merged over the empty shape so callers can index freely. */
export function forLeague(key, state = load()) {
  const o = state.leagues[key] || {};
  const base = emptyLeague();
  return {
    ...base,
    ...o,
    playoffs: { ...base.playoffs, ...(o.playoffs || {}) },
    waivers: { ...base.waivers, ...(o.waivers || {}) },
    scoring: { ...(o.scoring || {}) },
    teams: { ...(o.teams || {}) },
    divisions: o.divisions || [],
    myTeamIds: o.myTeamIds || [],
  };
}

/** Merge a patch into one league and persist. Returns the merged record. */
export function update(key, patch) {
  const state = load();
  const cur = forLeague(key, state);
  const next = {
    ...cur,
    ...patch,
    playoffs: { ...cur.playoffs, ...(patch.playoffs || {}) },
    waivers: { ...cur.waivers, ...(patch.waivers || {}) },
    scoring: { ...cur.scoring, ...(patch.scoring || {}) },
    teams: { ...cur.teams, ...(patch.teams || {}) },
  };
  state.leagues[key] = next;
  save(state);
  return next;
}

/** Set a single team's override fields without disturbing the others. */
export function setTeam(key, teamId, patch) {
  const cur = forLeague(key);
  return update(key, { teams: { ...cur.teams, [String(teamId)]: { ...(cur.teams[String(teamId)] || {}), ...patch } } });
}

/**
 * Apply overrides onto a scraped league in place.
 *
 * The scraped values are kept alongside under `*Scraped` rather than
 * overwritten, so the UI can show that a name is yours and what it replaced —
 * an override you cannot see is indistinguishable from bad data.
 */
export function applyToLeague(league, o = forLeague(league.key)) {
  if (o.nickname) {
    league.nicknameScraped = league.nickname;
    league.nickname = o.nickname;
  }
  const mine = new Set((o.myTeamIds || []).map(String));
  // An explicit list wins outright; with none, the host's single teamId stands.
  const hasExplicit = mine.size > 0;
  for (const t of league.teams || []) {
    const id = String(t.teamId ?? t.id);
    const ov = o.teams[id];
    if (ov?.nickname) {
      t.nameScraped = t.name;
      t.name = ov.nickname;
    }
    if (ov?.division != null) t.division = ov.division;
    if (hasExplicit) {
      t.isMine = mine.has(id);
      t.isPrimary = String(o.primaryTeamId ?? [...mine][0]) === id;
    } else if (t.isMine) {
      t.isPrimary = true;
    }
  }
  if (hasExplicit) {
    league.myTeamIdScraped = league.myTeamId;
    league.myTeamId = o.primaryTeamId ?? [...mine][0] ?? league.myTeamId;
  }
  league.divisions = o.divisions;
  league.overrides = o;
  return league;
}

/**
 * Compute playoff seeds from standings under a league's own rule.
 *
 * Returns null when no rule is configured — a guessed bracket is worse than an
 * absent one, because it looks authoritative.
 */
export function seed(standings, cfg) {
  if (!cfg?.rule || !standings?.length) return null;
  const n = cfg.playoffTeams ?? standings.length;
  const tb = cfg.tiebreak || 'pointsFor';
  const cmpTie = (a, b) => (
    tb === 'pointsAgainst' ? (a.pointsAgainst ?? 0) - (b.pointsAgainst ?? 0)
      : (b.pointsFor ?? 0) - (a.pointsFor ?? 0)
  );
  const byRecord = (a, b) => (b.wins ?? 0) - (a.wins ?? 0) || (a.losses ?? 0) - (b.losses ?? 0) || cmpTie(a, b);
  const rows = standings.slice();

  if (cfg.rule === 'record') {
    return rows.sort(byRecord).map((t, i) => ({ ...t, seed: i + 1, in: i < n, why: 'record' }));
  }

  if (cfg.rule === 'division-first') {
    const locked = cfg.divisionSeeds ?? 2;
    const byDiv = new Map();
    for (const t of rows) {
      const d = t.division ?? '_none';
      if (!byDiv.has(d) || byRecord(t, byDiv.get(d)) < 0) byDiv.set(d, t);
    }
    const winners = [...byDiv.values()].sort(byRecord).slice(0, locked);
    const wset = new Set(winners);
    const rest = rows.filter((t) => !wset.has(t)).sort(byRecord);
    return [...winners.map((t) => ({ ...t, why: 'division winner' })), ...rest.map((t) => ({ ...t, why: 'record' }))]
      .map((t, i) => ({ ...t, seed: i + 1, in: i < n }));
  }

  if (cfg.rule === 'points-wildcard') {
    const wc = cfg.wildcards ?? 1;
    const onRecord = rows.slice().sort(byRecord);
    const auto = onRecord.slice(0, Math.max(0, n - wc));
    const aset = new Set(auto);
    // The wildcard is decided on points alone, among everyone who missed.
    const wild = rows.filter((t) => !aset.has(t)).sort((a, b) => (b.pointsFor ?? 0) - (a.pointsFor ?? 0)).slice(0, wc);
    const wset = new Set(wild);
    const out = rows.filter((t) => !aset.has(t) && !wset.has(t)).sort(byRecord);
    return [
      ...auto.map((t) => ({ ...t, why: 'record' })),
      ...wild.map((t) => ({ ...t, why: 'points wildcard' })),
      ...out.map((t) => ({ ...t, why: 'missed' })),
    ].map((t, i) => ({ ...t, seed: i + 1, in: i < n }));
  }
  return null;
}

export const describeRule = (cfg) => (cfg?.rule && SEED_RULES[cfg.rule] ? SEED_RULES[cfg.rule].describe(cfg) : null);
export const OVERRIDES_PATH = PATH;
