# ff091126 — FantasyPros scraper

Two data sources, joined:

1. **MyPlaybook** (`mpbnfl.fantasypros.com/api`) — your actual leagues across
   **ESPN, Yahoo, and Sleeper**, via the undocumented endpoints the mobile app uses.
2. **VegasEdgeFantasy** (`vegasedgefantasy.com`) — sportsbook-derived
   projections for the current week, per bookmaker. Compared side-by-side
   against FantasyPros.
3. **Sleeper** (`api.sleeper.app`) — the player universe that bridges the id
   spaces, plus headshots from `sleepercdn.com`.
4. **Yahoo BuzzIndex** (`football.fantasysports.yahoo.com/f1/buzzindex`) — how
   many managers across **every Yahoo league** tried to add, drop or trade each
   player on a given day. No login. The demand side of the market.
5. **Sleeper trending** (`api.sleeper.app/.../trending`) — the same thing as a
   rolling lookback rather than a calendar day, which is what lets it be
   differenced into an add *rate* and a change in rate.
6. **Sleeper projections** (`api.sleeper.com/projections/nfl/<season>/<week>`) —
   a projection for **every player in every week of the season**, in all three
   scoring formats, and the only source here that publishes its own recompute
   time on every row. One request per week is the whole season.
7. **FantasyPros universal data** — rankings, projections, points, news,
   injuries, both **current week** and **rest of season**. Two interchangeable
   backends:
   - the **public API v2** (`api.fantasypros.com/public/v2/json`), needs a key
   - **public-page scraping**, needs *no key* and is the default fallback

`enrich` joins all of it, so every rostered player carries this week's FP
projection and rank, its ROS projection and rank, the Vegas line and the delta
between them, the market's floor–ceiling distribution, injury status, a headshot
URL, and how hard the rest of fantasy football is currently bidding for him.

### Every source publishes this week, and a season total, and nothing between

Five sources project the coming Sunday. Three of them — WinWithOdds, First Down
and FanDuel — publish a **full-season total** alongside it and nothing weekly
beyond that, so `enrich` derives rest-of-season by subtracting the points a
player has already scored. That leaves one number standing for thirteen
remaining games, which cannot be put beside a weekly projection and cannot
answer the question a trade or a playoff-week plan actually asks.

Sleeper projects every week, so the **shape** of a season is available even
where a source only published its total. Normalised into per-week shares that
sum to 1, that shape carries the schedule, the byes and the opponent — and no
opinion at all about how good the player is, because the level divides out. So
another source's total can be spread across the weeks it has left in that
source's own magnitude:

```
Jahmyr Gibbs, PPR, weeks 1–18, bye wk 6

  WK  OPP    SLEEPER   SHARE       FP      WWO       FD  FANDUEL   BLENDED
   1  NO        22.10    5.5%    22.11    16.19    15.89    16.09     17.57
   6  BYE        0.00    0.0%        0        0        0        0         0
  12  CHI       24.78    6.2%    24.79    18.15    17.81    18.04     19.70
  16  NYG       26.00    6.5%    26.01    19.04    18.69    18.92     20.67
```

Each row is that source's season total on Sleeper's calendar. It is a
redistribution, not a projection, and it is labelled and rendered as one
everywhere it appears — but it is the difference between "WinWithOdds likes him
for the rest of the year" and "WinWithOdds has him at 19 in week 16". The
weekly figures always add back up to the total they came from.

`proj <player>` prints the table above; the dashboard's **Week by Week** page is
the same thing for a whole roster, with a per-week team total.

### Why the demand signal is separate from everything else

Every projection source here answers *how many points will he score*. None of
them answers *will he still be available in an hour*, and on a Thursday night
that is the only question a waiver claim turns on. Projection sites republish on
their own schedule — hours, sometimes a day. The buzz boards move the moment a
game ends.

The two demand sources are pulled together because they fail differently:

| | Yahoo BuzzIndex | Sleeper trending |
|---|---|---|
| time unit | one completed calendar day | rolling lookback (6h / 24h / 72h) |
| key | Yahoo player id | Sleeper player id |
| reports | adds, drops, trades, % rostered, % started | adds and drops only |
| best at | separating a real wave from two-way churn | telling you the wave is happening *now* |

