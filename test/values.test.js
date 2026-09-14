import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc } from '../src/export.js';
import { parseEnv } from '../src/config.js';
import { sleeperPoints } from '../src/leaguedata.js';
import { slimWeek } from '../src/sleeperproj.js';

/**
 * Value-level defects: the ones that produce a plausible wrong number rather
 * than an error, which is why each of them survived in the repository for as
 * long as it did.
 */

// ---------------------------------------------------------------- CSV export

test('a CSV field that starts like a formula is neutralised', () => {
  // A team name is user-controlled text going into a file people open in
  // Excel, where `=1+1` is evaluated rather than displayed.
  assert.equal(esc('=1+1'), "'=1+1");
  assert.equal(esc('+SUM(A1)'), "'+SUM(A1)");
  assert.equal(esc('@import'), "'@import");
  assert.equal(esc('=cmd|" /c calc"!A0'), '"\'=cmd|"" /c calc""!A0"');
});

test('a negative number stays a number', () => {
  // It starts with `-`, but quoting it would break the column it is ranked in.
  assert.equal(esc(-2.5), '-2.5');
  assert.equal(esc('-2.5'), '-2.5');
  assert.equal(esc('-12'), '-12');
  // Text that merely begins with a minus is not a number and is quoted.
  assert.equal(esc('-not a number'), "'-not a number");
});

test('quotes, commas and newlines are escaped', () => {
  assert.equal(esc('a,b'), '"a,b"');
  assert.equal(esc('say "hi"'), '"say ""hi"""');
  assert.equal(esc('two\nlines'), '"two\nlines"');
  assert.equal(esc('carriage\rreturn'), '"carriage\rreturn"');
});

test('null and undefined are empty, not the strings', () => {
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(0), '0', 'but zero is a value');
});

// ------------------------------------------------------------------ .env file

test('trailing whitespace is not part of the value', () => {
  // A key with a stray space on the end reads as a REJECTED key, which is the
  // least diagnosable failure this file has.
  assert.equal(parseEnv('FP_API_KEY=abc123   ').get('FP_API_KEY'), 'abc123');
  assert.equal(parseEnv('FP_API_KEY =  abc123\t').get('FP_API_KEY'), 'abc123');
});

test('an unquoted inline comment is not part of the value', () => {
  // `FP_WEEK=3 # pinned` parsed as NaN and then went into a file path.
  assert.equal(parseEnv('FP_WEEK=3 # pinned for testing').get('FP_WEEK'), '3');
  assert.equal(Number(parseEnv('FP_WEEK=3 # pinned').get('FP_WEEK')), 3);
});

test('quotes are stripped and protect what is inside them', () => {
  assert.equal(parseEnv('A="has spaces "').get('A'), 'has spaces ');
  assert.equal(parseEnv("A='#notacomment'").get('A'), '#notacomment');
});

test('blank lines, comments and junk are ignored', () => {
  const env = parseEnv('\n# a comment\nFP_EMAIL=me@example.com\nnot a line\n\n');
  assert.equal(env.get('FP_EMAIL'), 'me@example.com');
  assert.equal(env.size, 1);
});

test('an empty value is empty, not undefined', () => {
  assert.equal(parseEnv('A=').get('A'), '');
});

// ------------------------------------------------- Sleeper's split-out points

test('Sleeper reports hundredths, not a decimal to concatenate', () => {
  // {fpts: 1102, fpts_decimal: 6} is 1102.06. Concatenating made it 1102.6 —
  // ten times the fraction, every time the hundredths were a single digit,
  // which is one week in ten and always in the column standings are ranked on.
  assert.equal(sleeperPoints(1102, 6), 1102.06);
  assert.equal(sleeperPoints(1102, 60), 1102.6);
  assert.equal(sleeperPoints(0, 5), 0.05);
  assert.equal(sleeperPoints(98, 0), 98);
});

test('missing Sleeper points read as zero rather than NaN', () => {
  assert.equal(sleeperPoints(null, null), 0);
  assert.equal(sleeperPoints(undefined, undefined), 0);
  assert.equal(sleeperPoints(100, null), 100);
  assert.equal(sleeperPoints(null, 25), 0.25);
});

// ------------------------------------------ Sleeper projection row slimming

const row = (id, pts, lastModified, extra = {}) => ({
  player_id: id,
  stats: pts == null ? {} : { pts_ppr: pts, pts_half_ppr: pts - 1, pts_std: pts - 2 },
  last_modified: lastModified,
  player: { first_name: 'A', last_name: String(id), position: 'RB', injury_status: null },
  team: 'DET',
  opponent: 'NO',
  date: '2026-09-13',
  ...extra,
});

test('an empty stat block is dropped, not read as a projection of zero', () => {
  // Every player in the league comes back on every week's board.
  const out = slimWeek([row('1', 10, 1000), row('2', null, 2000)], 4);
  assert.equal(out.players.length, 1);
  assert.equal(out.players[0].sleeperId, '1');
});

test('the newest row timestamp becomes the week\'s source time', () => {
  const out = slimWeek([row('1', 10, 1000), row('2', 20, 5000), row('3', 30, 3000)], 4);
  assert.equal(out.sourceAt, new Date(5000).toISOString());
  assert.equal(out.week, 4);
  assert.equal(out.date, '2026-09-13');
});

test('no timestamps at all means no source time, not our own', () => {
  // Reporting our clock as the site's is the conflation freshness.js exists
  // to prevent.
  const out = slimWeek([row('1', 10, undefined)], 4);
  assert.equal(out.sourceAt, null);
});

test('all three scoring formats are kept', () => {
  const [p] = slimWeek([row('1', 10, 1000)], 4).players;
  assert.equal(p.ppr, 10);
  assert.equal(p.half, 9);
  assert.equal(p.std, 8);
  assert.equal(p.opponent, 'NO');
  assert.equal(p.name, 'A 1');
});

test('a garbage body is empty rather than a throw', () => {
  // These are scrapers pointed at sites that change without notice.
  for (const body of [null, undefined, {}, 'nope', 42]) {
    const out = slimWeek(body, 1);
    assert.deepEqual(out.players, []);
    assert.equal(out.sourceAt, null);
  }
});

test('a row that is not an object is skipped', () => {
  const out = slimWeek([null, 'x', row('1', 10, 1000)], 1);
  assert.equal(out.players.length, 1);
});
