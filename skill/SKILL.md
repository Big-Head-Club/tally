---
name: tally
description: Add self-hosted analytics to a web app or game with one script tag. Use when asked to add analytics, tracking, a visitor counter, event counts, or an A/B test, or when a prompt template says "add tally analytics".
---

# Add tally analytics

tally is a zero-dependency Node module: one script tag on the page, one
handler on the server, SQLite on a volume, live dashboard at a secret URL.
Source and full README: https://github.com/Big-Head-Club/tally

Follow these steps in order. Do not ask the user questions that these steps
answer.

## 1. Decide where the server side lives

- **The app has a Node server** (plain http, Express, Fastify, Hono, Next.js,
  SvelteKit, Remix): mount tally in it. Continue to step 2.
- **The app is static** (an HTML file, a Vite build with no server): either add
  a ten-line Node server (see `examples/http.js`) and serve the static files
  from it, or, if a shared tally service already exists, use its URL in the
  script tag and skip to step 4.
- **The app is not Node** (Python, Go, Rust): run tally as a separate service
  from the repo itself, and use its URL in the script tag. Skip to step 4.

## 2. Install

```
npm install github:Big-Head-Club/tally
```

If the project would rather vendor it, copy `src/` into the project instead.
Node 22.13 or newer is required. Add `--disable-warning=ExperimentalWarning` to
the start command on Node 22 so logs stay clean.

## 3. Mount

Plain http:

```js
import { createTally } from 'tally';
const tally = createTally();
// inside the request handler, before your routes:
if (await tally.handler(req, res)) return;
```

Express / Connect: `app.use(tally.middleware);` before other routes.

Fetch-style frameworks: `import { createTallyFetch } from 'tally/fetch'`, then
in a catch-all route `const r = await tally.fetch(request); if (r) return r;`.
In Next.js that is `app/[...tally]/route.ts` exporting GET, POST and OPTIONS
that all call it.

After the server starts, print the dashboard URL:
`console.log('dashboard:', tally.dashboardUrl(PUBLIC_URL))`.

## 4. Add the tag

In the shared layout, before `</body>`:

```html
<script defer src="/t.js"></script>
```

If the collector is a separate service, use its full URL. Do not add
`data-site` unless the hostname would be wrong (a preview URL, or several
apps on one host).

## 5. Name the things that matter

Clicks on buttons and links are counted by their visible text. Where the text
is not a good name, or changes, add `data-a="short_name"`. Add `data-a="off"`
to elements whose clicks are noise.

For a game, call `tally(name, props)` at the milestones a person would ask
about. Use these names so dashboards line up across games:

- `start` when a run or level begins
- `win` and `lose` with `{ level, seconds, score }` where they exist
- `share` when a share or copy-link button is used
- anything else the game does that is worth knowing

Guard the calls: `window.tally && tally('win', { level })`.

Only add an A/B test if asked. `const arm = tally.variant('key', ['a','b'])`
picks and remembers an arm; the dashboard shows a per-arm table.

## 6. Storage on deploy

Fly (`fly.toml`):

```toml
[env]
  TALLY_DIR = "/data"
  TZ = "America/New_York"
[mounts]
  source = "tally_data"
  destination = "/data"
```

then `fly volumes create tally_data --size 1` once, before the first deploy.

Railway: tell the user to add a volume mounted at `/data` in the service
settings (or run `railway volume add --mount-path /data`) and set
`TALLY_DIR=/data`.

No volume available: `npm install pg`, set `DATABASE_URL`. If the user has
`neonctl` and is logged in, `neonctl projects create --name <app>` then
`neonctl connection-string` gives one.

Optional: set `TALLY_TOKEN` to a chosen secret. Otherwise one is generated on
first start and printed in the logs.

## 7. Verify

Start the app, open a page, then open the dashboard URL from the logs. The
page load should appear in the live ticker within a second. Click something
and watch it appear. If nothing shows: check the tag is in the served HTML,
check `/t.js` returns JavaScript, check the server logs for "tally:".

## 8. Report

Tell the user: the dashboard URL (or how to find it in logs), which events
were added and where, and what storage was configured. Keep it to a few lines.
