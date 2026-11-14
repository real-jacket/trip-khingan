#!/usr/bin/env node
// Zero-dependency preview server that mimics GitHub Pages: serves site/ under /<repo-dir-name>/ with HTTP Range support (PMTiles needs it).
// usage: node scripts/serve.mjs [--host 127.0.0.1] [--port 4190]
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const site = join(root, 'site');
const base = `/${basename(root)}/`;
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const host = arg('host', '127.0.0.1'), port = Number(arg('port', 4190));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.geojson': 'application/geo+json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.pbf': 'application/x-protobuf', '.pmtiles': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8',
};

const server = createServer((req, res) => {
  const send = (status, body = '', headers = {}) => { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers }); res.end(req.method === 'HEAD' ? undefined : body); };
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed');
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return send(400, 'bad request'); }
  if (path === '/') return send(302, '', { location: base });
  if (path === base.slice(0, -1)) return send(301, '', { location: base });
  if (!path.startsWith(base)) return send(404, 'not found');
  let file = normalize(join(site, path.slice(base.length)));
  if (file !== site && !file.startsWith(site + sep)) return send(403, 'forbidden');
  let stat = statSync(file, { throwIfNoEntry: false });
  if (stat?.isDirectory()) { file = join(file, 'index.html'); stat = statSync(file, { throwIfNoEntry: false }); }
  if (!stat?.isFile()) return send(404, 'not found');

  const headers = { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
  let start = 0, end = stat.size - 1, status = 200;
  const range = req.headers.range;
  if (range) {
    // shortcut: single range only (bytes=a-b | a- | -n), which is all MapLibre/PMTiles send; multi-range falls back to the full file.
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1; }
      else { start = Math.max(stat.size - Number(m[2]), 0); }
      if (start > end || start >= stat.size) return send(416, 'range not satisfiable', { 'content-range': `bytes */${stat.size}` });
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
    }
  }
  headers['content-length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
});

server.listen(port, host, () => console.log(`http://${host}:${port}${base}`));
