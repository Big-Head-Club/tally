// Set algebra over bounded half-open millisecond intervals. A client reports
// its checkpoint intervals sorted and disjoint; these helpers clip, subtract
// and merge them for ingestion checks and visit arithmetic. Inputs and outputs
// are arrays of [from, to] pairs, sorted and disjoint.

/** Total milliseconds covered by a disjoint list. */
export function covered(intervals) {
  let n = 0;
  for (const [a, b] of intervals) n += b - a;
  return n;
}

/** Merge many interval lists into one disjoint list. */
export function union(lists) {
  const flat = [];
  for (const list of lists) for (const [a, b] of list) if (b > a) flat.push([a, b]);
  flat.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = [];
  for (const [a, b] of flat) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) { if (b > last[1]) last[1] = b; }
    else out.push([a, b]);
  }
  return out;
}

/** The parts of `a` that fall inside any interval of `b`. */
export function intersect(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]), hi = Math.min(a[i][1], b[j][1]);
    if (hi > lo) out.push([lo, hi]);
    if (a[i][1] <= b[j][1]) i++; else j++;
  }
  return out;
}

/** The parts of `a` that fall outside every interval of `b`. */
export function difference(a, b) {
  const out = [];
  let j = 0;
  for (const [x, y] of a) {
    let from = x;
    while (j < b.length && b[j][1] <= from) j++;
    let k = j;
    while (k < b.length && b[k][0] < y) {
      if (b[k][0] > from) out.push([from, b[k][0]]);
      from = Math.max(from, b[k][1]);
      if (from >= y) break;
      k++;
    }
    if (from < y) out.push([from, y]);
  }
  return out;
}
