import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlayerBlock, parseRankingsTable } from '../src/draftsharks.js';
import { parseEspnSchedule } from '../src/schedule.js';
import { parseHorizon, weeksIn, labelHorizon, horizonOptions } from '../src/weekhorizon.js';
import { parseMatchup, normTeam, normPos } from '../src/teams.js';
import { shapeFromPoints, preferredShape, weekFromRos, shapeFor } from '../src/weekshape.js';

const GIBBS = `
<tbody
    data-player-row
    data-key="13542"
    data-tier-overall="1"
    data-tier-positional="1"
    data-fantasy-position="RB"
    data-player-name="Jahmyr Gibbs"
    data-team-id="11"
    class="">
    <tr class="player-row">
        <td class="ds-cell ds-cell--lg rank centered">
            <div class="column-title rank-index"><span>1</span></div>
        </td>
        <td class="player-cell">
            <img class="team-badge" src="/img/icons/teams/DET.svg" alt="DET logo" />
            <span class="player-details-group__team-name">DET</span>
        </td>
        <td class="ds-cell matchup centered" data-value="@IND" data-attribute="matchup"><span>@IND</span></td>
        <td class="ds-cell" data-value="7.9%" data-attribute="strength_of_schedule"><span>7.9%</span></td>
        <td class="ds-cell" data-value="13" data-attribute="player.team.bye"><span>13</span></td>
        <td class="ds-cell" data-value="18" data-attribute="weeklyFloorPts"><span>18.0</span></td>
        <td class="ds-cell" data-value="19.5" data-attribute="consensus_projection"><span>19.5</span></td>
        <td class="ds-cell ds-proj centered" data-value="20.4" data-attribute="weeklyPts"><span>20.4</span></td>
        <td class="ds-cell" data-value="25.5" data-attribute="weeklyCeilingPts"><span>25.5</span></td>
        <td class="ds-cell" data-value="20.9" data-attribute="weekly3dPts"><span>20.9</span></td>
    </tr>
</tbody>`;

test('Draft Sharks weekly row: name, team, matchup, DS proj', () => {
  const p = parsePlayerBlock(GIBBS);
  assert.equal(p.name, 'Jahmyr Gibbs');
  assert.equal(p.position, 'RB');
  assert.equal(p.team, 'DET');
  assert.equal(p.opp, 'IND');
  assert.equal(p.home, false);
  assert.equal(p.proj, 20.4);
  assert.equal(p.d3, 20.9);
  assert.equal(p.floor, 18);
  assert.equal(p.ceiling, 25.5);
  assert.equal(p.consensus, 19.5);
  assert.equal(p.rank, 1);
  assert.equal(p.sos, 7.9);
});

test('Draft Sharks table parser finds every tbody row', () => {
  const html = GIBBS + GIBBS.replace('Jahmyr Gibbs', 'Bijan Robinson').replace('20.4', '19.1');
  const rows = parseRankingsTable(html);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].name, 'Bijan Robinson');
  assert.equal(rows[1].proj, 19.1);
});

test('team / matchup aliases', () => {
  assert.equal(normTeam('JAX'), 'JAC');
  assert.equal(normTeam('WSH'), 'WAS');
  assert.equal(normPos('DEF'), 'DST');
  assert.deepEqual(parseMatchup('@IND'), { opp: 'IND', home: false, bye: false });
  assert.deepEqual(parseMatchup('WAS'), { opp: 'WAS', home: true, bye: false });
  assert.equal(parseMatchup('BYE').bye, true);
});

test('horizon keys expand to week lists', () => {
  const w = parseHorizon('w-7', { now: 1 });
  assert.equal(w.kind, 'week');
  assert.deepEqual(weeksIn(w), [7]);
  const n3 = parseHorizon('n-3', { now: 2 });
  assert.deepEqual(weeksIn(n3), [2, 3, 4]);
  assert.equal(labelHorizon(n3, { now: 2 }), 'Next 3 weeks');
  const ros = parseHorizon('ros', { now: 14 });
  assert.deepEqual(weeksIn(ros), [14, 15, 16, 17, 18]);
  const p = parseHorizon('p', { now: 1 });
  assert.deepEqual(weeksIn(p), [15, 16, 17]);
  const labels = horizonOptions({ now: 1 }).map((o) => o.value);
  assert.ok(labels.includes('w-1'));
  assert.ok(labels.includes('n-3'));
  assert.ok(labels.includes('ros'));
  assert.ok(labels.includes('szn'));
});

test('Draft Sharks shape redistributes another source without using Sleeper', () => {
  const shape = shapeFromPoints({ 1: 20, 2: 10, 3: 0, 4: 10 }, { fromWeek: 1, byeWeeks: [3], source: 'ds' });
  assert.equal(shape.source, 'ds');
  assert.equal(shape.total, 40);
  assert.equal(weekFromRos(100, shape, 1), 50);
  assert.equal(weekFromRos(100, shape, 3), 0);
  const sleeper = shapeFromPoints({ 1: 1, 2: 1, 3: 1, 4: 1 }, { fromWeek: 1, source: 'sleeper' });
  assert.equal(preferredShape(shape, sleeper).source, 'ds');
  assert.equal(preferredShape(null, sleeper).source, 'sleeper');
});

test('missing Sleeper cell is not a bye when the schedule says they play', () => {
  const weeks = { 1: { ppr: 20 }, 2: { ppr: 10 } };
  const shape = shapeFor(weeks, { fromWeek: 1, throughWeek: 4, scoring: 'PPR', byeWeeks: [3] });
  assert.deepEqual(shape.byes, [3]);
  assert.equal(shape.points[4], 0);
  assert.ok(!shape.byes.includes(4));
});

test('a one-week Draft Sharks file does not steal the remaining-season shape', () => {
  const ds = shapeFromPoints({ 1: 20 }, { fromWeek: 1, throughWeek: 4, source: 'draftsharks' });
  const sl = shapeFromPoints({ 1: 10, 2: 10, 3: 10, 4: 10 }, { fromWeek: 1, throughWeek: 4, source: 'sleeper' });
  assert.equal(ds.covered, 1);
  assert.equal(preferredShape(ds, sl).source, 'sleeper');
});

test('ESPN schedule parser maps home/away and aliases JAX', () => {
  const json = {
    content: {
      schedule: {
        '20260910': {
          games: [{
            id: '1',
            date: '2026-09-10T17:00Z',
            shortName: 'JAX @ WSH',
            competitions: [{
              competitors: [
                { homeAway: 'home', team: { abbreviation: 'WSH' } },
                { homeAway: 'away', team: { abbreviation: 'JAX' } },
              ],
            }],
          }],
        },
      },
    },
  };
  const games = parseEspnSchedule(json, { week: 1 });
  assert.equal(games.length, 1);
  assert.equal(games[0].home, 'WAS');
  assert.equal(games[0].away, 'JAC');
});
