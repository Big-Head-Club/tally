// Qualified-play measurement. One module validates the cumulative checkpoints
// the browser reports and turns stored streams into visit, engagement and
// retention numbers, so the SQLite and Postgres stores answer identically.
// Policy 1: a visit counts when the page was visible and focused, the game was
// playable, and the player accepted real input no more than a minute ago; a
// visit qualifies after 30 covered seconds, two input buckets, five seconds
// apart. Same-game cohorts come from the first qualified visit of a persistent
// browser identity, with elapsed D1/D7 windows and a two-minute grace for late
// delivery.
import { covered, union, intersect, difference } from './intervals.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SITE_RE = /^[a-z0-9._-]{1,64}$/;
const GAME_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BUILD_RE = /^[\w.-]{1,64}$/;
const STATES = ['idle', 'playing', 'paused', 'hidden', 'closed'];
const uint = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;

/** The bounds one envelope may not exceed: ten minutes per stream, 128 intervals. */
export const LIMITS = { elapsed: 600_000, intervals: 128, actions: 60_000 };
/** Streams older than this much unreported wall time are closed by the client; */
export const ROTATION_MS = LIMITS.elapsed;

/** Validate one reported checkpoint. Returns the normalized envelope, or null. */
export function readCheckpoint(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.version !== 1 || !UUID_RE.test(raw.streamId || '') || !UUID_RE.test(raw.browserId || '') ||
      typeof raw.persistent !== 'boolean') return null;
  const site = String(raw.site || '').toLowerCase();
  const gameId = String(raw.gameId || '');
  if (!SITE_RE.test(site) || !GAME_ID_RE.test(gameId)) return null;
  const build = raw.build ?? null;
  if (build !== null && !(typeof build === 'string' && BUILD_RE.test(build))) return null;
  if (!uint(raw.sequence, 2147483647) || !uint(raw.elapsedMs, LIMITS.elapsed) ||
      !uint(raw.actions, LIMITS.actions) || !STATES.includes(raw.state) ||
      !Array.isArray(raw.intervals) || raw.intervals.length > LIMITS.intervals) return null;
  let end = -1;
  for (const r of raw.intervals) {
    if (!Array.isArray(r) || r.length !== 2 || !uint(r[0], raw.elapsedMs) || !uint(r[1], raw.elapsedMs) ||
        r[0] <= end || r[1] <= r[0]) return null;
    end = r[1];
  }
  if (raw.actions === 0) {
    if (raw.firstActionMs !== null || raw.lastActionMs !== null || raw.intervals.length) return null;
  } else {
    if (!uint(raw.firstActionMs, raw.elapsedMs) || !uint(raw.lastActionMs, raw.elapsedMs) ||
        raw.lastActionMs < raw.firstActionMs ||
        (raw.intervals.length && (raw.intervals[0][0] < raw.firstActionMs || end > raw.lastActionMs + 60_000)) ||
        raw.actions > (raw.elapsedMs + 1000) / 10) return null;
  }
  // The opening report anchors the stream on the server clock; it carries nothing else.
  if (raw.sequence === 0 && (raw.elapsedMs || raw.actions || raw.intervals.length || raw.state !== 'idle')) return null;
  return {
    streamId: raw.streamId, browserId: raw.browserId, persistent: raw.persistent,
    site, gameId, version: 1, build,
    sequence: raw.sequence, elapsedMs: raw.elapsedMs, intervals: raw.intervals,
    actions: raw.actions, firstActionMs: raw.firstActionMs, lastActionMs: raw.lastActionMs, state: raw.state,
  };
}

/**
 * One store row (milliseconds since the stream opened) against the next
 * cumulative report. Returns null when the report may be written, else a short
 * reason. `ageMs` is the wall time since the server anchored the stream.
 */
export function checkProgress(stored, e, ageMs) {
  if (e.sequence < stored.sequence) return null;
  if (e.sequence === stored.sequence) {
    return sameCheckpoint(stored, e) ? null : 'sequence_conflict';
  }
  if (stored.state === 'closed' || e.elapsedMs < stored.elapsedMs || e.elapsedMs > ageMs + 5000 ||
      ageMs - e.elapsedMs > 120_000 || e.actions < stored.actions ||
      (stored.firstActionMs !== null && e.firstActionMs !== stored.firstActionMs) ||
      (stored.lastActionMs !== null && e.lastActionMs < stored.lastActionMs)) return 'stale_or_regressed_checkpoint';
  // The client is at most two minutes behind its own stream: beyond that it has
  // slept or travelled, and a fresh stream must take over. Nothing observed in
  // the settled past may appear or change, only be extended forward.
  const cutoff = Math.max(0, Math.floor(ageMs) - 120_000);
  const prefix = intersect(e.intervals, [[0, stored.elapsedMs]]);
  if (JSON.stringify(prefix) !== JSON.stringify(stored.intervals)) return 'rewritten_history';
  if (covered(intersect(difference(e.intervals, stored.intervals), [[0, cutoff]])) > 0 ||
      (stored.firstActionMs === null && e.firstActionMs !== null && e.firstActionMs < cutoff) ||
      (e.actions > stored.actions && e.lastActionMs < cutoff)) return 'late_observation';
  return null;
}

