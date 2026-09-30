# tally

Analytics for small sites and games. One script tag on the page, one folder on
the server, no dependencies, no bill. Events go into SQLite on a volume you
already have. A live dashboard sits at a secret URL.

```html
<script defer src="/t.js"></script>
```

That line gets you, with no other code:

- pageviews, unique visitors, referrers, UTM tags, pages
- every button and link click, named by its text
- time on page
- uncaught JavaScript errors, with message and line
- touch vs mouse, screen size, language
- a live feed of events as they happen

Two more calls get you the rest:

```js
tally('level_complete', { level: 3 });          // any custom event
const arm = tally.variant('cta', ['a', 'b']);   // sticky A/B arm, reported on every later event
```

No cookies. Legacy events use a daily-salted hash of IP and user agent; raw
IP addresses are not stored. These counts cannot identify people across days.
Optional qualified-play measurement uses a separate persistent browser ID.

Did they come back? The browser keeps two dates for your site in localStorage
(first visit, last visit) and no ID. Once a day it sends a `visit` event with
`days_since_first` and `new`, so day-1 and day-7 return rates work with no
game code. Blocked storage means no `visit`, nothing else changes.

## Qualified play: measure()

The event log cannot tell you whether anyone actually played. `measure()` adds
an opt-in play clock: call it when the page arrives, tell it when the game is
playable, and feed it every accepted player action. It reports cumulative
checkpoints to `POST /m` on the collector, which groups them into visits,
qualifies them, and computes playtime and same-game retention. Nothing is sent
for pages that never call `measure()`.

Give the existing script tag an ID, then install these hooks during page
initialization. The load listener handles a deferred SDK; the saved playable
state is applied when it arrives.

```html
<script id="tally-sdk" defer src="/t.js"></script>
```

```js
let measurement;
let playable = false;

function measured() {
  if (!measurement && window.tally?.measure) {
    measurement = window.tally.measure({ gameId: 'my-game', build: window.BUILD });
    if (playable) measurement.resume();
  }
  return measurement;
}

document.getElementById('tally-sdk').addEventListener('load', measured, { once: true });
measured(); // Record arrival even when the player never starts.

function setPlayable(value) {
  playable = value;
  const m = measured();
  if (m) value ? m.resume() : m.pause();
}

function acceptedAction(event) {
  measured()?.action(event);
}
```

Call `setPlayable(true)` on playable entry and restart, `setPlayable(false)`
for menus, pause, results and spectating, and `acceptedAction(event)` only
after the game accepts a local input. For async moves, wait for an explicit
acceptance result: HTTP 200 alone does not establish that a move happened.
Use the collector's full script URL for a separately hosted collector.

The rules, which the numbers below depend on:

- **`gameId`** is required, 1–64 characters of `a-z 0-9 -` starting with a
  letter or digit. **`build`** is optional (`[\w.-]{1,64}`); omit it rather
  than inventing one. One measured game per page: a second `measure()` with
  the same `gameId` returns the same object, a different one throws.
- **`action(event?)` only after the game accepts the move** — after local
  validation, when an async server reply confirms it, or for a verified gamepad
  transition. `action(event)` rejects untrusted DOM events and key repeats.
  Never call it from a simulation tick, animation frame, menu, heartbeat, or
  for an opponent's or bot's move. A held control counts once: report real
  input changes, not loop iterations.
- **`pause()` at every boundary where the game is not playable**: in-game
  menus, explicit pause, results screens, spectator and abandoned states.
  Focus, visibility and idle are built in: the clock also stops when the tab
  is hidden or unfocused, and 60 seconds after the last accepted input.
- Streams seal themselves after ten minutes, a five-second gap, or 128
  intervals and a fresh one opens on the next accepted input. Reloads, sleeps
  and throttled tabs cannot charge time nobody played; the server refuses
  rewritten or backdated history.

The dashboard groups **Qualified play**, **Same-game returns**, and
**Measurement status** into collapsible sections. Only Qualified play starts
expanded. Every table, including the legacy event tables, sorts from
keyboard-reachable column buttons (`aria-sort` follows). Sort direction and
expanded sections survive automatic refreshes. Null — a
window not reached, no sample yet — renders as `—`, sorts last in either
direction, and is always distinct from a real `0%`. Percentages carry their
counts: `50% (1 of 2)`.

Reading the numbers:

- **Engaged visits** — settled visits that qualified: page visible and
  focused, the game playable, 30+ covered seconds of active time, 2+ accepted
  inputs at least 5 seconds apart. A visit is only judged once it has been
  quiet for 32 minutes; before that it is **pending** and is never counted as
  a zero.
- **Avg / Median playtime · first visit** — each persistent browser's first
  settled qualified visit, with its browser sample beside the minutes.
  Seven-day playtime includes repeat runs and later visits, clipped to the
  first 168 hours after first qualified play; overlapping tabs count once.
- **Next-day returns** — of the browsers whose first qualified play is at
  least 48h2m old, the share with a later same-game visit carrying input 24–48
  hours after that first play. **Day-7 returns** — the same for 168–192 hours.
  The extra two minutes is delivery grace for a last report in flight.
