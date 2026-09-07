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
