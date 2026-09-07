// The browser script, served at /t.js. Kept as a string so the module has no
// build step. Plain ES5 on purpose: it must not throw in any browser a game
// might be opened in.
export const CLIENT_JS = `(function () {
  if (typeof window === 'undefined' || !document.currentScript) return;
  var sc = document.currentScript, src = sc.src;
  if (!src) return;
  var ep = src.replace(/t\\.js(\\?.*)?$/, 'i');
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
    try { if (navigator.sendBeacon && navigator.sendBeacon(ep, new Blob([body], { type: 'text/plain' }))) return; } catch (e) {}
    try { fetch(ep, { method: 'POST', body: body, keepalive: true, headers: { 'content-type': 'text/plain' } }).catch(function () {}); } catch (e) {}
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

  var prev = window.tally;
  window.tally = t;
  pageview();
  if (prev && prev.q) for (var i = 0; i < prev.q.length; i++) t.apply(null, prev.q[i]);
})();
`;
