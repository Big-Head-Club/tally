// Runs the browser script in a scripted window and drives the opt-in
// measurement hooks the way a game would: resume when playable, action after
// an accepted input, pause at menus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_JS } from '../src/client.js';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
const settle = () => new Promise((resolve) => setImmediate(resolve));

function browser({ storage = new Map(), search = '', webdriver = false, qa = false, storageBlocked = false, clockDrift = 0, hangOpen = false } = {}) {
  let now = 0, focused = true, serial = 0;
  const requests = [], timers = new Map(), listeners = new Map();
  const on = (name, fn) => listeners.set(name, [...listeners.get(name) || [], fn]);
  const context = {
    __TALLY_TEST__: qa, crypto: webcrypto, URL, URLSearchParams, Blob, AbortController, Uint8Array,
    performance: { now: () => (now += clockDrift) },
    location: { hostname: 'game.test', search, pathname: '/' }, history: {},
    localStorage: {
      getItem: (k) => { if (storageBlocked) throw new Error('blocked'); return storage.get(k) ?? null; },
      setItem: (k, v) => { if (storageBlocked) throw new Error('blocked'); storage.set(k, v); },
      removeItem: (k) => { storage.delete(k); },
    },
    document: { currentScript: { src: 'https://hub.test/t.js', getAttribute: () => null }, visibilityState: 'visible',
      hasFocus: () => focused, addEventListener: on },
    navigator: { webdriver, language: 'en', sendBeacon: () => false },
    fetch: async (url, options) => {
      if (options?.body) requests.push({ url, ...JSON.parse(options.body) });
      if (hangOpen && url.endsWith('/m')) return new Promise(() => {});
      return { ok: true, status: 200 };
    },
    matchMedia: () => ({ matches: false }),
    innerWidth: 800, innerHeight: 600,
    addEventListener: on,
    setInterval: (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms, at: now + ms }); return id; },
    setTimeout: (fn, ms) => { const id = ++serial; timers.set(id, { fn, at: now + ms }); return id; },
    clearInterval: (id) => timers.delete(id), clearTimeout: (id) => timers.delete(id),
  };
  context.window = context;
  runInNewContext(CLIENT_JS, context);
  const fire = (name) => { for (const fn of listeners.get(name) || []) fn({}); };
  return {
    context, tally: context.window.tally, requests, storage,
    checkpoints: () => requests.filter((r) => r.url.endsWith('/m')),
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, t] = due; now = t.at;
        if (t.ms) t.at += t.ms; else timers.delete(id);
        t.fn();
      }
      now = target;
    },
    sleep(ms) { now += ms; for (const t of timers.values()) if (t.ms) { t.at = now + t.ms; t.fn(); } },
    focus(value) { focused = value; fire(value ? 'focus' : 'blur'); },
    hide(value) { context.document.visibilityState = value ? 'hidden' : 'visible'; fire('visibilitychange'); },
    fire,
  };
}

const total = (p) => p.intervals.reduce((n, [a, b]) => n + b - a, 0);

test('measurement is opt-in; pageviews and legacy events accrue nothing', async () => {
  const b = browser();
  b.tally('start', { level: 1 });
  b.advance(45_000);
  assert.equal(b.checkpoints().length, 0);
  b.tally.measure({ gameId: 'demo' });
  await settle();
  b.advance(45_000); b.hide(true);
  assert.equal(total(b.checkpoints().at(-1)), 0);
  assert.equal(b.checkpoints().at(-1).actions, 0);
});

test('only accepted actions accrue; pause, blur, hidden and idle exclude time', async () => {
  const b = browser(), m = b.tally.measure({ gameId: 'demo' });
  await settle();
  assert.equal(m.action(), false);
  m.resume();
  assert.equal(m.action({ isTrusted: false }), false);
  assert.equal(m.action({ isTrusted: true, repeat: true }), false);
  m.action({ isTrusted: true }); b.advance(10000); m.action(); b.advance(20000);
  m.pause(); b.advance(10000);
  assert.equal(total(b.checkpoints().at(-1)), 30000);
  m.resume(); m.action(); b.advance(5000); b.focus(false); b.advance(10000);
  assert.equal(total(b.checkpoints().at(-1)), 35000);
  b.focus(true); m.action(); b.advance(5000); b.hide(true); b.advance(10000);
  assert.equal(total(b.checkpoints().at(-1)), 40000);
  b.hide(false); m.action(); b.advance(90000); m.pause();
  assert.equal(total(b.checkpoints().at(-1)), 100000);   // the 60s allowance, not the full 90s
});

test('sleep, BFCache and reload always rotate the stream, never reset the clock in place', async () => {
  const b = browser(), m = b.tally.measure({ gameId: 'demo' });
  await settle();
  m.resume(); m.action(); b.advance(20000);
  const first = b.checkpoints().at(-1).streamId;
  b.sleep(120000); await settle();
  assert.equal(total(b.checkpoints().at(-1)), 20000);    // the sleep is not charged
  m.action(); await settle(); b.advance(5000); b.fire('pagehide');
  const second = b.checkpoints().at(-1);
  assert.notEqual(second.streamId, first);
  assert.equal(total(second), 5000);
  b.fire('pageshow'); await settle(); m.action(); b.advance(5000); m.pause();
  assert.notEqual(b.checkpoints().at(-1).streamId, second.streamId);
  const reload = browser({ storage: b.storage }); reload.tally.measure({ gameId: 'demo' }); await settle();
  assert.notEqual(reload.checkpoints()[0].streamId, second.streamId);
  assert.equal(reload.checkpoints()[0].browserId, second.browserId);   // same origin-local identity
  assert.equal(reload.checkpoints()[0].persistent, true);
});

