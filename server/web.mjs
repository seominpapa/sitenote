import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { webBuild } from './web-build.mjs';

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const asset = /^\/(?:assets\/[a-z0-9_.-]+|favicon\.svg|favicon\.ico)$/i;

export function createLocalWeb(root) {
  const index = readFileSync(join(root, 'index.html'));
  const ready = JSON.stringify({app:'sitenote-web', build:webBuild(index, import.meta.dirname)});
  const key = randomBytes(32);
  const host = (req) => '127.0.0.1:' + req.socket.localPort;
  const origin = (req) => 'http://' + host(req);
  return {
    accepts(req) {
      return req.socket.remoteAddress === '127.0.0.1' && req.headers.host === host(req) &&
        (!req.headers.origin || req.headers.origin === origin(req));
    },
    authenticated(req, upgrade = false) {
      if ((upgrade || req.method === 'POST') && req.headers.origin !== origin(req)) return false;
      const cookie = /(?:^|;\s*)sitenote_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
      return Boolean(cookie && timingSafeEqual(Buffer.from(cookie[1], 'hex'), key));
    },
    async serve(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return false;
      if (req.url === '/__sitenote/ready') {
        res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
        res.end(req.method === 'GET' ? ready : undefined);
        return true;
      }
      const home = req.url === '/';
      const type = home ? types['.html'] : asset.test(req.url) && types[extname(req.url)];
      if (!type) return false;
      const body = home ? index : await readFile(join(root, req.url.slice(1))).catch(() => undefined);
      if (!body) { res.writeHead(404); res.end(); return true; }
      const headers = {
        'Cache-Control': home ? 'no-store' : 'public, max-age=86400',
        'Content-Type': type, 'Content-Length': body.length, 'X-Content-Type-Options': 'nosniff',
      };
      if (home) {
        headers['Set-Cookie'] = 'sitenote_session=' + key.toString('hex') + '; Path=/; HttpOnly; SameSite=Strict';
        headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
          "connect-src 'self' ws://" + host(req) + "; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; img-src 'self' data:";
        headers['Referrer-Policy'] = 'no-referrer';
      }
      res.writeHead(200, headers);
      res.end(req.method === 'GET' ? body : undefined);
      return true;
    },
  };
}