- **Measurement status**: *temporary identity* visits had blocked storage
  and never enter cohorts; *unconfirmed tail* visits ended without a closing
  report. Time is a lower bound; a missing closing report does not invent a
  duration or a zero-length visit.

Measurement uses all retained streams for the selected site; the date picker
filters legacy events. Definitions and cohort windows are at the bottom of
the dashboard. Games without reports are absent, not listed as measured zero.

The same rows, machine-readable:

```
GET /admin/analytics/<token>/measurement.json?site=example.com&asOf=<epoch-ms>
```

or `tally.measurementStats(site?, asOf?)` in code. One row per game: browsers
(measured / engaged), visits (eligible / qualified / pending), engagement
rate, playtime mean and median with sample sizes, `d1` and `d7` with
denominators and returns, and the flag counts. Omit `site` for every site;
`asOf` sets the time used to evaluate cohort maturity; it is not a historical
snapshot of checkpoints that have since been updated or pruned.

**Identity, and how it differs from the legacy analytics.** Legacy events
store a daily-salted hash of IP and user agent. Qualified play uses a
separate stable key: a
random UUID in `localStorage` (`tally_mid`), kept in the measurement table
beside its measurement streams. It is sent to the configured collectors;
clearing site data creates a new identity. It identifies a browser storage
context, not a verified person or a cross-device account. Blocked
storage still measures, with a per-load id flagged temporary that never enters
a cohort.

**QA and bots.** Automated browsers are excluded like every other tally
event: `navigator.webdriver` never loads the script, user agents that call
themselves bots are dropped by the collector, `window.__TALLY_TEST__ = true`
or `?tally_test=1` suppresses every measurement report, and `tally.ignore()`
mutes both trackers. Point browser tests at an isolated collector or intercept
`/m`; do not impersonate human traffic.

Storage: measurement streams live next to the events — `measurement_streams`
on SQLite, `tally_measurement_streams` on Postgres — and `retentionDays`
prunes them by their last report on the same schedule as the events.
Keep the default `0` (no pruning), or at least nine days to observe a full D7
window. Cohorts begin at the first qualified visit still present in retained
data; pruning can remove earlier history.

## The line for your prompt

Building with Claude Code or another agent? Put this in the prompt, or in
your prompt template, and let it do the rest:

```
Add analytics with tally: read https://raw.githubusercontent.com/Big-Head-Club/tally/main/skill/SKILL.md and follow it.
```

If the skill is installed (`cp -r skill ~/.claude/skills/tally`), the line
gets shorter:

```
Add analytics: follow the tally skill.
```

Either way the agent installs the module, mounts it, adds the tag, names
the events that matter, sets up storage for Fly or Railway, and reports
the dashboard URL.

## Install

Node 22.13 or newer. Either:

```
npm install github:Big-Head-Club/tally
```

or copy the `src/` folder into your project. There is nothing to build.

## Mount it in your app

Plain `http`:

```js
import http from 'node:http';
import { createTally } from 'tally';

const tally = createTally();                       // SQLite at ./data/tally.sqlite (or $TALLY_DIR)
http.createServer(async (req, res) => {
  if (await tally.handler(req, res)) return;       // /t.js, /i, /admin/analytics/<token>
  // ...your routes
}).listen(3000);
await tally.ready;
console.log(tally.dashboardUrl('http://localhost:3000'));
```

Express, Fastify's middie, Connect, Polka:

```js
app.use(tally.middleware);
```

Frameworks that hand you a `Request` (Next.js route handlers, Hono, SvelteKit,
Remix on Node):

```js
import { createTallyFetch } from 'tally/fetch';
const tally = createTallyFetch();
// in a catch-all route: const r = await tally.fetch(request); if (r) return r;
```

See `examples/` for each one.

Then add the tag to your layout. The script finds its own server from the
`src`, and takes the site name from the page's hostname. Nothing to configure.

## Find the dashboard

The dashboard lives at `/admin/analytics/<token>`. The token comes from
`TALLY_TOKEN` if set, else it is generated once, stored next to the data, and
printed at startup:

```
dashboard: http://localhost:3000/admin/analytics/3f9a0c…
```

`fly logs` or the Railway deploy log shows it in production. Anyone with the
URL can read stats, so treat it like a password. To pick your own, set
`TALLY_TOKEN`.

The page shows visitors on the site now, today, and all time; a daily table
with one column per event; referrers, pages, clicks, errors; A/B tables per
variant key; and a live ticker. `csv` and `jsonl` export the raw rows.
`events.json?site=&days=7&names=start,return&limit=` returns a window of rows as
JSON (props parsed, `truncated` when the limit hit), for tools that work out
what the dashboard does not.

## Where the data goes

**A volume (default).** One SQLite file. Set `TALLY_DIR` to the mount.

Fly:

```toml
[env]
  TALLY_DIR = "/data"
[mounts]
  source = "tally_data"
  destination = "/data"
```