Differencing Sleeper's 6h and 24h windows gives adds-per-hour now against
adds-per-hour before, and that ratio is the number worth acting on. Week 1, the
Sunday after the games:

```
Devin Singletary   99,999 adds/24h    16,428/hr now    206x prior rate    1% rostered
Michael Mayer     384,678 adds/24h     6,436/hr now   0.33x prior rate   26% rostered
```

Mayer has the bigger number and is the worse claim — that wave broke hours ago
and most leagues have already taken him. Singletary *is* the wave. Volume tells
you who has been claimed; acceleration tells you who is being claimed.

Zero dependencies. Node 20+.

## Setup

```bash
cp .env.example .env     # add your account email + API key
npm run leagues          # verify it sees your leagues
npm run sync             # every source, skipping whatever is still fresh
```

### Which command to run

| Command | What it does |
|---|---|
| `npm run sync` | **the one to run.** Every source, but only the ones that have gone stale; then join + rebuild the dashboard. |
| `npm run sync -- --force` | ignore freshness, fetch everything |
| `npm run sync -- --only buzz,trend` | just these steps |
| `npm run sync -- --dry-run` | say what would run, fetch nothing |
| `npm run status` | per-source age, and the site's own last-recompute time |
| `npm run all` | unconditional: every sync, no freshness check |
| `npm run live` | the two minute-by-minute sources only |

`sync` exists because `all` was eleven unconditional network calls: re-running
it two minutes later re-pulled every source, including the ones that publish a
timestamp saying nothing had changed. Each source declares how often it actually
republishes (`MAX_AGE_MIN` in `src/freshness.js`) and is skipped under it. The
joins always run — a skipped fetch still leaves the previous fetch un-joined if
a different source moved.

### Two clocks, tracked separately

`data/freshness.json` records, per source, **when we fetched** and **when the
site itself last recomputed**. They are not the same thing and conflating them
hides the case that matters: a source fetched a minute ago that is still serving
yesterday's numbers.

| Source | Publishes its own update time? |
|---|---|
| FantasyPros | yes — `last_updated_ts` on every board |
| WinWithOdds | yes — a `rankings-updated-at` block on each page |
| First Down Studio | yes — `generated_at` on the snapshot |
| Yahoo BuzzIndex | yes — the board *is* a date |
| Sleeper projections | yes — `last_modified` on **every row**, and a per-week ETag on top |
| Sleeper player dump | via ETag, so the refresh is a conditional GET: a 304 keeps the 15MB cache |
| VegasEdge, FanDuel, MyPlaybook, Sleeper trending | **no.** None publishes a recompute time or a usable validator, so those are governed by our clock alone — reported as blank rather than echoing our own fetch time back. |

`status` prints both clocks side by side plus a **`moved`** column: whether the
site's own timestamp changed between our last two pulls. That is the reading
that tells you whether polling is achieving anything, and a row that is freshly
fetched and has not moved is flagged `site is behind` — the case that looks fine
and is not.

The Sleeper projection set has **eighteen** source clocks, not one, and they
genuinely differ. Measured mid-week-1: the live week had been recomputed four
minutes earlier while weeks 2–18 had not moved since the previous night's
batch. So `sleeper:proj` re-pulls the live week on a 20-minute TTL and the rest
of the season only when it is missing or the nightly batch has since run, and
`status --weeks` shows every week's own recompute time:

```
  WK  SITE RECOMPUTED           AGE      PLAYERS  OUR PULL
   1  2026-09-14T07:31:04.044Z      23m      456  5m
   2  2026-09-13T23:46:04.382Z    8h 8m      490  5m
  18  2026-09-13T23:46:02.531Z    8h 8m      511  5m
```

Every week is also an ETag-conditional GET, so re-asking for all eighteen costs
eighteen 304s and no payload — about two seconds. That is what makes polling the
live week affordable rather than a 36MB download.

