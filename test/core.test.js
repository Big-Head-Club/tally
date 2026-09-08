import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTally } from '../src/index.js';

async function boot(opts = {}) {
  const tally = createTally({ file: ':memory:', token: 'tok', tz: 'UTC', ...opts });
  const server = http.createServer(async (req, res) => {
    if (await tally.handler(req, res)) return;
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const post = (body, headers = {}) => fetch(`${base}/i`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'text/plain', ...headers } });
  const stats = async (site = 'demo', days = 30) => (await fetch(`${base}/admin/analytics/tok/stats.json?site=${site}&days=${days}`)).json();
  return { tally, server, base, post, stats, close: () => new Promise((r) => server.close(r)).then(() => tally.close()) };
}

test('serves the script and the dashboard behind the token', async () => {
  const t = await boot();
  const js = await fetch(`${t.base}/t.js`);
  assert.equal(js.status, 200);
  assert.match(await js.text(), /window\.tally = t/);
  assert.equal((await fetch(`${t.base}/admin/analytics/tok`)).status, 200);
  assert.equal((await fetch(`${t.base}/admin/analytics/wrong`)).status, 404);
  assert.equal((await fetch(`${t.base}/admin/analytics/to`)).status, 404);
  assert.equal((await fetch(`${t.base}/nothing`)).status, 404);
  await t.close();
});

test('ingests, counts uniques per ip+ua per day, aggregates', async () => {
  const t = await boot();
  const ua = { 'user-agent': 'A', 'x-forwarded-for': '1.1.1.1' };
  assert.equal((await t.post([
    { n: 'pageview', s: 'Demo', p: '/', r: 'Reddit.com', d: { w: 100, h: 50, touch: true } },
    { n: 'click', s: 'demo', p: '/', d: { t: 'Play' } },
    { n: 'click', s: 'demo', p: '/', d: { t: 'Play' } },
    { n: 'leave', s: 'demo', d: { s: 30 } },
  ], ua)).status, 204);
  await t.post({ n: 'pageview', s: 'demo', p: '/', d: { touch: false } }, ua);            // same visitor
  await t.post({ n: 'pageview', s: 'demo', p: '/x', d: {} }, { 'user-agent': 'B', 'x-forwarded-for': '1.1.1.1' }); // new visitor
  const s = await t.stats();
  assert.equal(s.site, 'demo');
  assert.equal(s.today.pageviews, 3);
  assert.equal(s.today.uniques, 2);
  assert.equal(s.allTimeVisitors, 2);
  assert.deepEqual(s.clicks, [{ t: 'Play', c: 2 }]);
  assert.deepEqual(s.refs, [{ ref: 'reddit.com', u: 1 }]);
  assert.equal(s.engagement.avgSeconds, 30);
  assert.equal(s.daily.length, 30);
  assert.equal(s.daily[0].counts.click, 2);
  assert.equal(s.daily[0].uniques, 2);
  assert.deepEqual(s.devices, { touch: 1, mouse: 2 }); // visitor A shows up in both
  const sites = await (await fetch(`${t.base}/admin/analytics/tok/sites.json`)).json();
  assert.equal(sites[0].site, 'demo');
  assert.equal(sites[0].visitors, 2);
  await t.close();
});

test('rejects junk without leaking why, caps sizes, respects allowlist', async () => {
  const t = await boot({ sites: ['ok'] });
  assert.equal((await t.post('not json')).status, 400);
  assert.equal((await t.post('x'.repeat(40_000))).status, 413);
  await t.post([
    { n: 'bad name!', s: 'ok' },
    { n: 'fine', s: 'nope' },                        // not in allowlist
    { n: 'fine', s: 'ok', d: { big: 'x'.repeat(5000), nested: { a: 1 }, ok: 1, ab: { arm: 'b', 'bad key!': 'x' } } },
  ]);
  const s = await t.stats('ok');
  assert.deepEqual(Object.keys(s.totals), ['fine']);
  assert.equal(s.recent.length, 1);
  assert.equal(s.recent[0].props.big.length, 200); // long strings are cut, not dropped
  const { big, ...rest } = s.recent[0].props;
  assert.deepEqual(rest, { ok: 1, ab: { arm: 'b' } });
  assert.deepEqual(Object.keys(s.ab), ['arm']);
  assert.equal((await fetch(`${t.base}/admin/analytics/tok/stats.json?site=nope`)).status, 200);
  assert.equal((await t.stats('nope')).allTimeVisitors, 0);
  await t.close();
});

