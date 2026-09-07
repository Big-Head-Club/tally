// Plain Node, no framework. Serves ./public and counts everything.
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createTally } from 'tally';

const tally = createTally();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

http.createServer(async (req, res) => {
  if (await tally.handler(req, res)) return;
  let file = join('public', decodeURIComponent(new URL(req.url, 'http://x').pathname));
  try { if (statSync(file).isDirectory()) file = join(file, 'index.html'); statSync(file); }
  catch { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(process.env.PORT || 3000, async () => {
  await tally.ready;
  console.log('dashboard:', tally.dashboardUrl(process.env.PUBLIC_URL || 'http://localhost:3000'));
});
