// SQLite store on node:sqlite. Zero dependencies. One file on a volume.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
`;

export function openSqlite(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('pragma journal_mode = wal; pragma synchronous = normal;');
  db.exec(SCHEMA);

  const q = (sql) => db.prepare(sql);
  const ins = q('insert into events (ts, day, site, name, vid, path, ref, props) values (?,?,?,?,?,?,?,?)');
  const getMeta = q('select v from meta where k = ?');
  const setMeta = q('insert into meta (k, v) values (?, ?) on conflict(k) do update set v = excluded.v');

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

    /** Read meta[k]; if absent, store make() and return it. */
    async meta(k, make) {
      const row = getMeta.get(k);
      if (row) return row.v;
      const v = make();
      setMeta.run(k, v);
      return v;
    },

    async sites(sinceMs) {
      return q(`select site, count(*) events, count(distinct vid) visitors, max(ts) last
                from events where ts >= ? group by site order by visitors desc, events desc`).all(sinceMs);
    },

    async countByName(name, sinceMs) {
      return q(`select site, count(*) c, count(distinct vid) u from events where name=? and ts>=? group by site`).all(name, sinceMs);
    },

    async stats(site, { sinceMs, todayDay, nowMs }) {
      const s = site;
      return {
        daily: q(`select day, name, count(*) c from events where site=? and ts>=? group by day, name`).all(s, sinceMs),
        dailyUniques: q(`select day, count(distinct vid) u from events where site=? and ts>=? group by day`).all(s, sinceMs),
        totals: q(`select name, count(*) c from events where site=? group by name`).all(s),
        allTimeVisitors: q(`select count(distinct vid) u from events where site=?`).get(s)?.u ?? 0,
        firstSeen: q(`select min(ts) t from events where site=?`).get(s)?.t ?? null,
        live5m: q(`select count(distinct vid) u from events where site=? and ts>=?`).get(s, nowMs - 5 * 60_000)?.u ?? 0,
        live1h: q(`select count(*) c from events where site=? and ts>=?`).get(s, nowMs - 3_600_000)?.c ?? 0,
        refs: q(`select ref, count(distinct vid) u from events where site=? and name='pageview' and ts>=? and ref<>'' group by ref order by u desc limit 12`).all(s, sinceMs),
        paths: q(`select path, count(distinct vid) u, count(*) c from events where site=? and name='pageview' and ts>=? group by path order by u desc limit 12`).all(s, sinceMs),
        clicks: q(`select json_extract(props,'$.t') t, count(*) c from events where site=? and name='click' and ts>=? group by t order by c desc limit 15`).all(s, sinceMs),
        errors: q(`select json_extract(props,'$.m') m, count(*) c, max(ts) last from events where site=? and name='error' and ts>=? group by m order by last desc limit 10`).all(s, sinceMs),
        devices: q(`select case when json_extract(props,'$.touch') then 'touch' else 'mouse' end d, count(distinct vid) u from events where site=? and name='pageview' and ts>=? group by d`).all(s, sinceMs),
        engagement: q(`select avg(json_extract(props,'$.s')) avg, count(*) n from events where site=? and name='leave' and ts>=?`).get(s, sinceMs),
        ab: q(`select j.key k, j.value arm, e.name, count(distinct e.vid) u
               from events e, json_each(e.props, '$.ab') j
               where e.site=? and e.ts>=? group by k, arm, e.name`).all(s, sinceMs),
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

    async prune(beforeMs) {
      return q('delete from events where ts < ?').run(beforeMs).changes;
    },

    async close() { db.close(); },
  };
}