`npm run live` is the short-interval loop: the sources that move inside an hour
(`trend`, `buzz`, `matchups`, `sleeper-proj`), and then the joins, which are
exempt from `--only` because re-fetching a source you cannot then see on the
page has achieved nothing.

The halves of the pipeline are independent:
`scrape` needs only `FP_EMAIL`; `fp:sync` uses the API key if it works and
otherwise falls back to scraping, so **no key is required for anything**.

## Commands

| Command | What it does |
|---|---|
| `node src/cli.js leagues` | list every league on the account + its key |
| `node src/cli.js scrape` | pull all endpoints → `data/raw/<ts>/` + `data/latest.json` |
| `node src/cli.js scrape --league Cville` | scrape one league |
| `node src/cli.js roster [name]` | print resolved rosters w/ ECR |
| `node src/cli.js transactions [name]` | print the move log — add and the drop that paid for it on one line |
| `node src/cli.js players [--refresh] [query]` | build/search the fpId → player dictionary |
| `node src/cli.js export` | write `leagues.csv`, `rosters.csv`, `transactions.csv` |
| `node src/cli.js endpoints` | show the discovered API surface |

### Choosing which leagues sync

Leagues are **active by default** — a newly discovered league is never silently
skipped. Deactivating is explicit and persists in `data/leagues-state.json`.

| Command | What it does |
|---|---|
| `leagues` | list all leagues with their on/off state |
| `leagues:off <name>` | drop a league from every sync |
| `leagues:on <name>` | put it back |
| `leagues:only <name>...` | keep only these active |
| `leagues:all` | reactivate everything |
| `scrape --limit N` | truncate to the first N active leagues |
| `scrape --all` | ignore the toggles for one run |

### VegasEdgeFantasy (needs `VEGAS_TOKEN`)

| Command | What it does |
|---|---|
| `vegas:check` | validate the session cookie, show its expiry |
| `vegas:sync [--bookmaker A,B]` | pull QB/RB/WR/TE boards → `data/vegas/` |
| `vegas:dist [--scoring PPR] [--limit N]` | per-player floor/ceiling/boom/bust distributions |
| `vegas:rankings [--position flex\|qb\|rb\|wr\|te]` | one board, printed |
| `compare [--position RB] [--by-diff]` | Vegas vs FantasyPros side by side |

VegasEdge's ranking board publishes a point estimate only. `vegas:dist` pulls
the site's own 10,000-sample alt-line simulation from `/player/{name}/boombust`
— p5 through p95, boom and bust probabilities — reweighted server-side to
whatever scoring you pass, so the number is directly comparable to a league's
own. Roughly half the board has a market too thin to simulate; those players
keep a projection and get no range, which is reported rather than guessed at.

### League-wide live scores — on ESPN and Yahoo too

| Command | What it does |
|---|---|
| `matchups:sync` | every matchup in every league → `data/scores/<season>/week-N.json` |
| `matchups [league]` | this week's board, printed |

MyPlaybook's matchup endpoint takes a `teamId` **and answers for any team in the
league, not just yours**. That one fact is what makes a league-wide live
scoreboard possible on ESPN and Yahoo, neither of which exposes scores anywhere
else reachable from here. Ask once per team, skip the ones already seen in a
fetched pairing, and a 12-team league costs 6 requests.

It is also the only way to get points for and against on those hosts. The
projected-standings endpoint has records and playoff odds for every host but no
points, and the matchup endpoint has no `week` parameter — it only ever answers
for the current week. So season totals for ESPN and Yahoo cannot be fetched at
all; they are **accumulated**, one sync at a time, from the finished matchups on
disk. Every total carries how many games it actually counts.

The board keeps **every lineup slot for every team**, not a count of them — which
is what fixed the per-player points (below) and what lets the Matchup page open
any pairing in the league rather than only yours.

### Per-player points come from the league, not from a generic PPR file

`data/scores/<season>/week-N.json` carries MyPlaybook's `points` per player, and
MyPlaybook has applied **the league's own scoring table**. That matters more than
it sounds:

