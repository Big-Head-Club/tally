// Postgres store, same interface as store.js. For hosts without a volume:
// set DATABASE_URL (Neon, Railway Postgres, Supabase) and `npm i pg`.
export async function openPg(url) {
  let pg;
  try { pg = await import('pg'); } catch { throw new Error('tally: DATABASE_URL is set but the "pg" package is not installed. Run: npm i pg'); }
  const { Pool } = pg.default ?? pg;
  const pool = new Pool({ connectionString: url, max: 4, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false } });
  await pool.query(`
    create table if not exists tally_events (
      id bigserial primary key, ts bigint not null, day text not null, site text not null,
      name text not null, vid text not null, path text, ref text, props jsonb);
    create index if not exists tally_events_site_ts on tally_events(site, ts);
    create index if not exists tally_events_site_name_day on tally_events(site, name, day);
    create table if not exists tally_meta (k text primary key, v text not null);`);
  const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const num = (rows) => rows.map((r) => { for (const k in r) if (typeof r[k] === 'string' && /^(c|u|n|t|last|avg|events|visitors)$/.test(k) && r[k] !== '' && !isNaN(r[k])) r[k] = Number(r[k]); return r; });

  return {
    kind: 'pg',
    async insert(rows) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        for (const r of rows) await client.query('insert into tally_events (ts, day, site, name, vid, path, ref, props) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [r.ts, r.day, r.site, r.name, r.vid, r.path, r.ref, r.props]);
        await client.query('commit');
      } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
    },
    async meta(k, make) {
      const got = await q('select v from tally_meta where k=$1', [k]);
      if (got.length) return got[0].v;
      await q('insert into tally_meta (k, v) values ($1, $2) on conflict (k) do nothing', [k, make()]);
      return (await q('select v from tally_meta where k=$1', [k]))[0].v;
    },
    async sites(sinceMs, untilMs = Infinity) {
      const u = Number.isFinite(untilMs) ? untilMs : 8.64e15;
      return num(await q('select site, count(*) events, count(distinct vid) visitors, max(ts) last from tally_events where ts >= $1 and ts < $2 group by site order by visitors desc, events desc', [sinceMs, u]));
    },
    async engagedSites(sinceMs) {
      return num(await q(`select site, count(distinct vid) engaged from tally_events
        where ts>=$1 and (name='click' or (name='leave' and (props->>'s')::numeric >= 10)) group by site`, [sinceMs]));
    },

    async engagedCountByName(name, sinceMs) {
      return num(await q(`select e.site, count(*) c, count(distinct e.vid) u from tally_events e
        where e.name=$1 and e.ts>=$2 and exists (
          select 1 from tally_events x where x.site=e.site and x.vid=e.vid and x.ts>=$2
            and (x.name='click' or (x.name='leave' and (x.props->>'s')::numeric >= 10)))
        group by e.site`, [name, sinceMs]));
    },
    async countByName(name, sinceMs) {
      return num(await q('select site, count(*) c, count(distinct vid) u from tally_events where name=$1 and ts>=$2 group by site', [name, sinceMs]));
    },
    async stats(s, { sinceMs, untilMs = Infinity, todayDay, nowMs }) {
      const one = (rows) => num(rows)[0];
      const u = Number.isFinite(untilMs) ? untilMs : 8.64e15;   // the end of the window, exclusive
      return {
        daily: num(await q('select day, name, count(*) c from tally_events where site=$1 and ts>=$2 and ts<$3 group by day, name', [s, sinceMs, u])),
        dailyUniques: num(await q('select day, count(distinct vid) u from tally_events where site=$1 and ts>=$2 and ts<$3 group by day', [s, sinceMs, u])),
        totals: num(await q('select name, count(*) c from tally_events where site=$1 and ts>=$2 and ts<$3 group by name', [s, sinceMs, u])),
        rangeVisitors: one(await q('select count(distinct vid) u from tally_events where site=$1 and ts>=$2 and ts<$3', [s, sinceMs, u]))?.u ?? 0,
        rangePageviews: one(await q(`select count(*) c from tally_events where site=$1 and name='pageview' and ts>=$2 and ts<$3`, [s, sinceMs, u]))?.c ?? 0,
        allTimeVisitors: one(await q('select count(distinct vid) u from tally_events where site=$1', [s]))?.u ?? 0,
        firstSeen: one(await q('select min(ts) t from tally_events where site=$1', [s]))?.t ?? null,
        live5m: one(await q('select count(distinct vid) u from tally_events where site=$1 and ts>=$2', [s, nowMs - 300_000]))?.u ?? 0,
        live1h: one(await q('select count(*) c from tally_events where site=$1 and ts>=$2', [s, nowMs - 3_600_000]))?.c ?? 0,
        refs: num(await q(`select ref, count(distinct vid) u from tally_events where site=$1 and name='pageview' and ts>=$2 and ts<$3 and ref<>'' group by ref order by u desc limit 12`, [s, sinceMs, u])),
        paths: num(await q(`select path, count(distinct vid) u, count(*) c from tally_events where site=$1 and name='pageview' and ts>=$2 and ts<$3 group by path order by u desc limit 12`, [s, sinceMs, u])),
        clicks: num(await q(`select props->>'t' t, count(*) c from tally_events where site=$1 and name='click' and ts>=$2 and ts<$3 group by 1 order by c desc limit 15`, [s, sinceMs, u])),
        errors: num(await q(`select props->>'m' m, count(*) c, max(ts) last from tally_events where site=$1 and name='error' and ts>=$2 and ts<$3 group by 1 order by last desc limit 10`, [s, sinceMs, u])),
        devices: num(await q(`select case when coalesce((props->>'touch')::boolean,false) then 'touch' else 'mouse' end d, count(distinct vid) u from tally_events where site=$1 and name='pageview' and ts>=$2 and ts<$3 group by 1`, [s, sinceMs, u])),
        engagement: one(await q(`select avg((props->>'s')::numeric) avg, count(*) n from tally_events where site=$1 and name='leave' and ts>=$2 and ts<$3`, [s, sinceMs, u])),
        ab: num(await q(`select j.key k, j.value arm, e.name, count(distinct e.vid) u from tally_events e, jsonb_each_text(e.props->'ab') j where e.site=$1 and e.ts>=$2 and e.ts<$3 group by 1,2,3`, [s, sinceMs, u])),
        recent: num(await q('select ts, name, vid, path, ref, props from tally_events where site=$1 order by id desc limit 30', [s])),
        today: one(await q(`select count(*) c, count(distinct vid) u from tally_events where site=$1 and day=$2 and name='pageview'`, [s, todayDay])),
      };
    },
    async *export(site) {
      let last = 0;
      for (;;) {
        const rows = site
          ? await q('select id, ts, day, site, name, vid, path, ref, props from tally_events where site=$1 and id>$2 order by id limit 5000', [site, last])
          : await q('select id, ts, day, site, name, vid, path, ref, props from tally_events where id>$1 order by id limit 5000', [last]);
        if (!rows.length) return;
        for (const r of rows) { last = r.id; const { id, ...rest } = r; yield rest; }
      }
    },
    async range(site, { sinceMs, names = [], limit }) {
      const args = [sinceMs];
      const where = ['ts >= $1'];
      if (site) { args.push(site); where.push(`site = $${args.length}`); }
      if (names.length) { args.push(names); where.push(`name = any($${args.length})`); }
      args.push(limit);
      const rows = await q(`select ts, day, site, name, vid, path, ref, props from tally_events where ${where.join(' and ')} order by id limit $${args.length}`, args);
      return rows.map((r) => ({ ...r, ts: Number(r.ts) }));
    },
    async prune(beforeMs) { return (await pool.query('delete from tally_events where ts < $1', [beforeMs])).rowCount; },
    async close() { await pool.end(); },
  };
}
