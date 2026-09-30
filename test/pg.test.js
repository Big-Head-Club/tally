// Runs only when TALLY_TEST_PG is set to a Postgres URL and `pg` is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTally } from '../src/index.js';

const url = process.env.TALLY_TEST_PG;

test('postgres store: insert, stats, ab, export, prune', { skip: !url && 'set TALLY_TEST_PG' }, async () => {
  const { openPg } = await import('../src/store-pg.js');
  const store = await openPg(url);
  await store.prune(Date.now() + 1); // start clean
  const tally = createTally({ store, token: 'tok', tz: 'UTC' });
  await tally.ready;
  const vid = await tally.visitorIdFor({ ip: '1.1.1.1', ua: 'A', site: 'pgdemo' });
  await tally.track('pageview', { touch: true, ab: { color: 'red' } }, { site: 'pgdemo', vid });
  await tally.track('click', { t: 'Play', ab: { color: 'red' } }, { site: 'pgdemo', vid });
  await tally.track('leave', { s: 12 }, { site: 'pgdemo', vid });
  await tally.track('error', { m: 'boom' }, { site: 'pgdemo', vid });
  const s = await tally.stats('pgdemo', 7);
  assert.equal(s.today.pageviews, 1);
  assert.equal(s.today.uniques, 1);
  assert.equal(s.allTimeVisitors, 1);
  assert.deepEqual(s.clicks, [{ t: 'Play', c: 1 }]);
  assert.deepEqual(s.devices, { touch: 1 });
  assert.equal(s.engagement.avgSeconds, 12);
  assert.equal(s.ab.color.red.events.click, 1);
  assert.equal(s.errors[0].m, 'boom');
  assert.equal(s.recent[0].props.m, 'boom');
  const sites = await tally.sites(7);
  assert.equal(sites[0].site, 'pgdemo');
  assert.equal(sites[0].visitors, 1);
  const rows = [];
  for await (const r of store.export('pgdemo')) rows.push(r);
  assert.equal(rows.length, 4);
  assert.equal(await store.prune(Date.now() + 1), 4);
  await tally.close();
});

test('postgres store: measurement ingestion and stats', { skip: !url && 'set TALLY_TEST_PG' }, async () => {
  const { openPg } = await import('../src/store-pg.js');
  const store = await openPg(url);
  await store.prune(Date.now() + 1);
  const tally = createTally({ store, token: 'tok', tz: 'UTC' });
  await tally.ready;
  const open = (over = {}) => ({ version: 1, streamId: crypto.randomUUID(), browserId: crypto.randomUUID(), persistent: true,
    site: 'pgdemo', gameId: 'demo', build: null, sequence: 0, elapsedMs: 0, intervals: [], actions: 0,
    firstActionMs: null, lastActionMs: null, state: 'idle', ...over });
  const e = open();
  await store.measurement(e);
  await store.measurement({ ...e, streamId: e.streamId });                       // duplicate open
  // Give the stream a realistic two minutes of wall age, as a client that only
  // reports what its own clock has seen would have.
  const { Pool } = (await import('pg')).default ?? (await import('pg'));
  const raw = new Pool({ connectionString: url, max: 1 });
  await raw.query('update tally_measurement_streams set started_at = started_at - 120000 where id = $1', [e.streamId]);
  const day = 86_400_000, asOf = Date.now() + 3 * day;
  await store.measurement({ ...e, sequence: 1, elapsedMs: 40000, intervals: [[1000, 40000]], actions: 2, firstActionMs: 1000, lastActionMs: 10000, state: 'playing' });
  await store.measurement({ ...e, sequence: 3, elapsedMs: 60000, intervals: [[1000, 60000]], actions: 3, firstActionMs: 1000, lastActionMs: 30000, state: 'playing' });
  await store.measurement({ ...e, sequence: 1, elapsedMs: 40000, intervals: [[1000, 40000]], actions: 2, firstActionMs: 1000, lastActionMs: 10000, state: 'playing' });  // stale retry: welcome
  await assert.rejects(store.measurement({ ...e, browserId: crypto.randomUUID(), sequence: 4, elapsedMs: 60000, intervals: [[1000, 60000]], actions: 3, firstActionMs: 1000, lastActionMs: 30000, state: 'playing' }), /stream_binding/);
  await assert.rejects(store.measurement({ ...e, sequence: 4, elapsedMs: 60000, intervals: [[500, 60000]], actions: 3, firstActionMs: 1000, lastActionMs: 30000, state: 'playing' }), /rewritten_history/);
  await store.measurement({ ...e, sequence: 4, elapsedMs: 60000, intervals: [[1000, 60000]], actions: 3, firstActionMs: 1000, lastActionMs: 30000, state: 'closed' });
  await assert.rejects(store.measurement({ ...e, sequence: 5, elapsedMs: 60000, intervals: [[1000, 60000]], actions: 3, firstActionMs: 1000, lastActionMs: 30000, state: 'closed' }), /stale_or_regressed_checkpoint/);
  const stats = await tally.measurementStats('pgdemo', asOf);
  assert.equal(stats.length, 1);
  assert.equal(stats[0].gameId, 'demo');
  assert.equal(stats[0].eligibleVisits, 1);
  assert.equal(stats[0].qualifiedVisits, 1);      // 40 covered seconds, 3 inputs, 30s span
  assert.equal(stats[0].engagementRate, 1);
  assert.equal(stats[0].initialMeanMinutes, 0.9833);   // 59 covered seconds
  assert.equal(stats[0].d1, 0);                   // a real zero: the window is mature, no return happened
  assert.equal(stats[0].engagedBrowsers, 1);
  assert.equal((await tally.measurementStats('other')).length, 0);
  const streams = await store.measurementStreams('pgdemo');
  assert.equal(streams.length, 1);
  assert.equal(streams[0].sequence, 4);
  assert.equal(streams[0].state, 'closed');
  assert.equal(await store.prune(Date.now() + 1), 1);   // the stream goes with the events
  await raw.end();
  await tally.close();
});
