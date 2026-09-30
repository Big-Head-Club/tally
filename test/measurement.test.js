// The /m contract and the qualified-play arithmetic. Streams are anchored on
// the server clock, so history is seeded through a second connection to the
// same SQLite file, the way production data actually looks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const post = (body, headers = {}) => fetch(`${base}/m`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'text/plain', 'user-agent': 'Mozilla/5.0 tester', 'x-forwarded-for': '1.1.1.1', ...headers },
  });
  return { tally, server, base, post, close: () => new Promise((r) => server.close(r)).then(() => tally.close()) };
}

function round(n) { return Math.round(n * 10_000) / 10_000; }

const open = (over = {}) => ({ version: 1, streamId: randomUUID(), browserId: randomUUID(), persistent: true,
  site: 'g.test', gameId: 'demo', build: null, sequence: 0, elapsedMs: 0, intervals: [], actions: 0,
  firstActionMs: null, lastActionMs: null, state: 'idle', ...over });

test('measurement: open, cumulative progress, duplicate and reordered reports', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tally-m-'));
  const t = await boot({ file: join(dir, 'm.sqlite') });
  const seed = new DatabaseSync(join(dir, 'm.sqlite'));
  const e = open();
  assert.equal((await t.post(e)).status, 204);
  // The client only ever reports what its own clock has seen, so give the
  // stream a realistic 45 seconds of wall age before the bigger checkpoints.
  seed.prepare('update measurement_streams set started_at = ? where id = ?').run(Date.now() - 45_000, e.streamId);
  const first = { ...e, sequence: 1, elapsedMs: 15000, intervals: [[0, 15000]], actions: 2, firstActionMs: 0, lastActionMs: 10000, state: 'playing' };
  const latest = { ...first, sequence: 3, elapsedMs: 30000, intervals: [[0, 30000]], actions: 3, lastActionMs: 25000 };
  // Lost, duplicated and reordered reports all converge on the newest.
  const [a, b, c] = await Promise.all([t.post(latest), t.post(first), t.post(latest)]);
  assert.equal(a.status, 204); assert.equal(b.status, 204); assert.equal(c.status, 204);
  const s = await t.tally.measurementStats('g.test');
  assert.equal(s.length, 1);                    // one pending visit, judged but not counted
  assert.equal(s[0].eligibleVisits, 0);
  assert.equal(s[0].engagementRate, null);      // nothing settled yet: null, not zero
  seed.close();
  await t.close();
  rmSync(dir, { recursive: true, force: true });
});

test('measurement: refusals, each for the right reason', async () => {
  const t = await boot();
  const e = open();
  await t.post(e);
  const at = (n) => ({ ...e, sequence: n, elapsedMs: 2000, intervals: [[0, 2000]], actions: 1, firstActionMs: 0, lastActionMs: 1000, state: 'playing' });
  await t.post(at(1));
  const refused = async (body, status, reason) => {
    const r = await t.post(body);
    assert.equal(r.status, status);
    assert.match(await r.text(), new RegExp(reason));
  };
  await refused({ ...at(2), browserId: randomUUID() }, 409, 'stream_binding');
  await refused({ ...at(2), gameId: 'other' }, 409, 'stream_binding');
  await refused({ ...at(2), build: 'x' }, 409, 'stream_binding');
  await refused({ ...at(2), persistent: false }, 409, 'stream_binding');
  await refused({ ...at(1), state: 'paused' }, 409, 'sequence_conflict');
  await refused({ ...at(2), intervals: [[500, 2000]] }, 409, 'rewritten_history');
  await refused({ ...at(2), elapsedMs: 600_000, intervals: [[0, 2000]] }, 409, 'stale_or_regressed_checkpoint');
  await refused({ ...open(), streamId: randomUUID(), sequence: 5 }, 409, 'open_required');
  await refused({ ...at(2), intervals: [[0, NaN]] }, 400, 'invalid_checkpoint');
  await refused({ ...at(2), intervals: [[0, 1000], [500, 2000]] }, 400, 'invalid_checkpoint');
  await refused({ ...at(2), sequence: 0 }, 400, 'invalid_checkpoint');
  await refused({ ...at(2), gameId: 'Bad_Game' }, 400, 'invalid_checkpoint');
  assert.equal((await t.post(at(1))).status, 204);   // the old report stays welcome
  await t.close();
});