```
Sleeper league, week 1 — 12 players disagreed with the old number, all QBs:
  Drake Maye      9.82 vs 12.82   (3 INT)
  Tyler Shough   23.20 vs 25.20   (2 INT)
  Joe Burrow     14.16 vs 15.16   (1 INT)
```

Exactly 1.00 per interception. FantasyPros' generic file scores an interception
at -1; that league scores it at -2, and the PTS column was reading the generic
file. It now reads the league's, for every roster in the league — the board asks
per team, so it covers all of them, and it is the only per-player actual that
exists for ESPN and Yahoo at all.

One caveat, found by checking the parts against the whole: on one Yahoo league,
MyPlaybook's per-player points sum 1–3 above what Yahoo reports for the team, on
five teams of twelve. ESPN and Sleeper agree exactly. The team score is the
host's own live figure, so that is what the scoreboard, the standings and the
matchup totals use; where the rows disagree with it the matchup total says so
rather than quietly printing a third number the league has never seen.

The league's scoring table itself is scraped too (it was in the settings payload
all along) and shown in **League Setup → Scoring**, beside the host's own table
where the host publishes one. Sleeper does, and its version is the more complete
of the two: MyPlaybook's Sleeper read lists no defensive stats for a league that
scores them. Both columns are shown rather than merged, and you can override any
row — a disagreement between two sources should be visible, not averaged.

### Standings

**One table whatever the host is**, sortable by any column and linkable
(`#page=standings&view=division&sort=pf&mode=proj`):

- **`#` is the standard rank: record, then points for.** Every league, same rule.
  It used to be the playoff seed where a seeding rule existed, which conflated two
  questions — a division winner can be seeded first from fourth place, and the
  table then numbered them 1 while the record said otherwise. The seed still
  decides who is *in*, shows beside the number when it differs, and is on the
  tooltip.
- **Records change only when a game finishes.** A matchup in progress does not
  reorder the table while you are watching it. `If leaders hold` is the opt-in to
  the other reading: every unfinished game counted to whoever is ahead, or
  projected higher before kickoff — and PF/PA follow it, because a record and a
  points total that disagree about which games happened is worse than either
  alone.
- **PF/PA count every finished matchup**, with the game count carried so a row
  over one game never reads as a season. This used to require the whole week to
  be final, which meant one Monday-night game left the column blank for the
  entire league — the number exists, and refusing to show it is not accuracy.
- **Week N shows the score over the projected final** — MyPlaybook's own figure,
  which already counts banked points plus what is left, so a team with four
  players still to play reads correctly.
- **Playoff position is a row fill, not just a divider.** Sorting by points or
  grouping by division breaks rank order, and a line drawn at a fixed row index
  would then sit in the wrong place while still looking authoritative. The
  labelled cut line draws only when the current sort genuinely puts the
  qualifiers on top.
- **Seeds are computed in the page**, on the merged rows. They used to be
  computed off Sleeper's standings, which meant a rule configured for an ESPN or
  Yahoo league silently did nothing.
- **By division** splits into one table per division, ranks preserved.

### Matchup

Any pairing in the league, not just yours — arrows and a strip of every game
across the top, and the pairing is in the URL (`#page=matchup&mu=1-9`). Rows are
slot-by-slot with the position badge down the middle, each player's game and its
score under his name, his league-scored points, and the projection to read them
against: the pre-game number once his game is over (coloured by the gap), the
live projected final while it is running.

### Your corrections (`data/league-overrides.json`)

Everything else here is read-only: a scrape of what ESPN, Yahoo and Sleeper
report. This is the one place your corrections live, in a file a re-scrape never
touches.

| Command | What it does |
|---|---|
| `league [name]` | show a league's overrides + its team ids |
| `league:name <league> <name>` | rename a league |
| `league:team <league> <id> <name>` | rename a team |
| `league:mine <league> <id> [id...]` | which teams are yours — first is primary |
| `league:division <league> <id> <name>` | assign a team to a division |
| `league:playoffs <league> --rule R ...` | how seeds are actually decided |
| `league:waivers <league> --claim-days N ...` | waiver mechanics no host exposes |
| `league:import <file.json>` | apply a patch exported from the dashboard |