function sameCheckpoint(stored, e) {
  return stored.elapsedMs === e.elapsedMs && stored.actions === e.actions &&
    stored.firstActionMs === e.firstActionMs && stored.lastActionMs === e.lastActionMs &&
    stored.state === e.state && JSON.stringify(stored.intervals) === JSON.stringify(e.intervals);
}

// ---- visits ---------------------------------------------------------------

const SETTLE_MS = 32 * 60_000;        // a visit is judged once it cannot grow any more
const VISIT_GAP_MS = 30 * 60_000;     // streams join one visit until this much quiet passes
const MIN_ACTIVE_MS = 30_000;
const MIN_ACTIONS = 2;
const MIN_SPAN_MS = 5_000;
const DAY = 3_600_000;
const GRACE_MS = 2 * 60_000;          // late delivery allowance on every window edge

/**
 * Group streams into visits: per site+game+version+browser, ordered by start,
 * a visit continues while each stream starts before the running activity end
 * plus 30 quiet minutes. Overlapping streams (nested tabs) merge into one set
 * of active ranges. Called with all rows of the measured sites, oldest first.
 */
export function computeVisits(rows) {
  const byBrowser = new Map();
  for (const r of rows) {
    const key = `${r.site}|${r.gameId}|${r.version}|${r.browserId}`;
    if (!byBrowser.has(key)) byBrowser.set(key, []);
    byBrowser.get(key).push(r);
  }
  const visits = [];
  for (const streams of byBrowser.values()) {
    streams.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
    let visit = null, previousEnd = -1, number = 0;
    for (const s of streams) {
      const lastAction = s.lastActionMs ?? 0;
      const lastInterval = s.intervals.length ? s.intervals[s.intervals.length - 1][1] : 0;
      const end = s.startedAt + Math.max(lastAction, lastInterval);
      if (!visit || s.startedAt >= previousEnd + VISIT_GAP_MS) {
        visit = { site: s.site, gameId: s.gameId, version: s.version, browserId: s.browserId, visit: number++,
          persistent: true, arrivedAt: s.startedAt, lastActivityAt: end,
          actions: 0, firstActionAt: null, lastActionAt: null, unconfirmedTail: false, ranges: [] };
        visits.push(visit);
      }
      visit.persistent = visit.persistent && !!s.persistent;
      visit.arrivedAt = Math.min(visit.arrivedAt, s.startedAt);
      visit.lastActivityAt = Math.max(visit.lastActivityAt, end);
      visit.actions += s.actions;
      if (s.firstActionMs != null) {
        const at = s.startedAt + s.firstActionMs;
        visit.firstActionAt = visit.firstActionAt === null ? at : Math.min(visit.firstActionAt, at);
      }
      if (s.lastActionMs != null) {
        const at = s.startedAt + s.lastActionMs;
        visit.lastActionAt = visit.lastActionAt === null ? at : Math.max(visit.lastActionAt, at);
      }
      visit.unconfirmedTail = visit.unconfirmedTail || s.state === 'playing';
      visit.ranges.push(s.intervals.map(([a, b]) => [s.startedAt + a, s.startedAt + b]));
      previousEnd = Math.max(previousEnd, end);
    }
  }
  for (const v of visits) {
    v.activeRanges = union(v.ranges);
    delete v.ranges;
    v.activeMs = covered(v.activeRanges);
    v.qualified = v.activeMs >= MIN_ACTIVE_MS && v.actions >= MIN_ACTIONS &&
      v.firstActionAt !== null && v.lastActionAt !== null && v.lastActionAt >= v.firstActionAt + MIN_SPAN_MS;
  }
  return visits;
}

/**
 * Engagement and same-game retention per measured game, as of `asOf`.
 * Rows are the stored streams for one or more sites. Rates are null, never
 * zero, when their denominator has not earned a value yet.
 */
