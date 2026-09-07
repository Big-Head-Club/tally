import express from 'express';
import { createTally } from 'tally';

const app = express();
const tally = createTally({ tz: 'America/New_York' });
app.use(tally.middleware);
app.use(express.static('public'));

app.post('/buy', async (req, res) => {
  // tie a server-side event to the same visitor the browser events use
  await tally.track('purchase', { cents: 500 }, { vid: await tally.visitor(req) });
  res.json({ ok: true });
});

app.listen(3000, async () => {
  await tally.ready;
  console.log('dashboard:', tally.dashboardUrl('http://localhost:3000'));
});
