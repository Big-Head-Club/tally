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

## Tests

```
npm test                                             # SQLite
TALLY_TEST_PG=postgres://... npm test                # also Postgres
```

## FAQ

**Ad blockers?** The script is served from your own domain under a bland
path, so the common lists do not block it. Some visitors still will not be
counted. That is true of every tool.

**Two machines?** SQLite is one file on one machine. If you scale out, switch
to Postgres. Or keep the app stateless and run tally standalone.

**Will it slow the page?** The script is about 5 KB, loads deferred, and sends
with `sendBeacon`. If the server is down the page does not care.

**GDPR?** No cookies, no stored IPs, no cross-site or cross-day identity. Read
your own rules; this is what Plausible and Fathom argue puts them outside
consent requirements.

**Node 22 prints an "SQLite is experimental" warning.** Start Node with
`--disable-warning=ExperimentalWarning`. Node 24 does not warn.