export function measurementStats(rows, asOf) {
  const visits = computeVisits(rows).filter((v) => v.arrivedAt <= asOf);
  const groups = new Map();
  for (const v of visits) {
    const key = `${v.site}|${v.gameId}|${v.version}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }

  const out = [];
  for (const [key, group] of groups) {
    const [site, gameId, version] = key.split('|');
    const settled = (v) => v.lastActivityAt <= asOf - SETTLE_MS;
    const browsers = new Set(group.map((v) => v.browserId));
    const engaged = new Set(group.filter((v) => v.qualified).map((v) => v.browserId));
    const row = {
      site, gameId, version: Number(version), policyVersion: 1,
      measuredBrowsers: browsers.size,
      engagedBrowsers: engaged.size,
      eligibleVisits: group.filter(settled).length,
      qualifiedVisits: group.filter((v) => v.qualified && settled(v)).length,
      pendingVisits: group.filter((v) => !settled(v)).length,
      engagementRate: null,
      temporaryIdentityVisits: group.filter((v) => !v.persistent).length,
      unconfirmedTailVisits: group.filter((v) => v.unconfirmedTail).length,
      firstObservedAt: Math.min(...group.map((v) => v.arrivedAt)),
      lastActivityAt: Math.max(...group.map((v) => v.lastActivityAt)),
    };
    row.engagementRate = rate(row.qualifiedVisits, row.eligibleVisits);

    // First qualified visit of a persistent identity anchors its cohort.
    const players = new Map();
    for (const v of group) {
      if (!v.qualified || !v.persistent) continue;
      const p = players.get(v.browserId);
      if (!p || v.firstActionAt < p.firstActionAt) players.set(v.browserId, v);
    }

    const minutes7d = new Map(), d1 = new Map(), d7 = new Map();
    for (const [browserId, c] of players) {
      let ms = 0, back1 = false, back7 = false;
      for (const v of group) {
        if (v.browserId !== browserId) continue;
        // Returns are other visits; the seven-day clock counts the cohort's own play too.
        if (v !== c && v.actions > 0 && v.activeMs > 0 && v.firstActionAt !== null) {
          back1 ||= v.firstActionAt >= c.firstActionAt + 24 * DAY && v.firstActionAt < c.firstActionAt + 48 * DAY;
          back7 ||= v.firstActionAt >= c.firstActionAt + 168 * DAY && v.firstActionAt < c.firstActionAt + 192 * DAY;
        }
        ms += covered(intersect(v.activeRanges, [[c.firstActionAt, c.firstActionAt + 168 * DAY]]));
      }
      minutes7d.set(browserId, ms / 60_000);
      d1.set(browserId, back1);
      d7.set(browserId, back7);
    }

    const cohort = [...players.values()];
    const initial = cohort.filter((c) => c.lastActivityAt <= asOf - SETTLE_MS);
    const byFirst = (limit) => cohort.filter((c) => c.firstActionAt <= asOf - limit);
    const d1Sample = byFirst(48 * DAY + GRACE_MS);
    const d7Sample = byFirst(192 * DAY + GRACE_MS);
    const weekSample = byFirst(168 * DAY + GRACE_MS);
    const initialMinutes = initial.map((c) => c.activeMs / 60_000);
    const weekMinutes = weekSample.map((c) => minutes7d.get(c.browserId));
    row.cohortBrowsers = cohort.length;
    row.initialSample = initial.length;
    row.initialMeanMinutes = mean(initialMinutes);
    row.initialMedianMinutes = median(initialMinutes);
    row.d1Denominator = d1Sample.length;
    row.d1Returns = d1Sample.filter((c) => d1.get(c.browserId)).length;
    row.d1 = rate(row.d1Returns, row.d1Denominator);
    row.d7Denominator = d7Sample.length;
    row.d7Returns = d7Sample.filter((c) => d7.get(c.browserId)).length;
    row.d7 = rate(row.d7Returns, row.d7Denominator);
    row.sevenDaySample = weekSample.length;
    row.sevenDayMeanMinutes = mean(weekMinutes);
    row.sevenDayMedianMinutes = median(weekMinutes);
    out.push(row);
  }
  return out.sort((a, b) => a.site.localeCompare(b.site) || a.gameId.localeCompare(b.gameId));
}

function rate(n, d) { return d > 0 ? round4(n / d) : null; }
function mean(list) { return list.length ? round4(list.reduce((a, b) => a + b, 0) / list.length) : null; }
function median(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b), mid = s.length >> 1;
  return round4(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}
function round4(n) { return Math.round(n * 10_000) / 10_000; }
