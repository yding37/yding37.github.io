// Stand-in for the Lambda Function URL, for local testing only.
//   /api            -> the real handler, with Function-URL-shaped events and the CORS
//                      headers the URL config would add
//   everything else -> static files from STATIC_DIR (the test page)
//
// Usage: DDB_ENDPOINT=... TABLE_NAME=... STATIC_DIR=... PORT=9911 node test/local-server.mjs

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { handler } from '../lambda/index.mjs';
import { clock } from '../lambda/util.mjs';

const PORT = Number(process.env.PORT || 9911);
const STATIC_DIR = process.env.STATIC_DIR || process.cwd();
if (process.env.FAKE_NOW) clock.set(Number(process.env.FAKE_NOW));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api' || url.pathname === '/api/') {
    const cors = {
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers': 'content-type',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    let body = '';
    for await (const chunk of req) body += chunk;
    const out = await handler({
      rawPath: '/',
      queryStringParameters: Object.fromEntries(url.searchParams),
      requestContext: { http: { method: req.method, sourceIp: req.headers['x-test-ip'] || req.socket.remoteAddress } },
      body: body || undefined,
      isBase64Encoded: false,
    });
    res.writeHead(out.statusCode, { ...out.headers, ...cors });
    return res.end(out.body);
  }
  const path = normalize(join(STATIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!path.startsWith(STATIC_DIR)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(PORT, () => console.log('local backend on http://127.0.0.1:' + PORT));