Five things the upstream data genuinely cannot carry:

- **Which teams are yours.** MyPlaybook reports exactly one `teamId` per league.
  That is wrong for anyone co-managing or running two teams, so this is a list
  with one marked primary — and My Team grows a switcher when you have more than
  one.
- **Divisions.** ESPN leagues have them; the endpoints reachable here do not
  return them, and seeding cannot be computed without them.
- **Seeding rules.** Every league invents its own and no host exposes it:

  ```
  league:playoffs "Sigma Chi 23" --rule points-wildcard --teams 6 --wildcards 1
  #   seeds 1-5 by record; seed 6 is most points scored among everyone who missed

  league:playoffs "Cville 2026" --rule division-first --teams 6 --division-seeds 2
  #   seeds 1-2 locked for division winners; the rest by record
  ```

  Standings then draws the real bracket. Without a rule it draws none — a
  guessed bracket looks authoritative and isn't.
- **Waiver mechanics.** A claim period and a processing day turn "unrostered"
  into "on waivers until Wednesday 3am" versus "free agent, first come", which
  are different decisions.
- **Scoring.** The hosts *do* report a scoring table — but incompletely, and they
  disagree with each other. League Setup shows both readings side by side and
  keeps your corrections in a third column.

The dashboard's **League Setup** page edits all of it in the browser (saved to
localStorage), and **Export edits** writes the JSON for `league:import` so the
changes survive a rebuild.

### Demand signals (no credentials)

| Command | What it does |
|---|---|
| `buzz:sync [--days N] [--date YYYY-MM-DD]` | Yahoo BuzzIndex → `data/buzz/<season>/<date>.json` |
| `buzz [--date YYYY-MM-DD] [--limit N]` | one day's board, printed |
| `trend:sync` | Sleeper trending → `data/trend/<season>/` |
| `trend [--velocity] [--limit N]` | live adds, or adds acceleration |
| `signal <player name> [--position RB]` | both boards for one player |

### Week-by-week projections

| Command | What it does |
|---|---|
| `sleeper:proj` | live week always, rest of season when stale → `data/sleeper/<season>/projections.json` |
| `sleeper:proj --full` | force all 18 weeks (~4s cold, ~2s when nothing has moved) |
| `sleeper:proj --week N` | one week only |
| `proj <player> [--scoring PPR] [--from N]` | the week-by-week table, with every source's total spread across it |
| `proj:ages` | when the site last recomputed each week |
| `status --weeks` | the same, appended to the freshness table |

514 players × 18 weeks is 480KB stored, out of 36MB fetched — the response is
mostly player biography repeated on every row, and only players with an actual
projection are kept, because an empty stat block is not a projection of zero. A
bye arrives as an explicit `null`, which is why it stays distinguishable from
zero all the way to the page.

The Yahoo board caps at 50 rows per request with no pagination, so `buzz:sync`
fans out over position tabs × sort orders (adds / drops / total) and merges by
Yahoo id — about 350 players a day rather than 50. `--days N` backfills, which
is what makes the day-over-day comparison possible on a first run.

`npm run live` is the fast path: both demand sources, then `enrich` and
`dashboard`. It takes a few seconds and is the one to re-run between games.
`npm run all` does everything.

### FantasyPros public API v2 (needs `FP_API_KEY`)

| Command | What it does |
|---|---|
| `fp:check` | validate the key, show resolved season/week |
| `fp:sync` | pull everything below into `data/fp/` |
| `fp:rankings --position RB --scoring PPR [--week N] [--ros]` | consensus rankings |
| `fp:projections --position RB [--week N] [--ros]` | projections, sorted by points |
| `fp:injuries [--week N]` | injury report |
| `fp:news [--category injury]` | player news |
| `enrich` | join FP data onto rosters → `data/enriched.json` |
| `lineup [league]` | your team with week + ROS projections, ranks, injuries |

