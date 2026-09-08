// Runs the browser script in a fake window to check the two-tag behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_JS } from '../src/client.js';

function fakeWindow(src) {
  const sent = [];
  const listeners = {};
  const win = {
    location: { hostname: 'game.test', pathname: '/', search: '' },
    innerWidth: 800, innerHeight: 600,
    navigator: { language: 'en', sendBeacon: (url, blob) => { sent.push({ url, blob }); return true; } },
    matchMedia: () => ({ matches: false }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    history: {},
    addEventListener: (n, f) => { (listeners[n] ??= []).push(f); },
    setTimeout, clearTimeout, Blob: class { constructor(parts) { this.text = parts.join(''); } },
    fetch: () => Promise.resolve(),
  };
  win.window = win;
  win.document = { currentScript: { src, getAttribute: () => null }, referrer: '', visibilityState: 'visible', addEventListener: win.addEventListener, querySelector: () => null };
  return { win, sent };
}

function run(win) {
  const fn = new Function('window', 'document', 'location', 'navigator', 'matchMedia', 'localStorage', 'history', 'addEventListener', 'setTimeout', 'clearTimeout', 'Blob', 'fetch', 'innerWidth', 'innerHeight', 'URL', CLIENT_JS);
  fn(win, win.document, win.location, win.navigator, win.matchMedia, win.localStorage, win.history, win.addEventListener, win.setTimeout, win.clearTimeout, win.Blob, win.fetch, win.innerWidth, win.innerHeight, URL);
}

test('a second tag adds its endpoint; events go to both', async () => {
  const { win, sent } = fakeWindow('https://a.test/t.js');
  run(win);
  win.document.currentScript = { src: 'https://hub.test/t.js', getAttribute: () => null };
  run(win);
  win.window.tally('start', { level: 1 });
  win.window.tally.flush();
  const urls = sent.map((s) => s.url).sort();
  assert.deepEqual(urls, ['https://a.test/i', 'https://hub.test/i']);
  const body = JSON.parse(sent[0].blob.text);
  assert.deepEqual(body.map((e) => e.n), ['pageview', 'start']);
  assert.equal(body[0].s, 'game.test');
});

test('an older single-endpoint tally that loaded first still receives tally() calls', () => {
  const { win, sent } = fakeWindow('https://hub.test/t.js');
  const got = [];
  win.window.tally = function (n, p) { got.push(n); };   // an old copy, no __tally marker
  run(win);
  win.window.tally('win');
  win.window.tally.flush();
  assert.deepEqual(got, ['win']);
  assert.equal(sent[0].url, 'https://hub.test/i');
});
