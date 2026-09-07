// Fetch adapter: for Node frameworks that hand you a Request and want a
// Response back (Next.js route handlers, Hono, SvelteKit, Remix on Node).
// Returns null when the request is not a tally route.
import { createTally } from './index.js';

export function createTallyFetch(opts = {}) {
  const tally = createTally(opts);

  async function fetchHandler(request) {
    const url = new URL(request.url);
    const r = await tally.handle({
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      header: (n) => request.headers.get(n),
      ip: undefined,
      text: async (max) => {
        const t = await request.text();
        return t.length > max ? null : t;
      },
    });
    if (!r) return null;
    if (r.sse) return sseResponse(tally, r.sse.site);
    const empty = r.status === 204 || r.status === 304 || !r.body;
    return new Response(empty ? null : r.body, { status: r.status, headers: r.headers });
  }

  return { ...tally, fetch: fetchHandler };
}

function sseResponse(tally, site) {
  const enc = new TextEncoder();
  let onEvent, ping;
  const stream = new ReadableStream({
    start(ctl) {
      ctl.enqueue(enc.encode(':ok\n\n'));
      onEvent = (row) => { if (!site || row.site === site) ctl.enqueue(enc.encode(`data: ${JSON.stringify(row)}\n\n`)); };
      tally.events.on('event', onEvent);
      ping = setInterval(() => { try { ctl.enqueue(enc.encode(':ping\n\n')); } catch {} }, 25_000);
    },
    cancel() { clearInterval(ping); tally.events.off('event', onEvent); },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}
