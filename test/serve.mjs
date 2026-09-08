// Yerel gelistirme sunucusu: node test/serve.mjs [port]
// Yayindaki dizin duzenini birebir taklit eder — web/ kok, engine/ altinda.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const ENGINE = join(ROOT, 'engine');
const PORT = Number(process.argv[2] ?? 8787);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gpx': 'application/gpx+xml',
};

function resolve(pathname) {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  if (clean === '/' || clean === '\\') return join(WEB, 'index.html');
  if (clean.startsWith('/engine/') || clean.startsWith('\\engine\\')) {
    return join(ENGINE, clean.slice(8));
  }
  return join(WEB, clean);
}

createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const file = resolve(url.pathname);
  try {
    const info = await stat(file);
    const target = info.isDirectory() ? join(file, 'index.html') : file;
    const body = await readFile(target);
    response.writeHead(200, {
      'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      // Yayinda GitHub Pages ayni izolasyonu vermez; burada yalnizca gelistirme kolayligi.
      'access-control-allow-origin': '*',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Bulunamadi: ' + url.pathname);
  }
}).listen(PORT, () => {
  console.log(`DenizRota gelistirme sunucusu: http://localhost:${PORT}/`);
  console.log('Durdurmak icin Ctrl+C.');
});
