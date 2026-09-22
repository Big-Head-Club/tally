import { createHash, randomBytes } from 'node:crypto';

/** Sixteen hex chars that identify a visitor for one day and are useless after.
 *  Inputs never get stored; the secret lives in the store's meta table. */
export function visitorId(secret, day, ip, ua, site) {
  return createHash('sha256')
    .update(`${secret}|${day}|${ip}|${ua}|${site}`)
    .digest('hex')
    .slice(0, 16);
}

export function randomToken(bytes = 16) {
  return randomBytes(bytes).toString('hex');
}

/** YYYY-MM-DD for `ms` in `tz`. */
export function dayIn(tz, ms = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

/** Milliseconds at the start of `day` (YYYY-MM-DD) in `tz`. */
export function startOfDay(tz, day) {
  const target = Date.parse(`${day}T00:00:00Z`);
  let ms = target;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  // Two passes settle the zone's offset, including the hour a clock change moves.
  for (let i = 0; i < 2; i++) {
    const [d, t] = fmt.format(new Date(ms)).split(', ');
    ms += target - Date.parse(`${d}T${t.replace('24:', '00:')}Z`);
  }
  return ms;
}

/** The day after `day` (YYYY-MM-DD). */
export function nextDay(day) {
  return new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