`fp:sync --source hybrid|scrape|api`. **Default is `hybrid`**, which scrapes the
bulk and spends ~3 API calls on the two things scraping cannot provide. See
[Why hybrid](#why-hybrid) below.

### Public-page scraping (no API key)

| Command | What it does |
|---|---|
| `fp:scrape` | full dataset from public pages → same `data/fp/` layout |
| `scrape:rankings --position RB --scoring PPR [--ros]` | one board, printed |
| `scrape:news [--pages N] [--team SF]` | injury news listing |

## The API surface

Base: `https://mpb{sport}.fantasypros.com/api/` (`mpbnfl` for football).

### Account-level — auth is the email, nothing else

```
GET /getUserLeaguesJSON?email=<account email>
```

Returns **every league on the account with its own per-league `key`**, across all
host sites. This is the entry point: one email bootstraps every key.

> The parameter must be `email=`. `user=`, `userId=`, `username=` all return
> `{"errorCode":1,"error":"user not found"}`.

### Per-league — auth is the league `key`

| Endpoint | Status | Payload |
|---|---|---|
| `getLeagueRostersJSON` | works | teams, team names/logos, rostered `fpId`s, scoring, roster slots, draft state |
| `getLeagueSettingsJSON` | works | scoring rules, roster positions, playoff config, waiver type/FAAB, draft order, picks by team |
| `getLeagueTransactionsJSON` | works | add/drop history **with player names, teams, positions** |
| `getLeagueWaiverJSON` | works, thin | league metadata only — no waiver claims observed |
| `getLeagueLineupJSON` | returns `[]` | empty with and without `week`/`teamId` params |

Verified 200 on all 10 leagues across ESPN, Yahoo, and Sleeper.

Endpoint names not in this list 404 (`getLeagueStandingsJSON`, `getLeagueMatchupJSON`,
`getLeagueScheduleJSON`, `getLeaguePlayersJSON`, … all tested). Note the `rosters`
payload advertises an `apis` capability map — `{schedule, transactions, standings,
matchup, submitLineup, autoPilotSubmit, autoPilotEmail}` — but only `transactions`
has a reachable `getLeague*JSON` endpoint; the rest are app-internal.

### Player ids

Rosters return bare integers (`22968`). Those are FantasyPros player ids, the same
`fpId` that `getLeagueTransactionsJSON` pairs with a name, and the same `player_id`
embedded as `var ecrData` on public FantasyPros ranking pages. `src/players.js`
scrapes ten ranking boards and merges them into `data/cache/players.json`
(~1000 players, refreshed every 12h).

**Ranks are stored per board and never merged** — PPR, half-PPR, standard,
rest-of-season and positional ranks are different scales. `resolve()` picks the
overall board matching each league's scoring, so `ecrOverall` in a HALF league is
the half-PPR rank. `ecrPosition` is the within-position rank.

Unresolved ids are labelled `Unknown (fpId N)` rather than dropped. Currently 3 of
284 rostered players don't appear on any public board (deep bench / IR).

## Output

```
data/
├── raw/<timestamp>/       one JSON per league, exactly as returned
│   └── _normalized.json
├── latest.json            normalized model, most recent scrape
├── cache/players.json     fpId -> player dictionary
└── export/*.csv
```

Each league in the normalized model carries a `status`:

| status | meaning |
|---|---|
| `active` | rosters present |
| `predraft` | `hasDrafted: false` upstream — no rosters yet |
| `no-rosters-synced` | drafted but host hasn't synced rosters |
| `partial-sync` | `hasRosters: false`, some players present |

This distinguishes "nothing to scrape" from "the scrape failed."

## FantasyPros public API v2

Base `https://api.fantasypros.com/public/v2/json`, auth via an `x-api-key` header.
Request a key at <https://secure.fantasypros.com/api-keys/request/> — it is a
**separate credential** from the MyPlaybook league keys.

Spec: <https://api.fantasypros.com/public/v2/docs> (OpenAPI at
`/public/v2/docs/fantasypros_v2_public.yml`).

