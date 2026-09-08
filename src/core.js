// Adapter-independent request handling. Both the Node and Fetch adapters
// build a small request object and hand it here.
import { EventEmitter } from 'node:events';
import { timingSafeEqual } from 'node:crypto';
import { visitorId, randomToken, dayIn } from './hash.js';
import { CLIENT_JS } from './client.js';
import { dashboardHtml } from './dashboard.js';

const NAME_RE = /^[a-z0-9_:.-]{1,64}$/i;
const SITE_RE = /^[a-z0-9._-]{1,64}$/i;
const MAX_BODY = 32 * 1024;
const MAX_BATCH = 50;
const MAX_PROPS = 1024;
const MAX_STR = 200;

export function createCore(opts) {
  let store;
  const tz = opts.tz || process.env.TZ || 'UTC';
  const prefix = (opts.prefix || '').replace(/\/$/, '');
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const allow = opts.sites ? new Set(opts.sites.map((s) => s.toLowerCase())) : null;
  const ignore = new Set((opts.ignoreSites ?? ['localhost', '127.0.0.1', '0.0.0.0', '::1']).map((s) => s.toLowerCase()));
  const trustProxy = opts.trustProxy !== false;

  let secret, token;
  const ready = (async () => {
    store = await opts.store;
    secret = await store.meta('secret', () => randomToken(32));
    token = opts.token || await store.meta('token', () => randomToken(16));
  })();

  // ---- helpers -------------------------------------------------------------

  function clientIp(req) {
    if (trustProxy) {
      const h = req.header('fly-client-ip') || req.header('cf-connecting-ip')
        || (req.header('x-forwarded-for') || '').split(',')[0].trim();
      if (h) return h;
    }
    return req.ip || '0.0.0.0';
  }

  function tokenOk(given) {
    if (!given || given.length !== token.length) return false;
    return timingSafeEqual(Buffer.from(given), Buffer.from(token));
  }

  function str(v, max = MAX_STR) {
    return typeof v === 'string' ? v.slice(0, max) : '';
  }

  /** Whitelist a props object: shallow primitives, plus `ab` as string->string. */
  function cleanProps(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    const out = {};
    for (const [k, v] of Object.entries(p)) {
      if (!NAME_RE.test(k)) continue;
      if (k === 'ab' && v && typeof v === 'object') {
        const ab = {};
        for (const [ak, av] of Object.entries(v)) if (NAME_RE.test(ak) && typeof av === 'string') ab[ak] = av.slice(0, 40);
        if (Object.keys(ab).length) out.ab = ab;
      } else if (typeof v === 'string') out[k] = v.slice(0, MAX_STR);
      else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      else if (typeof v === 'boolean') out[k] = v;
    }
    const json = JSON.stringify(out);
    if (json.length > MAX_PROPS) return null;
    return Object.keys(out).length ? json : null;
  }

  function normalize(raw, { ip, ua, ts }) {
    if (!raw || typeof raw !== 'object') return null;
    const name = str(raw.n, 64);
    const site = str(raw.s, 64).toLowerCase();
    if (!NAME_RE.test(name) || !SITE_RE.test(site)) return null;
    if (allow && !allow.has(site)) return null;
    if (ignore.has(site)) return null;
    const day = dayIn(tz, ts);
    return {
      ts, day, site, name,
      vid: visitorId(secret, day, ip, ua, site),
      path: str(raw.p) || null,
      ref: str(raw.r, 120).toLowerCase() || null,
      props: cleanProps(raw.d),
    };
  }

  async function record(rows) {
    if (!rows.length) return;
    await store.insert(rows);
    for (const r of rows) emitter.emit('event', { ...r, props: r.props ? JSON.parse(r.props) : null });
  }

  // ---- public programmatic API ----------------------------------------------

  /** Record an event from server code. */
  async function track(name, props, { site = opts.site || 'server', vid = 'server' } = {}) {
    await ready;
    const ts = Date.now();
    const row = normalize({ n: name, s: site, d: props }, { ip: vid, ua: 'server', ts });
    if (!row) throw new Error(`tally: bad event ${name} for site ${site}`);
    row.vid = vid;
    await record([row]);
    return row;
  }

  /** The visitor id the browser script's events will carry for this ip+ua today. */
  async function visitorIdFor({ ip, ua = '', site = opts.site || '' }) {
    await ready;
    return visitorId(secret, dayIn(tz, Date.now()), ip, ua, site);
  }

  async function stats(site, days = 30) {
    await ready;
    const nowMs = Date.now();
    const sinceMs = nowMs - days * 86_400_000;
    const todayDay = dayIn(tz, nowMs);
    const raw = await store.stats(site, { sinceMs, todayDay, nowMs });
    return shapeStats(site, raw, { days, tz, nowMs, todayDay });
  }

  async function sites(days = 30) {
    await ready;
    return store.sites(Date.now() - days * 86_400_000);
  }

  /** Per-site totals of one event name since `days` ago: [{site, c, u}]. */
  async function countByName(name, days = 30) {
    await ready;
    return store.countByName(name, Date.now() - days * 86_400_000);
  }

  // ---- HTTP -----------------------------------------------------------------

  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };

  function json(status, body, extra = {}) {
    return { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }, body: JSON.stringify(body) };
  }

  /**
   * @param req { method, path, query: URLSearchParams, header(name), ip, text() }
   * @returns null (not ours) | { status, headers, body } | { sse: { site } }
   */
  async function handle(req) {
    if (!req.path.startsWith(prefix + '/')) return null;
    const path = req.path.slice(prefix.length);
    await ready;

    if (path === '/t.js' && req.method === 'GET') {
      return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300', ...CORS }, body: CLIENT_JS };
    }

    if (path === '/i') {
      if (req.method === 'OPTIONS') return { status: 204, headers: CORS, body: '' };
      if (req.method !== 'POST') return { status: 405, headers: CORS, body: '' };
      const text = await req.text(MAX_BODY);
      if (text == null) return { status: 413, headers: CORS, body: '' };
      let parsed;
      try { parsed = JSON.parse(text); } catch { return { status: 400, headers: CORS, body: '' }; }
      const list = (Array.isArray(parsed) ? parsed : [parsed]).slice(0, MAX_BATCH);
      const ctx = { ip: clientIp(req), ua: req.header('user-agent') || '', ts: Date.now() };
      const rows = list.map((e) => normalize(e, ctx)).filter(Boolean);
      try { await record(rows); } catch (e) { console.error('tally: insert failed', e); return { status: 500, headers: CORS, body: '' }; }
      return { status: 204, headers: CORS, body: '' };
    }

    const m = path.match(/^\/admin\/analytics\/([^/]+)(?:\/([a-z.]+))?\/?$/);
    if (!m) return null;
    if (!tokenOk(m[1])) return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'not found' };
    const sub = m[2] || '';
    const site = req.query.get('site') || opts.site || '';
    const days = Math.min(365, Math.max(1, Number(req.query.get('days')) || 30));

    if (sub === '') {
      return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: dashboardHtml({ base: `${prefix}/admin/analytics/${token}`, tz }) };
    }
    if (sub === 'sites.json') return json(200, await sites(days));
    if (sub === 'stats.json') {
      const s = site || (await sites(days))[0]?.site;
      if (!s) return json(200, { site: null, empty: true });
      return json(200, await stats(s, days));
    }
    if (sub === 'stream') return { sse: { site: site || null } };
    if (sub === 'export.jsonl' || sub === 'export.csv') {
      const csv = sub.endsWith('csv');
      const lines = [];
      if (csv) lines.push('ts,day,site,name,vid,path,ref,props');
      for await (const r0 of store.export(site || null)) {
        const r = { ...r0, props: r0.props && typeof r0.props !== 'string' ? JSON.stringify(r0.props) : r0.props };
        lines.push(csv ? [r.ts, r.day, r.site, r.name, r.vid, r.path ?? '', r.ref ?? '', r.props ?? ''].map(csvCell).join(',') : JSON.stringify(r));
      }
      return { status: 200, headers: { 'content-type': csv ? 'text/csv' : 'application/x-ndjson', 'content-disposition': `attachment; filename="tally-${site || 'all'}.${csv ? 'csv' : 'jsonl'}"` }, body: lines.join('\n') + '\n' };
    }
    return null;
  }

  function dashboardUrl(origin = '') {
    return `${origin}${prefix}/admin/analytics/${token}`;
  }

  // Optional retention. 0 = keep forever.
  let pruneTimer = null;
  if (opts.retentionDays > 0) {
    const run = () => store.prune(Date.now() - opts.retentionDays * 86_400_000).catch((e) => console.error('tally: prune failed', e));
    pruneTimer = setInterval(run, 6 * 3_600_000);
    pruneTimer.unref?.();
    ready.then(run);
  }

  async function close() {
    if (pruneTimer) clearInterval(pruneTimer);
    await store.close();
  }

  return { handle, track, stats, sites, countByName, visitorIdFor, events: emitter, ready, dashboardUrl, get token() { return token; }, tz, prefix, close };
}

function csvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Turn raw store rows into the dashboard's JSON. */
function shapeStats(site, raw, { days, tz, nowMs, todayDay }) {
  const counts = {};
  for (const r of raw.daily) counts[r.name] = (counts[r.name] || 0) + r.c;
  const names = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);

  const byDay = new Map();
  for (const r of raw.daily) {
    if (!byDay.has(r.day)) byDay.set(r.day, { day: r.day, uniques: 0, counts: {} });
    byDay.get(r.day).counts[r.name] = r.c;
  }
  for (const r of raw.dailyUniques) { if (byDay.has(r.day)) byDay.get(r.day).uniques = r.u; }
  // Fill missing days so the table has one row per day, newest first.
  const daily = [];
  for (let i = 0; i < Math.min(days, 90); i++) {
    const d = dayIn(tz, nowMs - i * 86_400_000);
    daily.push(byDay.get(d) || { day: d, uniques: 0, counts: {} });
  }

  const ab = {};
  for (const r of raw.ab) {
    ab[r.k] ??= {};
    ab[r.k][r.arm] ??= { events: {} };
    ab[r.k][r.arm].events[r.name] = r.u;
  }

  const totals = {};
  for (const r of raw.totals) totals[r.name] = r.c;

  return {
    site, tz, days, todayDay, generatedAt: nowMs,
    firstSeen: raw.firstSeen,
    live: { visitors5m: raw.live5m, events1h: raw.live1h },
    today: { pageviews: raw.today?.c ?? 0, uniques: raw.today?.u ?? 0 },
    allTimeVisitors: raw.allTimeVisitors,
    totals, names, daily,
    refs: raw.refs, paths: raw.paths, clicks: raw.clicks, errors: raw.errors,
    devices: Object.fromEntries(raw.devices.map((d) => [d.d, d.u])),
    engagement: { avgSeconds: raw.engagement?.avg ?? null, leaves: raw.engagement?.n ?? 0 },
    ab,
    recent: raw.recent.map((r) => ({ ...r, props: typeof r.props === 'string' ? JSON.parse(r.props) : (r.props ?? null) })),
  };
}
