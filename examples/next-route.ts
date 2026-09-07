// app/[...tally]/route.ts  — Next.js App Router, Node runtime.
// Handles /t.js, /i and /admin/analytics/<token>; anything else falls through as 404.
import { createTallyFetch } from 'tally/fetch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const tally = createTallyFetch({ tz: 'America/New_York' });
const handle = async (req: Request) => (await tally.fetch(req)) ?? new Response('not found', { status: 404 });

export { handle as GET, handle as POST, handle as OPTIONS };
