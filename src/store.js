// SQLite store on node:sqlite. Zero dependencies. One file on a volume.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { checkProgress } from './measurement.js';

const SCHEMA = `
create table if not exists events (
  id    integer primary key,
  ts    integer not null,
  day   text    not null,
  site  text    not null,
  name  text    not null,
  vid   text    not null,
  path  text,
  ref   text,
  props text
);
create index if not exists events_site_ts       on events(site, ts);
create index if not exists events_site_name_day on events(site, name, day);
create table if not exists meta (k text primary key, v text not null);
create table if not exists measurement_streams (
  id            text primary key,
  browser_id    text    not null,
  persistent    integer not null,
  site          text    not null,
  game_id       text    not null,
  version       integer not null check (version = 1),
  build         text,
  started_at    integer not null,
  received_at   integer not null,
  sequence      integer not null default 0 check (sequence >= 0),
  elapsed_ms    integer not null default 0 check (elapsed_ms between 0 and 600000),
  intervals     text    not null default '[]',
  actions       integer not null default 0 check (actions >= 0),
  first_action_ms integer,
  last_action_ms  integer,
  state         text    not null default 'idle' check (state in ('idle', 'playing', 'paused', 'hidden', 'closed'))
);
create index if not exists measurement_site_started on measurement_streams(site, started_at);
`;

// A visitor was really there if they clicked or stayed ten seconds. A 'start' does
// not count: several games fire one on page load, so a crawler earns one for free.
const ENGAGED_SQLITE = `(name='click' or (name='leave' and json_extract(props,'$.s') >= 10))`;