test('measurement: a stream silent for two minutes may not grow its settled past', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tally-m-'));
  const t = await boot({ file: join(dir, 'm.sqlite') });
  const seed = new DatabaseSync(join(dir, 'm.sqlite'));
  const e = open();
  seed.prepare(`insert into measurement_streams (id, browser_id, persistent, site, game_id, version, build,
      started_at, received_at, sequence, elapsed_ms, intervals, actions, first_action_ms, last_action_ms, state)
      values (?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?)`)
    .run(e.streamId, e.browserId, 1, e.site, e.gameId, null, Date.now() - 300_000, Date.now() - 300_000, 0, 0, '[]', 0, null, null, 'idle');
  // A stream five minutes old that only ever reported the recent minute is
  // fine; claiming the settled past it never reported is not.
  const shape = { ...e, elapsedMs: 300_000, state: 'playing' };
  const late = { ...shape, sequence: 1, intervals: [[0, 60_000], [290_000, 300_000]], actions: 3, firstActionMs: 0, lastActionMs: 295_000 };
  const refused = await t.post(late);
  assert.equal(refused.status, 409);
  assert.match(await refused.text(), /late_observation/);
  assert.equal((await t.post({ ...shape, sequence: 1, intervals: [[290_000, 300_000]], actions: 2, firstActionMs: 290_000, lastActionMs: 295_000 })).status, 204);
  seed.close();
  await t.close();
  rmSync(dir, { recursive: true, force: true });
});

