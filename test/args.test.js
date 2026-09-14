import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, resolveLeague } from '../src/args.js';

/**
 * The bug this file exists for: nothing distinguished a boolean flag from an
 * option with a value, so the token after ANY `--x` was consumed as its value.
 * The documented `players [--refresh] [query]` searched for nothing, and
 * `roster --refresh Cville` printed every league.
 */

test('a boolean flag does not eat the argument after it', () => {
  const a = parseArgs(['--refresh', 'gibbs']);
  assert.equal(a.flag('refresh'), true);
  assert.deepEqual(a.positional, ['gibbs']);
});

test('an option does consume the argument after it', () => {
  const a = parseArgs(['--position', 'RB', 'gibbs']);
  assert.equal(a.opt('position'), 'RB');
  assert.deepEqual(a.positional, ['gibbs']);
});

test('flags and options mix in any order', () => {
  const a = parseArgs(['Cville', '--dry-run', '--week', '5', '--force', 'extra']);
  assert.equal(a.flag('dry-run'), true);
  assert.equal(a.flag('force'), true);
  assert.equal(a.opt('week'), '5');
  assert.deepEqual(a.positional, ['Cville', 'extra']);
});

test('flag() and opt() do not answer for each other', () => {
  const a = parseArgs(['--week', '5', '--force']);
  // `--week 5` is not a flag, and `--force` has no value. Conflating the two
  // is how `--clear` got read as a league name.
  assert.equal(a.flag('week'), false);
  assert.equal(a.opt('force'), null);
  assert.equal(a.flag('nothing'), false);
  assert.equal(a.opt('nothing'), null);
});

test('an option at the end of the line parses as null, not undefined', () => {
  const a = parseArgs(['--season']);
  assert.equal(a.opt('season'), null);
  assert.deepEqual(a.positional, []);
});

test('a repeated option keeps the last value', () => {
  // What someone typing over their own mistake expects. The old filter used
  // indexOf, which resolved to the FIRST occurrence and classified repeated
  // arguments by the wrong neighbour.
  const a = parseArgs(['--week', '3', '--week', '9']);
  assert.equal(a.opt('week'), '9');
});

test('no arguments at all', () => {
  const a = parseArgs([]);
  assert.deepEqual(a.positional, []);
  assert.equal(a.flag('force'), false);
});

test('a negative number is a positional, not a flag', () => {
  const a = parseArgs(['--limit', '-5']);
  assert.equal(a.opt('limit'), '-5');
});

// --------------------------------------------------------- league resolution

const leagues = [
  { key: 'abc123', nickname: 'Cville 2026' },
  { key: 'def456', nickname: 'Sigma Chi 23' },
  { key: 'ghi789', nickname: 'Sigma Chi 23 B' },
];

test('the longest matching league name wins', () => {
  // So `league:team "Sigma Chi 23 B" ...` is unambiguous without quoting.
  const r = resolveLeague(leagues, ['Sigma', 'Chi', '23', 'B', 'Bench', 'Mob']);
  assert.equal(r.league.key, 'ghi789');
  assert.equal(r.rest, 'Bench Mob');
});

test('a league name with spaces splits from the rest correctly', () => {
  const r = resolveLeague(leagues, ['Cville', '2026', '4', 'New', 'Name']);
  assert.equal(r.league.key, 'abc123');
  assert.equal(r.rest, '4 New Name');
});

test('a league key resolves as well as a name', () => {
  const r = resolveLeague(leagues, ['def456', 'rest']);
  assert.equal(r.league.key, 'def456');
  assert.equal(r.rest, 'rest');
});

test('a short nickname falls back to a substring match', () => {
  const r = resolveLeague(leagues, ['cville']);
  assert.equal(r.league.key, 'abc123');
  assert.equal(r.rest, '');
});

test('no match throws rather than picking one', () => {
  assert.throws(() => resolveLeague(leagues, ['nonsense']), /No league matched/);
  assert.throws(() => resolveLeague([], ['Cville']), /No league matched/);
});
