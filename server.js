#!/usr/bin/env node
// Standalone collector: one service that any number of sites report to.
// `node server.js`, then add <script defer src="https://THIS-HOST/t.js"> anywhere.
import http from 'node:http';
import { createTally } from './src/index.js';

const port = Number(process.env.PORT) || 8787;
const tally = createTally({
  sites: process.env.TALLY_SITES ? process.env.TALLY_SITES.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  retentionDays: Number(process.env.TALLY_RETENTION_DAYS) || 0,
});

const server = http.createServer(async (req, res) => {
  try {
    if (await tally.handler(req, res)) return;
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    if (req.url === '/' || req.url === '') {
      const host = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta charset="utf-8"><title>tally</title><body style="font:16px/1.6 ui-monospace,monospace;max-width:640px;margin:60px auto;padding:0 20px;color:#333">
<h1 style="font-size:20px">tally is running</h1><p>Add this to any page and it shows up on the dashboard:</p>
<pre style="background:#f4f4f4;padding:12px;overflow:auto">&lt;script defer src="${host}/t.js"&gt;&lt;/script&gt;</pre>
<p>The dashboard address is printed in this service's logs at startup.</p></body>`);
    }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

await tally.ready;
server.listen(port, () => {
  console.log(`tally listening on :${port}`);
  console.log(`dashboard: ${tally.dashboardUrl(process.env.PUBLIC_URL || `http://localhost:${port}`)}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); tally.close().finally(() => process.exit(0)); });