test('measurement: bots and ignored sites are dropped silently', async () => {
  const t = await boot({ sites: ['g.test'] });
  const e = open();
  assert.equal((await t.post(e, { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' })).status, 204);
  assert.equal((await t.post(e, { 'user-agent': '' })).status, 204);
  assert.equal((await t.post(open({ site: 'other.test' }))).status, 204);   // not on the allowlist
  assert.equal((await t.post(open({ site: 'localhost' }))).status, 204);    // local dev never counts
  assert.equal((await t.post('not json')).status, 400);
  const s = await t.tally.measurementStats(null);
  assert.deepEqual(s, []);
  await t.close();
});

test('measurement: engagement, retention, flags and no false zeros', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tally-m-'));
  const file = join(dir, 'm.sqlite');
  const t = await boot({ file });
  await t.tally.ready;
  const db = new DatabaseSync(file);
  const asOf = 1_800_000_000_000, day = 86_400_000, hour = 3_600_000;
  const seed = (browserId, over = {}) => {
    const r = { site: 'g.test', gameId: 'demo', persistent: 1, at: asOf - day, dur: 60_000, actions: 2, state: 'closed', id: randomUUID(), ...over };
    db.prepare(`insert into measurement_streams (id, browser_id, persistent, site, game_id, version, build,
        started_at, received_at, sequence, elapsed_ms, intervals, actions, first_action_ms, last_action_ms, state)
        values (?,?,?,?,?,1,null,?,?,?,?,?,?,?,?,?)`)
      .run(r.id, browserId, r.persistent, r.site, r.gameId, r.at, r.at + Math.max(r.dur, 1000), 1, r.dur,
        JSON.stringify(r.dur ? [[0, r.dur]] : []), r.actions, r.actions ? 0 : null, r.actions ? Math.min(r.dur, 10_000) : null, r.state);
    return browserId;
  };
  // One browser, three overlapping/sequential streams in one visit: 40 covered seconds.
  const b1 = seed(randomUUID(), { at: asOf - 3 * day, dur: 20_000 });
  seed(b1, { at: asOf - 3 * day + 10_000, dur: 20_000 });
  seed(b1, { at: asOf - 3 * day + 60_000, dur: 10_000 });
  // A minute of play but a single accepted input: never qualifies.
  seed(randomUUID(), { at: asOf - 3 * day, dur: 60_000, actions: 1 });
  // Arrived, left nothing: not qualified, not a cohort.
  seed(randomUUID(), { at: asOf - 3 * day, dur: 0, actions: 0 });
  // Real retention: back next day, back at day 7 (straddles the 168h clip).
  const back = seed(randomUUID(), { at: asOf - 10 * day });
  seed(back, { at: asOf - 10 * day + day, dur: 5_000, actions: 2 });
  seed(back, { at: asOf - 10 * day + 7 * day, dur: 10_000, actions: 2 });   // first input lands exactly at 168h
  // Exactly 48h is outside D1; a day-7 return exactly at 192h is outside D7.
  const edge = seed(randomUUID(), { at: asOf - 10 * day });
  seed(edge, { at: asOf - 10 * day + 2 * day, dur: 5_000, actions: 2 });
  seed(edge, { at: asOf - 10 * day + 8 * day, dur: 5_000, actions: 2 });
  // A same-game return cannot come from another game.
  const solo = seed(randomUUID(), { at: asOf - 10 * day });
  seed(solo, { at: asOf - 10 * day + day, gameId: 'other', dur: 5_000, actions: 2 });
  // Flags: temporary identity, unconfirmed tail, a visit still pending.
  seed(randomUUID(), { at: asOf - 3 * day, persistent: 0 });
  seed(randomUUID(), { at: asOf - 10_000, dur: 5_000, actions: 1, state: 'playing' });
  seed(randomUUID(), { at: asOf - 3 * day, gameId: 'quiet', actions: 1 });   // played, never enough to qualify

  const [g, other, quiet] = await t.tally.measurementStats('g.test', asOf);
  assert.equal(g.gameId, 'demo');
  assert.equal(g.eligibleVisits, 11);          // twelve visits minus the one still pending
  assert.equal(g.qualifiedVisits, 5);          // the four browsers' first visits + the temporary identity's
  assert.equal(g.engagementRate, round(5 / 11));
  assert.equal(g.pendingVisits, 1);
  assert.equal(g.temporaryIdentityVisits, 1);
  assert.equal(g.unconfirmedTailVisits, 1);
  assert.equal(g.engagedBrowsers, 5);
  assert.equal(g.measuredBrowsers, 8);
  assert.equal(g.cohortBrowsers, 4);
  assert.equal(g.initialSample, 4);
  assert.equal(g.initialMeanMinutes, round((40_000 + 3 * 60_000) / 4 / 60_000));
  assert.equal(g.initialMedianMinutes, 1);
  assert.equal(g.d1Denominator, 4);
  assert.equal(g.d1Returns, 1);                // only `back`; `solo` returned in another game, `edge` at exactly 48h
  assert.equal(g.d1, 0.25);
  assert.equal(g.d7Denominator, 3);            // b1's window has not matured
  assert.equal(g.d7Returns, 1);                // `back` lands exactly at 168h; `edge` at exactly 192h is outside
  assert.equal(g.d7, round(1 / 3));
  assert.equal(g.sevenDaySample, 3);
  // The cohort visit's own play counts; `back`'s day-7 visit starts at 168h so nothing clips;
  // `solo`'s return was in another game; `edge`'s day-8 visit is past the 168h window.
  assert.equal(g.sevenDayMeanMinutes, round((60_000 + 65_000 + 65_000) / 3 / 60_000));
  assert.equal(g.sevenDayMedianMinutes, round(65_000 / 60_000));
  assert.equal(quiet.qualifiedVisits, 0);      // a real zero
  assert.equal(quiet.engagementRate, 0);
  assert.equal(quiet.cohortBrowsers, 0);
  assert.equal(quiet.d1, null);                // no cohort yet: not zero, null
  assert.equal(quiet.d7, null);
  await db.close();
  await t.close();
  rmSync(dir, { recursive: true, force: true });
});

test('measurement: the JSON endpoint sits behind the token and re-answers the past', async () => {
  const t = await boot();
  await t.post(open());
  assert.equal((await fetch(`${t.base}/admin/analytics/wrong/measurement.json`)).status, 404);
  const now = await (await fetch(`${t.base}/admin/analytics/tok/measurement.json?site=g.test`)).json();
  assert.equal(now.games.length, 1);           // one open stream: a pending visit, not yet judged
  assert.equal(now.games[0].eligibleVisits, 0);
  assert.equal(now.games[0].engagementRate, null);
  const future = Date.now() + 3_600_000;
  const later = await (await fetch(`${t.base}/admin/analytics/tok/measurement.json?site=g.test&asOf=${future}`)).json();
  assert.equal(later.asOf, future);
  // Asked about an hour ahead, the visit has settled: judged, still unqualified.
  assert.equal(later.games[0].pendingVisits, 0);
  assert.equal(later.games[0].eligibleVisits, 1);
  assert.equal(later.games[0].engagementRate, 0);
  await t.close();
});

test('measurement: fetch adapter serves /m, prune clears old streams', async () => {
  const { createTallyFetch } = await import('../src/fetch.js');
  const f = createTallyFetch({ file: ':memory:', token: 'tok' });
  const r = await f.fetch(new Request('http://x/m', { method: 'POST', body: JSON.stringify(open()),
    headers: { 'user-agent': 'Mozilla/5.0 tester' } }));
  assert.equal(r.status, 204);
  const options = await f.fetch(new Request('http://x/m', { method: 'OPTIONS' }));
  assert.equal(options.status, 204);
  const get = await f.fetch(new Request('http://x/m', { method: 'GET' }));
  assert.equal(get.status, 405);
  await f.close();
});