| Endpoint | Used for |
|---|---|
| `/{sport}/players` | universal player database; `external_ids` maps FP ids → espn, yahoo, cbs, fleaflicker, fantrax, mfl |
| `/{sport}/news` | news, filterable by `category` (injury, recap, transaction, rumor, breaking) |
| `/{sport}/injuries` | injury report by `year` + `week` |
| `/{sport}/{season}/consensus-rankings` | rankings by `position` + `scoring`; `week=N` for weekly, `type=ROS` for rest of season |
| `/{sport}/{season}/rankings/experts` | expert roster behind the consensus |
| `/nfl/{season}/projections` | projections by `position`; `week=N` weekly, `ros=true` rest of season |
| `/nfl/{season}/player-points` | fantasy points scored, `start`/`end` week range |
| `/{sport}/compare-players` | head-to-head comparison |

Useful details:

- Projections return `points`, `points_ppr` and `points_half` in one payload, so
  one call per position covers every scoring format.
- Rankings do **not** — `scoring` is a request parameter, so `fp:sync` pulls one
  board per (position × scoring). It only pulls the formats your leagues actually
  use, read from `data/latest.json`.
- `week=0` means preseason/draft on both rankings and projections.
- Season and week are auto-detected from the calendar (kickoff = Thursday after
  Labor Day, weeks roll over Tuesday). Override with `FP_SEASON` / `FP_WEEK` or
  `--season` / `--week`.

### Output layout

```
data/fp/<season>/
├── players.json           universal player db + external ids
├── news.json
├── experts.json
├── points/<scoring>.json  points scored, season to date
├── week-<N>/
│   ├── injuries.json
│   ├── rankings/<scoring>/<position>.json
│   └── projections/<position>.json
└── ros/
    ├── rankings/<scoring>/<position>.json
    └── projections/<position>.json
```

## VegasEdgeFantasy

Sportsbook-implied projections for the current week. Auth is the `access_token`
cookie from a logged-in session — a JWT, valid about a month. Copy it from
DevTools → Application → Cookies into `VEGAS_TOKEN`; `vegas:check` reports the
expiry before a sync wastes requests.

```
GET https://vegasedgefantasy.com/{board}/rankings?bookmaker={book}
    Cookie: access_token=<JWT>
```

- boards: `qb`, `rb`, `wr`, `te`, and `flex` (= rb+wr+te). **No K or DST.**
- bookmakers that return rows: `Average`, `DraftKings`, `FanDuel`, `BetMGM`,
  `Fanatics`. Others 200 with an empty body.

Each row gives `FantasyPoints`, the component props (`RushingYds`,
`ReceivingYds`, `Receptions`), `TD_Prob` / `ExpectedTds`, a `volatility_tag`
(High Floor / Balanced / Volatile) and injury status.

**Players are keyed by Sleeper id**, not a FantasyPros id — which is also what
the headshot CDN uses.

### Partially-priced players matter

A player without a full prop market still gets a `FantasyPoints` value derived
from touchdown probability alone. On the week-1 RB board, **68 of 108** players
were missing at least one prop. Those look like enormous disagreements with
FantasyPros when they are really just absent markets — Jonathon Brooks priced at
2.84 vs FP's 9.1, with all three yardage props missing.

So each row carries `complete`, and `compare` shows only fully-priced players by
default. `--include-partial` shows the rest, flagged. `vegasVsFp` is only
computed for complete lines.

## Cross-source player ids

Three id spaces have to line up:

| Space | Used by |
|---|---|
| FantasyPros `fpId` | MyPlaybook rosters, FP rankings/projections |
| Sleeper id | VegasEdge, `sleepercdn.com` headshots |
| ESPN / Yahoo id | host sites, via the FP players endpoint |

`src/idmap.js` matches strongest-first — ESPN id, then Yahoo id, then normalised
name + position (suffixes, punctuation and accents stripped). Measured against
the week-1 Vegas board: 74 by ESPN id, 329 by name, **6 unmatched** — and those
six are absent from FantasyPros entirely, not mis-joined.

Sleeper's own `espn_id` / `yahoo_id` are null for many recent players, which is
why name matching carries most of the load.

