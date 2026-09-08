// Node adapter: plain http.createServer handlers and Express-style middleware.
import { join } from 'node:path';
import { createCore } from './core.js';
import { openSqlite } from './store.js';

export { createCore } from './core.js';
export { openSqlite } from './store.js';

/**
 * createTally(options)
 *   dir           folder for the SQLite file (default $TALLY_DIR or ./data)
 *   file          full path to the SQLite file (overrides dir); ':memory:' for tests
 *   databaseUrl   Postgres URL (default $DATABASE_URL); when set, uses Postgres instead of SQLite
 *   token         dashboard token (default $TALLY_TOKEN, else generated once and stored)
 *   tz            timezone for "days" (default $TZ or UTC)
 *   site          default site name for server-side track() and single-site dashboards
 *   sites         allowlist of site names; default: any site name is accepted
 *   ignoreSites   site names to drop (default: localhost and friends, so local dev never counts)
 *   prefix        mount routes under this path (default '')
 *   retentionDays delete raw events older than this (default 0 = keep forever)
 *   trustProxy    read client IP from proxy headers (default true; Fly and Railway set them)
 */
export function createTally(opts = {}) {
  const store = opts.store || resolveStore(opts);
  const core = createCore({
    ...opts,
    token: opts.token || process.env.TALLY_TOKEN || undefined,
    store,
  });

  /** Handle a Node request if it is ours. Resolves true when handled. */
  async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const r = await core.handle({
      method: req.method,
      path: url.pathname,
      query: url.searchParams,
      header: (n) => req.headers[n.toLowerCase()],
      ip: req.socket?.remoteAddress,
      text: (max) => readBody(req, max),
    });
    if (!r) return false;
    if (r.sse) { sse(res, r.sse.site); return true; }
    if (r.status === 413) {
      // Stop reading, answer, then drop the connection rather than drain an unbounded body.
      res.writeHead(413, { ...r.headers, connection: 'close' });
      res.end(r.body, () => req.destroy());
      return true;
    }
    res.writeHead(r.status, r.headers);
    res.end(r.body);
    return true;
  }

  function sse(res, site) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(':ok\n\n');
    const onEvent = (row) => { if (!site || row.site === site) res.write(`data: ${JSON.stringify(row)}\n\n`); };
    core.events.on('event', onEvent);
    const ping = setInterval(() => res.write(':ping\n\n'), 25_000);
    res.on('close', () => { clearInterval(ping); core.events.off('event', onEvent); });
  }

  /** Visitor id for a Node request, matching what the browser script's events carry. */
  function visitor(req, site) {
    const h = req.headers;
    const ip = h['fly-client-ip'] || h['cf-connecting-ip'] || (h['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '0.0.0.0';
    return core.visitorIdFor({ ip, ua: h['user-agent'] || '', site: site || opts.site || (h.host || '').split(':')[0].toLowerCase() });
  }

  /** Express / Connect middleware. */
  function middleware(req, res, next) {
    handler(req, res).then((done) => { if (!done) next(); }).catch(next);
  }

  return { ...core, handler, middleware, visitor };
}

function resolveStore(opts) {
  const url = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (url) return import('./store-pg.js').then((m) => m.openPg(url));
  const file = opts.file || join(opts.dir || process.env.TALLY_DIR || './data', 'tally.sqlite');
  return openSqlite(file);
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { req.pause(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