```
fly volumes create tally_data --size 1
fly deploy
```

A volume pins the app to one machine. For a small site that is fine; Fly takes
a daily snapshot of the volume for you.

Railway: add a volume to the service, mount it at `/data`, set
`TALLY_DIR=/data`. Volume services run one replica and restart with a few
seconds of downtime on deploy.

**Postgres (Neon, Railway Postgres, Supabase).** No volume needed.

```
npm install pg
```

Set `DATABASE_URL`. tally creates its two tables on first start. To get a free
Neon database from the command line:

```
npm i -g neonctl && neonctl auth
neonctl projects create --name my-site
neonctl connection-string
```

## Options

```js
createTally({
  dir: './data',          // folder for tally.sqlite            ($TALLY_DIR)
  file: undefined,        // full path instead; ':memory:' in tests
  databaseUrl: undefined, // Postgres instead of SQLite         ($DATABASE_URL)
  token: undefined,       // dashboard secret                   ($TALLY_TOKEN)
  tz: 'UTC',              // timezone for "day"                 ($TZ)
  site: undefined,        // default site for track() and single-site dashboards
  sites: undefined,       // allowlist; default accepts any site name
  ignoreSites: ['localhost', '127.0.0.1', '0.0.0.0', '::1'], // dropped, so local dev never counts
  prefix: '',             // mount routes under a path, e.g. '/_t'
  retentionDays: 0,       // prune old events and measurement streams; 0 keeps forever
  trustProxy: true,       // read the client IP from Fly/Railway/Cloudflare headers
});
```

## Server-side events

```js
const vid = await tally.visitor(req);                       // same id the browser events carry
await tally.track('purchase', { cents: 1200 }, { vid });    // shows up in that visitor's funnel
const s = await tally.stats('example.com', 30);             // the dashboard's JSON
tally.events.on('event', (row) => { /* live */ });
```

## The browser side

Everything is optional.

| | |
|---|---|
| `data-site="name"` on the script tag | use this site name instead of the hostname |
| `data-a="signup"` on any element | name its clicks `signup` instead of using the text |
| `data-a="off"` | do not count clicks on this element |
| `tally(name, props)` | custom event; props are shallow strings, numbers, booleans |
| `tally.variant(key, arms)` | sticky arm, stored in localStorage, sent as `ab` on later events |
| `tally.ignore()` or `?tally=ignore` in the URL | stop counting this browser; `?tally=track` undoes it |
| `window.tally = window.tally \|\| function(){(tally.q=tally.q\|\|[]).push(arguments)}` | queue calls made before the script loads |

Single-page apps: a `pushState` that changes the path counts as a pageview.

Two tags on one page (your own tally and a shared hub, say) act as one
tracker that reports to both. Put the hub's tag after your own.

Limits: event names are 64 characters of `a-z 0-9 _ : . -`. Strings in props
are cut at 200 characters, props at 1 KB, a batch at 50 events, a request at
32 KB. Bad events are dropped silently.

## Run it as one service for many sites

The same code runs standalone. Deploy this repo on its own, then any site,
static or not, adds:

```html
<script defer src="https://tally.example.com/t.js"></script>
```

Each site shows up on the dashboard by hostname, with a fleet table across
all of them. Set `TALLY_SITES=a.com,b.com` to allowlist. `PUBLIC_URL` makes
the printed dashboard link right.

```
npm start                      # or: fly launch, railway up
```

Big-Head-Club's collector runs at
`https://tally-production-afae.up.railway.app`. Its Railway service is connected
to `Big-Head-Club/tally`, branch `main`: pushes automatically build the tracked
Dockerfile and deploy the collector. The existing `/data` volume preserves
SQLite data and the dashboard token. Check the Railway deployment's commit
and `/health` after a release.

## Tests

```
npm test                                             # SQLite
TALLY_TEST_PG=postgres://... npm test                # also Postgres
```

## FAQ

**Bots?** Link-preview bots never run the script. Headless browsers that do
are skipped when they admit to being automated, and events from user agents
that call themselves bots, crawlers, or tools are dropped on the server. For
rankings, count engaged visitors (`engagedSites()`: clicked, started, or
stayed ten seconds) rather than pageviews; crawlers never do those.

**Ad blockers?** The script is served from your own domain under a bland
path, so the common lists do not block it. Some visitors still will not be
counted. That is true of every tool.

**Two machines?** SQLite is one file on one machine. If you scale out, switch
to Postgres. Or keep the app stateless and run tally standalone.

**Will it slow the page?** The script is about 5 KB, loads deferred, and sends
with `sendBeacon`. If the server is down the page does not care.

**What identifiers are stored?** Legacy events use daily-salted visitor
hashes and keep first/last-visit dates in the browser. Opt-in `measure()` also
stores an origin-local UUID and sends it with measurement streams. No cookies
or raw IP addresses are stored. The qualified-play identity is separate from
the legacy visitor hash.

**Node 22 prints an "SQLite is experimental" warning.** Start Node with
`--disable-warning=ExperimentalWarning`. Node 24 does not warn.
