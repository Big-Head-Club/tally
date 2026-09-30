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

No cookies. IP addresses are hashed with a daily salt and never stored, so a
visitor is one person for one day and a stranger the next. No consent banner
needed in most places, and nothing leaves your server.

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

```js
// Anywhere on the page, before or after the tag. Works with a deferred tag:
// early calls run before tally loads, later calls hit the real object.
var measurement;
function measured() {
  return measurement || (window.tally && tally.measure &&
    (measurement = tally.measure({ gameId: 'my-game', build: window.BUILD })));
}

measured();                                  // on page arrival, so non-starters count
measured() && measured().resume();           // the game is playable
measured() && measured().action(event);      // the game accepted a player action
measured() && measured().pause();            // menu, explicit pause, results, spectator
```

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

The dashboard shows a **Qualified play** table per game. Every column heading
is a keyboard-reachable button that sorts (`aria-sort` follows). Null — a
window not reached, no sample yet — renders as `—`, sorts last in either
direction, and is always distinct from a real `0%`. Percentages carry their
counts: `50% (1 of 2)`.

Reading the numbers:

- **Engaged visits** — settled visits that qualified: page visible and
  focused, the game playable, 30+ covered seconds of active time, 2+ accepted
  inputs at least 5 seconds apart. A visit is only judged once it has been
  quiet for 32 minutes; before that it is **pending** and is never counted as
  a zero.
- **Avg / Median playtime · first visit** — over the settled qualified visits
  (the "playtime sample" line under the table). Seven-day playtime is summed
  per browser and clipped to the first 168 hours after their first accepted
  input.
- **Next-day returns** — of the browsers whose first qualified play is at
  least 48h2m old, the share with a later same-game visit carrying input 24–48
  hours after that first play. **Day-7 returns** — the same for 168–192 hours.
  The extra two minutes is delivery grace for a last report in flight.
- **Flags** (under the table): *temporary identity* visits had blocked storage
  and never enter cohorts; *unconfirmed tail* visits ended without a closing
  report and are shown but never charged as zeros.

The same rows, machine-readable:

```
GET /admin/analytics/<token>/measurement.json?site=example.com&asOf=<epoch-ms>
```

or `tally.measurementStats(site?, asOf?)` in code. One row per game: browsers
(measured / engaged), visits (eligible / qualified / pending), engagement
rate, playtime mean and median with sample sizes, `d1` and `d7` with
denominators and returns, and the flag counts. Omit `site` for every site;
`asOf` re-answers the past.

**Identity, and how it differs from the legacy analytics.** The event log
stores no identifier: a visitor is a daily-salted hash of IP and user agent,
useless tomorrow. Qualified play needs a stable key, so it stores one: a
random UUID in `localStorage` (`tally_mid`), kept in the measurement table
beside the aggregates. It is nothing but randomness, it never leaves your
collector, and clearing site data makes the browser a stranger again. Blocked
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
  retentionDays: 0,       // delete raw events older than this; 0 keeps forever
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

Big-Head-Club's own collector runs on Railway at
`https://tally-production-afae.up.railway.app`. Deploys there are manual:
`railway link` the tally project, then `railway up` — pushing to this repo
does not deploy the service.

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

**GDPR?** No cookies, no stored IPs, no ID. The only thing kept in the
browser for returns is two dates (first and last visit to this site). Read
your own rules; this is what Plausible and Fathom argue puts them outside
consent requirements.

**Node 22 prints an "SQLite is experimental" warning.** Start Node with
`--disable-warning=ExperimentalWarning`. Node 24 does not warn.