test('identity never comes from the URL; blocked storage measures with a temporary id', async () => {
  const b = browser(); b.tally.measure({ gameId: 'demo' }); await settle();
  const next = browser({ storage: b.storage, search: '?tally_mid=11111111-1111-4111-8111-111111111111' });
  next.tally.measure({ gameId: 'demo' }); await settle();
  assert.equal(next.checkpoints()[0].browserId, b.checkpoints()[0].browserId);
  const blocked = browser({ storageBlocked: true }); blocked.tally.measure({ gameId: 'demo' }); await settle();
  assert.equal(blocked.checkpoints()[0].persistent, false);
  assert.match(blocked.checkpoints()[0].browserId, /^[0-9a-f-]{36}$/);
});

test('QA designations, webdriver and opted-out browsers send nothing measured', async () => {
  for (const options of [{ qa: true }, { search: '?tally_test=1' }]) {
    const b = browser(options), m = b.tally.measure({ gameId: 'demo' });
    b.tally('start'); m.resume(); m.action(); b.advance(45000); m.pause(); await settle();
    assert.equal(b.checkpoints().length, 0);      // measurement suppressed
    assert.ok(b.requests.length > 0);             // the legacy tracker still runs
  }
  const headless = browser({ webdriver: true });
  assert.equal(headless.tally, undefined);        // the script exits before defining anything
  assert.equal(headless.requests.length, 0);
  const b = browser(); b.tally.ignore();
  const m = b.tally.measure({ gameId: 'demo' });
  m.resume(); m.action({ isTrusted: true }); b.advance(45000); m.pause(); await settle();
  // The page queued a pageview before ignore(), which the legacy tracker may
  // still deliver; measurement is muted entirely, and so are later legacy calls.
  assert.ok(b.requests.every((r) => !r.url.endsWith('/m')));
  const before = b.requests.length;
  b.tally('later_event'); b.advance(2000); await settle();
  assert.equal(b.requests.length, before);
});

test('restarts of the same measure() keep one stream going', async () => {
  const b = browser(), m = b.tally.measure({ gameId: 'demo' });
  await settle();
  m.resume();
  for (let i = 0; i < 7; i++) { m.action(); b.advance(30000); }
  m.pause(); await settle();
  assert.equal(total(b.checkpoints().at(-1)), 210000);
  const id = b.checkpoints().at(-1).streamId;
  m.resume(); m.action(); b.advance(15000); m.pause();
  assert.equal(b.checkpoints().at(-1).streamId, id);
  assert.equal(total(b.checkpoints().at(-1)), 225000);
  // A second measure() call is the same game: the same object, no new identity.
  assert.equal(b.tally.measure({ gameId: 'demo' }), m);
  assert.throws(() => b.tally.measure({ gameId: 'another' }), /one measured game/i);
  assert.throws(() => b.tally.measure({ gameId: 'BAD' }), /needs a gameId/i);
});

test('clock drift preserves immutable checkpoint prefixes; ten minutes rotates', async () => {
  const b = browser({ clockDrift: 1 }), m = b.tally.measure({ gameId: 'demo' });
  await settle();
  m.resume();
  for (let i = 0; i < 24; i++) { m.action(); b.advance(30000); await settle(); }
  m.pause();
  assert.ok(new Set(b.checkpoints().map((p) => p.streamId)).size >= 2);   // rotated past ten minutes
  for (const p of b.checkpoints()) {
    if (p.intervals.length) {
      assert.ok(p.actions > 0);
      assert.ok(p.intervals[0][0] >= p.firstActionMs);
      assert.ok(p.intervals.at(-1)[1] <= p.lastActionMs + 60000);
      for (let i = 1; i < p.intervals.length; i++) assert.ok(p.intervals[i][0] >= p.intervals[i - 1][1]);
    }
  }
  const snapshots = b.checkpoints().filter((p) => p.sequence > 0);
  for (let i = 1; i < snapshots.length; i++) {
    const prior = snapshots[i - 1], next = snapshots[i];
    if (prior.streamId !== next.streamId) continue;
    const prefix = next.intervals.filter(([a]) => a < prior.elapsedMs).map(([a, z]) => [a, Math.min(z, prior.elapsedMs)]);
    assert.deepEqual(prefix, prior.intervals);
  }
});

test('a hanging open has a deadline and keeps retrying without anchoring', async () => {
  const b = browser({ hangOpen: true }), m = b.tally.measure({ gameId: 'demo' });
  m.resume(); m.action(); b.advance(20000); await settle();
  assert.ok(b.checkpoints().length >= 3);
  assert.ok(b.checkpoints().every((p) => p.sequence === 0));
});

test('reports carry the site and build; the payload is exactly the contract', async () => {
  const b = browser(), m = b.tally.measure({ gameId: 'demo', build: '2026.09.30' });
  await settle();
  assert.deepEqual(b.checkpoints()[0], { url: 'https://hub.test/m', version: 1,
    streamId: b.checkpoints()[0].streamId, browserId: b.checkpoints()[0].browserId, persistent: true,
    site: 'game.test', gameId: 'demo', build: '2026.09.30', sequence: 0, elapsedMs: 0, intervals: [],
    actions: 0, firstActionMs: null, lastActionMs: null, state: 'idle' });
  m.resume(); m.action({ isTrusted: true }); b.advance(16000); await settle();
  assert.equal(b.checkpoints().at(-1).site, 'game.test');
  assert.equal(b.checkpoints().at(-1).build, '2026.09.30');
  assert.ok(b.checkpoints().at(-1).sequence > 0);
});
