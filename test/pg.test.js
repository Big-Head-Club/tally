// Runs only when TALLY_TEST_PG is set to a Postgres URL and `pg` is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