export function openSqlite(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('pragma journal_mode = wal; pragma synchronous = normal;');
  db.exec(SCHEMA);

  const q = (sql) => db.prepare(sql);
  const ins = q('insert into events (ts, day, site, name, vid, path, ref, props) values (?,?,?,?,?,?,?,?)');
  const getMeta = q('select v from meta where k = ?');
  const setMeta = q('insert into meta (k, v) values (?, ?) on conflict(k) do update set v = excluded.v');
  const openStream = q(`insert into measurement_streams
    (id, browser_id, persistent, site, game_id, version, build, started_at, received_at)
    values (?,?,?,?,?,1,?,?,?)`);
  const getStream = q(`select id, browser_id, persistent, site, game_id, build, started_at, sequence,
    elapsed_ms, intervals, actions, first_action_ms, last_action_ms, state from measurement_streams where id = ?`);
  const saveStream = q(`update measurement_streams set sequence = ?, elapsed_ms = ?, intervals = ?,
    actions = ?, first_action_ms = ?, last_action_ms = ?, state = ?, received_at = ? where id = ?`);

  return {
    kind: 'sqlite',
    file,

    async insert(rows) {
      db.exec('begin');
      try {
        for (const r of rows) ins.run(r.ts, r.day, r.site, r.name, r.vid, r.path, r.ref, r.props);
        db.exec('commit');
      } catch (e) { db.exec('rollback'); throw e; }
    },

    /**
     * Commit one cumulative measurement checkpoint. The stream row is anchored
     * on this server's clock at open; every later report must extend it
     * monotonically (see checkProgress) or the write is refused with a short
     * reason: retries, races and lost reports are fine, rewrites are not.
     */
    async measurement(e) {
      const refuse = (reason, status) => { throw Object.assign(new Error(`tally: ${reason}`), { status, reason }); };
      const now = Date.now();
      let stored = null;
      db.exec('begin');
      try {
        if (e.sequence === 0) openStream.run(e.streamId, e.browserId, e.persistent ? 1 : 0, e.site, e.gameId, e.build, now, now);
        const row = getStream.get(e.streamId);
        if (!row) refuse('open_required', 409);
        if (row.browser_id !== e.browserId || row.site !== e.site || row.game_id !== e.gameId ||
            row.build !== e.build || (row.persistent !== 0) !== e.persistent) refuse('stream_binding', 409);
        stored = { sequence: row.sequence, elapsedMs: row.elapsed_ms, intervals: JSON.parse(row.intervals),
          actions: row.actions, firstActionMs: row.first_action_ms, lastActionMs: row.last_action_ms, state: row.state };
        const reason = checkProgress(stored, e, now - row.started_at);
        if (reason) refuse(reason, 409);
        if (e.sequence > stored.sequence) {
          saveStream.run(e.sequence, e.elapsedMs, JSON.stringify(e.intervals), e.actions,
            e.firstActionMs, e.lastActionMs, e.state, now, e.streamId);
        }
        db.exec('commit');
      } catch (err) {
        try { db.exec('rollback'); } catch {}
        throw err;
      }
      return { ok: true, sequence: Math.max(e.sequence, stored.sequence) };
    },

    /** Every stored stream for one site (or all sites), oldest first. */
    async measurementStreams(site) {
      const rows = site
        ? q('select * from measurement_streams where site = ? order by started_at, id').all(site)
        : q('select * from measurement_streams order by started_at, id').all();
      return rows.map((r) => ({ id: r.id, browserId: r.browser_id, persistent: r.persistent !== 0,
        site: r.site, gameId: r.game_id, version: r.version, startedAt: r.started_at,
        elapsedMs: r.elapsed_ms, intervals: JSON.parse(r.intervals), actions: r.actions,
        firstActionMs: r.first_action_ms, lastActionMs: r.last_action_ms, state: r.state }));
    },

    /** Read meta[k]; if absent, store make() and return it. */
    async meta(k, make) {
      const row = getMeta.get(k);
      if (row) return row.v;
      const v = make();
      setMeta.run(k, v);
      return v;
    },

    async sites(sinceMs, untilMs = Infinity) {
      const u = Number.isFinite(untilMs) ? untilMs : 8.64e15;
      return q(`select site, count(*) events, count(distinct vid) visitors, max(ts) last
                from events where ts >= ? and ts < ? group by site order by visitors desc, events desc`).all(sinceMs, u);
    },

    async engagedSites(sinceMs) {
      return q(`select site, count(distinct vid) engaged from events
                where ts>=? and ${ENGAGED_SQLITE}
                group by site`).all(sinceMs);
    },

    /** Events of one name, counted only from visitors who showed they were there. */
    async engagedCountByName(name, sinceMs) {
      return q(`select e.site, count(*) c, count(distinct e.vid) u from events e
                where e.name=? and e.ts>=? and exists (
                  select 1 from events x where x.site=e.site and x.vid=e.vid and x.ts>=? and ${ENGAGED_SQLITE.replace(/\b(name|props)\b/g, 'x.$1')})
                group by e.site`).all(name, sinceMs, sinceMs);
    },

    async countByName(name, sinceMs) {
      return q(`select site, count(*) c, count(distinct vid) u from events where name=? and ts>=? group by site`).all(name, sinceMs);
    },

    async stats(site, { sinceMs, untilMs = Infinity, todayDay, nowMs }) {
      const s = site;
      const u = Number.isFinite(untilMs) ? untilMs : 8.64e15;   // the end of the window, exclusive
      return {
        daily: q(`select day, name, count(*) c from events where site=? and ts>=? and ts<? group by day, name`).all(s, sinceMs, u),
        dailyUniques: q(`select day, count(distinct vid) u from events where site=? and ts>=? and ts<? group by day`).all(s, sinceMs, u),
        totals: q(`select name, count(*) c from events where site=? and ts>=? and ts<? group by name`).all(s, sinceMs, u),
        rangeVisitors: q(`select count(distinct vid) u from events where site=? and ts>=? and ts<?`).get(s, sinceMs, u)?.u ?? 0,
        rangePageviews: q(`select count(*) c from events where site=? and name='pageview' and ts>=? and ts<?`).get(s, sinceMs, u)?.c ?? 0,
        allTimeVisitors: q(`select count(distinct vid) u from events where site=?`).get(s)?.u ?? 0,
        firstSeen: q(`select min(ts) t from events where site=?`).get(s)?.t ?? null,
        live5m: q(`select count(distinct vid) u from events where site=? and ts>=?`).get(s, nowMs - 5 * 60_000)?.u ?? 0,
        live1h: q(`select count(*) c from events where site=? and ts>=?`).get(s, nowMs - 3_600_000)?.c ?? 0,
        refs: q(`select ref, count(distinct vid) u from events where site=? and name='pageview' and ts>=? and ts<? and ref<>'' group by ref order by u desc limit 12`).all(s, sinceMs, u),
        paths: q(`select path, count(distinct vid) u, count(*) c from events where site=? and name='pageview' and ts>=? and ts<? group by path order by u desc limit 12`).all(s, sinceMs, u),
        clicks: q(`select json_extract(props,'$.t') t, count(*) c from events where site=? and name='click' and ts>=? and ts<? group by t order by c desc limit 15`).all(s, sinceMs, u),
        errors: q(`select json_extract(props,'$.m') m, count(*) c, max(ts) last from events where site=? and name='error' and ts>=? and ts<? group by m order by last desc limit 10`).all(s, sinceMs, u),
        devices: q(`select case when json_extract(props,'$.touch') then 'touch' else 'mouse' end d, count(distinct vid) u from events where site=? and name='pageview' and ts>=? and ts<? group by d`).all(s, sinceMs, u),
        engagement: q(`select avg(json_extract(props,'$.s')) avg, count(*) n from events where site=? and name='leave' and ts>=? and ts<?`).get(s, sinceMs, u),
        ab: q(`select j.key k, j.value arm, e.name, count(distinct e.vid) u
               from events e, json_each(e.props, '$.ab') j
               where e.site=? and e.ts>=? and e.ts<? group by k, arm, e.name`).all(s, sinceMs, u),
        recent: q(`select ts, name, vid, path, ref, props from events where site=? order by id desc limit 30`).all(s),
        today: q(`select count(*) c, count(distinct vid) u from events where site=? and day=? and name='pageview'`).get(s, todayDay),
      };
    },

    /** Yield rows for export, oldest first. */
    async *export(site) {
      const stmt = site
        ? q('select ts, day, site, name, vid, path, ref, props from events where site=? order by id')
        : q('select ts, day, site, name, vid, path, ref, props from events order by id');
      for (const row of site ? stmt.iterate(site) : stmt.iterate()) yield row;
    },

    /** Rows since a time, optionally one site and some event names, oldest first. */
    async range(site, { sinceMs, names = [], limit }) {
      const where = ['ts >= ?'];
      const args = [sinceMs];
      if (site) { where.push('site = ?'); args.push(site); }
      if (names.length) { where.push(`name in (${names.map(() => '?').join(',')})`); args.push(...names); }
      return q(`select ts, day, site, name, vid, path, ref, props from events where ${where.join(' and ')} order by id limit ?`).all(...args, limit);
    },

    async prune(beforeMs) {
      const events = q('delete from events where ts < ?').run(beforeMs).changes;
      const streams = q('delete from measurement_streams where received_at < ?').run(beforeMs).changes;
      return events + streams;
    },

    async close() { db.close(); },
  };
}