Headshots: `https://sleepercdn.com/content/nfl/players/thumb/{sleeperId}.jpg`
(and the same path without `/thumb` for full size). The ~15MB Sleeper dump is
cached for 24h.

## Why hybrid

The public API works, but two things make it a poor *primary* source:

1. **403 means two different things.** The gateway returns 403 for a bad key
   *and* for throttling. Observed behaviour is genuinely intermittent — the same
   request returned `403,403,200,200,403` in a row. The client serialises calls
   (2s apart) and retries 403 six times with backoff before giving up.
2. **Responses are truncated.** Every payload carries `public_api_limited: true`.
   Season points-scored came back with 55 players; the scraped ranking boards
   return 161 RBs and 273 WRs for the same week.

Scraping has no key, no quota, no throttling, and returns *more* per player. So
the split is:

| Source | Provides |
|---|---|
| **Public pages** | rankings, projections, start/sit, matchup, expert spread, news, injuries |
| **API** (~3 calls) | `players` + external ids (ESPN/Yahoo/CBS), `player-points` (actual points scored) |

A full hybrid run costs **4 API requests** against your 500/day, instead of ~45.

## Scraping without an API key

The API is convenient but gated. Everything it provides for rankings and
projections is already embedded in FantasyPros' public ranking pages as
`var ecrData = {...}`, ungated and complete.

```
https://www.fantasypros.com/nfl/rankings/{ros-}{scoring-}{position}.php
```

- scoring prefix: `ppr-`, `half-point-ppr-`, or none for standard. QB/K/DST
  have no scoring variants.
- `ros-` prefix switches the board from the current week to rest of season.

Each player on a board carries:

| Field | Meaning |
|---|---|
| `rank_ecr` | consensus rank |
| `rank_min` / `rank_max` / `rank_ave` / `rank_std` | expert spread |
| `r2p_pts` | **projected points** for that board's scoring format |
| `start_sit_grade` | A+ … F |
| `player_opponent` | this week's matchup |
| `pos_rank`, `player_owned_avg`, `player_bye_week` | |
| `note` | expert write-up, often several paragraphs |

Because `r2p_pts` is on the ranking board itself, one request per
(position × scoring × week|ros) covers rankings *and* projections — 24 requests
for a two-format account. `enrich` prefers a dedicated projections file when the
API supplied one and falls back to `r2p_pts` otherwise, so both sources join
identically.

Injuries and news come from `/nfl/injury-news.php` (server-rendered, paginated,
filterable by `position` / `team`). The FantasyPros player id appears only in the
headshot URL, which is what the join keys on; status (`OUT`, `QUESTIONABLE`,
`DOUBTFUL`, `IR`, `LIMITED`, `ACTIVE`) and body part are parsed from the headline,
since the listing has no structured status field.

**What scraping does not give you:** the API's `player-points` (actual fantasy
points scored per week), `compare-players`, and `external_ids` (FP id → ESPN /
Yahoo / CBS ids). Those have no public-page equivalent, which is exactly what the
hybrid mode spends its handful of API calls on.

### Note on the projections pages

`/nfl/projections/{pos}.php` is gated to 10 players when logged out, so it is not
used. The ranking boards' `r2p_pts` is the ungated route to the same numbers.

## Notes

- `.env`, `config.json` and everything under `data/` are gitignored — league keys
  are credentials.
- **`getUserLeaguesJSON` takes an email and no secret.** Anyone who knows an
  account's email can enumerate that account's leagues and keys, and each key then
  unlocks that league's roster/settings/transaction data. Treat your keys as
  sensitive, and be aware the email endpoint is the weak link.
- Requests run 3-wide with a 250ms delay (`FP_CONCURRENCY`, `FP_DELAY_MS`), with
  retry + exponential backoff on 429/5xx.
- The MyPlaybook endpoints are undocumented and can change without notice. The
  public v2 API is documented and versioned.
- API calls are serialised 2s apart (`FP_API_GAP_MS`) to respect the documented
  1 req/sec limit, and 403s are retried six times with exponential backoff before
  being reported, because 403 is also this API's throttling signal.
