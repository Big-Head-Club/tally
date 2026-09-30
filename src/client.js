// The browser script, served at /t.js. Kept as a string so the module has no
// build step. Plain ES5 on purpose: it must not throw in any browser a game
// might be opened in.
export const CLIENT_JS = `(function () {
  if (typeof window === 'undefined' || !document.currentScript) return;
  if (navigator.webdriver) return;   // headless Chrome, Playwright, Puppeteer: not a person
  var sc = document.currentScript, src = sc.src;
  if (!src) return;
  var ep = src.replace(/t\\.js(\\?.*)?$/, 'i'), eps = [ep];
  var site = (sc.getAttribute('data-site') || location.hostname).toLowerCase();
  var ignore = false, ab = {}, q = [], timer = null, seen = {};
  var qs = location.search;
  try {
    if (/[?&]tally=ignore/.test(qs)) localStorage.setItem('tally_ignore', '1');
    if (/[?&]tally=track/.test(qs)) localStorage.removeItem('tally_ignore');
    ignore = localStorage.getItem('tally_ignore') === '1';
    ab = JSON.parse(localStorage.getItem('tally_ab') || '{}') || {};
  } catch (e) {}

  function send() {
    if (!q.length) return;
    var body = JSON.stringify(q); q = [];
    for (var i = 0; i < eps.length; i++) post(eps[i], body);
  }
  function post(to, body) {
    try { if (navigator.sendBeacon && navigator.sendBeacon(to, new Blob([body], { type: 'text/plain' }))) return; } catch (e) {}
    try { fetch(to, { method: 'POST', body: body, keepalive: true, headers: { 'content-type': 'text/plain' } }).catch(function () {}); } catch (e) {}
  }
  function t(name, props) {
    if (ignore || !name) return;
    var d = {};
    if (props && typeof props === 'object') for (var k in props) d[k] = props[k];
    var keys = 0; for (var a in ab) keys++;
    if (keys) d.ab = ab;
    q.push({ n: String(name), s: site, p: location.pathname, d: d });
    if (q.length >= 10) send(); else { clearTimeout(timer); timer = setTimeout(send, 800); }
  }
  function param(n) { var m = qs.match(new RegExp('[?&]' + n + '=([^&]*)')); return m ? decodeURIComponent(m[1].replace(/\\+/g, ' ')).slice(0, 80) : undefined; }
  function pageview() {
    var d = {
      w: innerWidth, h: innerHeight,
      touch: !!(window.matchMedia && matchMedia('(pointer:coarse)').matches),
      lang: (navigator.language || '').slice(0, 10)
    };
    var s = param('utm_source'), m = param('utm_medium'), c = param('utm_campaign');
    if (s) d.src = s; if (m) d.med = m; if (c) d.cmp = c;
    var r = '';
    try { var u = new URL(document.referrer); if (u.hostname && u.hostname !== location.hostname) r = u.hostname; } catch (e) {}
    if (ignore) return;
    q.push({ n: 'pageview', s: site, p: location.pathname, r: r, d: (function () { var k = 0; for (var x in ab) k++; if (k) d.ab = ab; return d; })() });
    clearTimeout(timer); timer = setTimeout(send, 800);
  }

  // Did they come back? The visitor hash is salted per day, so the server cannot
  // tell. The browser keeps two dates for this site (first visit, last visit) and
  // nothing else: no id. Once per local calendar day it says how many days since
  // the first. No storage, no visit event.
  function ymd(x) { return x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2) + '-' + ('0' + x.getDate()).slice(-2); }
  function visit() {
    if (ignore) return;
    var key = 'tally_days:' + site, today = ymd(new Date()), rec;
    try { rec = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return; }
    var isNew = !rec || !/^\\d{4}-\\d{2}-\\d{2}$/.test(rec.f);
    if (isNew) rec = { f: today };
    if (rec.l === today) return;
    rec.l = today;
    try { localStorage.setItem(key, JSON.stringify(rec)); } catch (e) { return; }
    var p = function (s) { var a = s.split('-'); return Date.UTC(+a[0], a[1] - 1, +a[2]); };
    t('visit', { days_since_first: Math.max(0, Math.round((p(today) - p(rec.f)) / 864e5)), new: isNew });
  }

  // Clicks on buttons and links, named by data-a, text, aria-label or id.
  document.addEventListener('click', function (ev) {
    var el = ev.target && ev.target.closest && ev.target.closest('button,a,[data-a],[role=button],input[type=submit],summary');
    if (!el) return;
    var a = el.getAttribute('data-a');
    if (a === 'off') return;
    var label = a || (el.innerText || el.value || el.getAttribute('aria-label') || el.title || el.id || '').replace(/\\s+/g, ' ').trim().slice(0, 40) || el.tagName.toLowerCase();
    var d = { t: label };
    if (el.href) d.href = String(el.href).slice(0, 200);
    t('click', d);
  }, true);

  // Seconds the page was actually visible, sent when the visitor leaves.
  var vis = 0, since = document.visibilityState === 'visible' ? Date.now() : 0, left = false;
  function pause() { if (since) { vis += Date.now() - since; since = 0; } }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') since = Date.now(); else pause(); });
  function leave() { if (left) return; left = true; pause(); t('leave', { s: Math.round(vis / 1000) }); send(); }
  addEventListener('pagehide', leave);
  addEventListener('pageshow', function (e) { if (e.persisted) { left = false; since = Date.now(); } });

  // Uncaught errors, once per distinct message per page.
  addEventListener('error', function (e) {
    var m = String(e.message || 'error'); if (seen[m]) return; seen[m] = 1;
    t('error', { m: m.slice(0, 200), src: ((e.filename || '').replace(location.origin, '') + ':' + (e.lineno || 0)).slice(0, 120) });
  });
  addEventListener('unhandledrejection', function (e) {
    var r = e.reason, m = 'unhandled: ' + String(r && r.message || r || '').slice(0, 180); if (seen[m]) return; seen[m] = 1;
    t('error', { m: m });
  });

  // Single-page apps: a pushState that changes the path is a new pageview.
  var lastPath = location.pathname;
  function nav() { if (location.pathname !== lastPath) { lastPath = location.pathname; pageview(); } }
  ['pushState', 'replaceState'].forEach(function (fn) {
    var orig = history[fn]; if (!orig) return;
    history[fn] = function () { var r = orig.apply(this, arguments); nav(); return r; };
  });
  addEventListener('popstate', nav);

  // Sticky A/B arm, stored in localStorage and attached to every later event.
  t.variant = function (key, arms) {
    if (ab[key] && arms.indexOf(ab[key]) >= 0) return ab[key];
    var arm = arms[Math.floor(Math.random() * arms.length)];
    ab[key] = arm;
    try { localStorage.setItem('tally_ab', JSON.stringify(ab)); } catch (e) {}
    t('variant', { k: key, v: arm });
    return arm;
  };
  t.ignore = function (on) { ignore = on !== false; try { localStorage.setItem('tally_ignore', ignore ? '1' : '0'); } catch (e) {} };
  t.flush = send;
  t.site = site;
  t.ignored = function () { return ignore; };

  // Qualified play, opt-in: m = tally.measure({gameId:'my-game', build?}) on
  // page load, m.resume() when playable, m.action(event?) only after the game
  // accepts a real player action, m.pause() at menus, results and pauses. A
  // visit counts while the page is visible, focused and had accepted input in
  // the last minute; the collector groups and judges it.QA browsers (webdriver,
  // __TALLY_TEST__, ?tally_test=1) and opted-out browsers are never measured.
  var measurement = null;
  function measure(o) {
    o = o || {};
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(o.gameId || '')) throw new Error('tally.measure needs a gameId like "my-game"');
    if (o.build != null && !/^[\\w.-]{1,64}$/.test(String(o.build))) throw new Error('tally.measure build is up to 64 of a-z 0-9 _ . -');
    if (measurement) {
      if (measurement.gameId !== o.gameId) throw new Error('tally.measure: one measured game per page');
      return measurement;
    }
    var gameId = o.gameId, build = o.build != null && o.build !== '' ? String(o.build) : null;
    var test = window.__TALLY_TEST__ === true || /[?&]tally_test=1/.test(qs);
    var browserId = null, persistent = false;
    try {
      browserId = localStorage.getItem('tally_mid');
      if (browserId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(browserId)) {
        persistent = true;
      } else {
        browserId = guid(); persistent = false;
        localStorage.setItem('tally_mid', browserId);
        persistent = localStorage.getItem('tally_mid') === browserId;
      }
    } catch (e) { browserId = browserId || guid(); persistent = false; }

    var playable = false, active = false, lastAction = -Infinity, previous = nowMs();
    var stream = null, opening = null, stopped = false, lastReport = previous;
    var visible = function () { return document.visibilityState === 'visible' && document.hasFocus(); };
    var epm = src.replace(/t\\.js(\\?.*)?$/, 'm');

    function nowMs() { return window.performance && performance.now ? performance.now() : Date.now(); }
    function payload(s, state) {
      return { version: 1, streamId: s.id, browserId: browserId, persistent: persistent,
        site: site, gameId: gameId, build: build, sequence: ++s.sequence,
        elapsedMs: s.elapsed, intervals: s.intervals, actions: s.actions,
        firstActionMs: s.firstAction, lastActionMs: s.lastAction, state: state };
    }
    function post(body, signal) {
      return fetch(epm, { method: 'POST', mode: 'cors', keepalive: true,
        headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body), signal: signal });
    }
    function open() {
      if (ignore || test || opening || stopped || stream) return;
      var began = nowMs();
      var s = { id: guid(), zero: began, elapsed: 0, sequence: 0, intervals: [], actions: 0, firstAction: null, lastAction: null, countedAt: null };
      opening = s.id;
      var controller = null, deadline = null;
      if (typeof AbortController === 'function') {
        controller = new AbortController();
        deadline = setTimeout(function () { controller.abort(); if (opening === s.id) opening = null; }, 5000);
      }
      var body = payload(s, 'idle'); body.sequence = 0; body.elapsedMs = 0;
      post(body, controller && controller.signal).then(function (r) {
        if (!r || !r.ok || opening !== s.id || stopped) return;
        // The monotonic clock starts only once the open is durable. Time spent
        // offline or hung is never backfilled.
        s.zero = nowMs(); stream = s; previous = s.zero; lastReport = s.zero;
        if (playable && visible() && s.zero - lastAction <= 5000) acceptAction(s.zero);
      }).catch(function () {}).then(function () { clearTimeout(deadline); if (opening === s.id) opening = null; });
    }
    function flush(state, beacon) {
      var s = stream;
      if (!s || ignore || test) return;
      lastReport = nowMs();
      var body = payload(s, state);
      if (beacon) {
        var text = JSON.stringify(body);
        try { if (navigator.sendBeacon && navigator.sendBeacon(epm, new Blob([text], { type: 'text/plain' }))) return; } catch (e) {}
      }
      post(body).then(function (r) {
        // A refused checkpoint invalidates the stream; a lost report stays queued server-side.
        if (r && (r.status === 409 || r.status === 400) && stream === s) { stream = null; active = false; lastAction = -Infinity; }
      }).catch(function () {});
    }
    function clock() {
      var now = nowMs(), gap = now - previous;
      if (stream && (gap > 5000 || now - stream.zero >= 600000 || stream.intervals.length >= 128)) {
        // Seal at the last observed tick: a sleeping or throttled browser is not playing.
        flush('closed', true); stream = null; active = false;
        lastAction = -Infinity;
      }
      if (stream && active && gap >= 0 && gap <= 5000) {
        var from = Math.max(0, Math.floor(previous - stream.zero));
        var to = Math.max(from, Math.floor(Math.min(now, lastAction + 60000) - stream.zero));
        if (to > from) {
          var tail = stream.intervals[stream.intervals.length - 1];
          if (tail && tail[1] === from) tail[1] = to;
          else stream.intervals.push([from, to]);
        }
      }
      if (stream) stream.elapsed = Math.max(0, Math.floor(now - stream.zero));
      previous = now;
      active = !!stream && playable && visible() && now < lastAction + 60000;
      return now;
    }
    function acceptAction(now) {
      if (stream) {
        var at = Math.floor(now - stream.zero);
        // Pointers can fire hundreds of times a second: buckets stay 100ms
        // apart, but every accepted update renews the attention allowance.
        if (stream.countedAt == null || at - stream.countedAt >= 100) { stream.actions++; stream.countedAt = at; }
        stream.lastAction = at;
        if (stream.firstAction === null) stream.firstAction = at;
      }
      lastAction = now;
      active = !!stream && playable && visible();
    }
    measurement = {
      gameId: gameId,
      resume: function () { clock(); playable = true; active = !!stream && visible() && nowMs() < lastAction + 60000; open(); },
      pause: function () { clock(); playable = false; active = false; flush('paused'); },
      action: function (event) {
        if (ignore || test || !playable || !visible() || (event && (!event.isTrusted || event.repeat))) return false;
        var now = clock();
        acceptAction(now); open();
        return true;
      },
    };
    if (ignore || test) return measurement;
    open();
    setInterval(function () {
      clock();
      if (active && nowMs() - lastReport >= 15000) flush('playing');
      else if (!active && stream && lastReport < previous && stream.intervals.length && nowMs() - lastAction >= 60000 && nowMs() - lastReport >= 15000) flush('idle');
      if (!stream && playable && visible() && nowMs() < lastAction + 60000) open();
    }, 1000);
    function visibility() {
      clock(); active = !!stream && playable && visible() && nowMs() < lastAction + 60000;
      flush(visible() ? (active ? 'playing' : 'idle') : 'hidden', !visible());
    }
    document.addEventListener('visibilitychange', visibility);
    addEventListener('blur', visibility);
    addEventListener('focus', visibility);
    addEventListener('pagehide', function () { clock(); stopped = true; active = false; flush('closed', true); stream = null; });
    addEventListener('pageshow', function () { stopped = false; previous = nowMs(); lastAction = -Infinity; open(); });
    return measurement;
  }
  function guid() {
    var b = new Uint8Array(16);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = '', x;
    for (i = 0; i < 16; i++) { x = (b[i] < 16 ? '0' : '') + b[i].toString(16); h += x; }
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  t.measure = measure;


  // Two tags on one page, one tracker. A second copy of this script adds its
  // endpoint to the first instead of replacing it. An older single-endpoint copy
  // that loaded first still gets the page's own tally() calls, forwarded.
  var prev = window.tally;
  if (prev && prev.__tally && prev.__add) { prev.__add(ep); return; }
  var prevFn = typeof prev === 'function' && !prev.q ? prev : null;
  var pub = function (name, props) {
    t(name, props);
    if (prevFn) { try { prevFn(name, props); } catch (e) {} }
  };
  for (var k in t) pub[k] = t[k];
  pub.__tally = 1;
  pub.__add = function (e2) { if (eps.indexOf(e2) < 0) eps.push(e2); };
  window.tally = pub;
  pageview();
  visit();
  if (prev && prev.q) for (var i = 0; i < prev.q.length; i++) pub.apply(null, prev.q[i]);
})();
`;