test('streams live events over SSE, filtered by site', async () => {
  const t = await boot();
  const ac = new AbortController();
  const res = await fetch(`${t.base}/admin/analytics/tok/stream?site=demo`, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const readUntil = async (re) => { while (!re.test(buf)) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); } };
  await readUntil(/:ok/);
  await t.post({ n: 'click', s: 'other', d: { t: 'no' } });
  await t.post({ n: 'click', s: 'demo', d: { t: 'yes' } });
  await readUntil(/data: .*\n\n/);
  const rows = [...buf.matchAll(/data: (.*)\n/g)].map((m) => JSON.parse(m[1]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].site, 'demo');
  assert.deepEqual(rows[0].props, { t: 'yes' });
  ac.abort();
  await t.close();
});

test('server-side track() and visitor() agree with the browser hash', async () => {
  const t = await boot({ site: 'demo' });
  await t.post({ n: 'pageview', s: 'demo', d: {} }, { 'user-agent': 'A', 'x-forwarded-for': '9.9.9.9' });
  const vid = await t.tally.visitor({ headers: { 'x-forwarded-for': '9.9.9.9', 'user-agent': 'A', host: 'demo' } });
  await t.tally.track('purchase', { cents: 500 }, { vid });
  const s = await t.stats();
  assert.equal(s.allTimeVisitors, 1);
  assert.equal(s.totals.purchase, 1);
  assert.equal(s.recent[0].vid, vid);
  await assert.rejects(() => t.tally.track('bad name!'));
  await t.close();
});

test('exports csv and jsonl', async () => {
  const t = await boot();
  await t.post({ n: 'click', s: 'demo', d: { t: 'a,"b"' } });
  const csv = await (await fetch(`${t.base}/admin/analytics/tok/export.csv?site=demo`)).text();
  assert.match(csv, /^ts,day,site,name,vid,path,ref,props\n/);
  assert.ok(csv.includes('"{""t"":""a,\\""b\\""""}"'), csv);
  const jsonl = await (await fetch(`${t.base}/admin/analytics/tok/export.jsonl`)).text();
  assert.equal(JSON.parse(jsonl.trim()).name, 'click');
  await t.close();
});

test('fetch adapter handles the same routes', async () => {
  const { createTallyFetch } = await import('../src/fetch.js');
  const t = createTallyFetch({ file: ':memory:', token: 'tok' });
  assert.equal(await t.fetch(new Request('http://x/other')), null);
  const r = await t.fetch(new Request('http://x/i', { method: 'POST', body: JSON.stringify({ n: 'pageview', s: 'demo', d: {} }), headers: { 'user-agent': 'A' } }));
  assert.equal(r.status, 204);
  const s = await (await t.fetch(new Request('http://x/admin/analytics/tok/stats.json?site=demo'))).json();
  assert.equal(s.today.pageviews, 1);
  const sse = await t.fetch(new Request('http://x/admin/analytics/tok/stream'));
  assert.equal(sse.headers.get('content-type'), 'text/event-stream');
  await sse.body.cancel();
  await t.close();
});

test('prefix mounts everything under a sub-path', async () => {
  const t = await boot({ prefix: '/_t' });
  assert.equal((await fetch(`${t.base}/t.js`)).status, 404);
  assert.equal((await fetch(`${t.base}/_t/t.js`)).status, 200);
  assert.equal((await fetch(`${t.base}/_t/admin/analytics/tok`)).status, 200);
  assert.match(t.tally.dashboardUrl('http://h'), /^http:\/\/h\/_t\/admin\/analytics\/tok$/);
  assert.equal(t.tally.token, 'tok');
  await t.close();
});

test('drops local-dev sites and counts one event name per site', async () => {
  const t = await boot();
  await t.post({ n: 'pageview', s: 'localhost', d: {} });
  await t.post([{ n: 'start', s: 'a.com' }, { n: 'start', s: 'a.com' }, { n: 'start', s: 'b.com' }]);
  const sites = await (await fetch(`${t.base}/admin/analytics/tok/sites.json`)).json();
  assert.deepEqual(sites.map((s) => s.site).sort(), ['a.com', 'b.com']);
  const starts = await t.tally.countByName('start', 7);
  assert.deepEqual(starts.sort((x, y) => x.site.localeCompare(y.site)), [{ site: 'a.com', c: 2, u: 1 }, { site: 'b.com', c: 1, u: 1 }]);
  await t.close();
});
