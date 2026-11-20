import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import WebSocket, { WebSocketServer } from 'ws';
import { handleStream } from './stream.mjs';
import { textResult, validTextRequest } from './text.mjs';
import { createLocalWeb } from './web.mjs';
import { createKeyStore, parseKeys } from './keys.mjs';
import { categoryResult, validCategories } from './categories.mjs';

const digest = (secret) => createHash('sha256').update(secret).digest();
const maxBytes = 200_000;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

function jsonType(req, size) {
  return /^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')
    && !(Number(req.headers['content-length']) > size);
}

export function createApp(config) {
  const { desktopToken, ...serverConfig } = config;
  const web = config.webRoot && createLocalWeb(config.webRoot);
  if (typeof config.accessToken !== 'string' || config.accessToken.length < 32) {
    throw new Error('SITE_ACCESS_TOKEN은 32자 이상이어야 합니다.');
  }
  const hash = digest(config.accessToken);
  const authenticated = (auth) => typeof auth === 'string' && auth.startsWith('Bearer ')
    && timingSafeEqual(digest(auth.slice(7)), hash);
  if (desktopToken !== undefined && (!web || typeof desktopToken !== 'string' || !/^[a-f0-9]{64}$/.test(desktopToken))) {
    throw new Error('앱 전용 로컬 연결 설정을 확인하세요.');
  }
  const desktopHash = desktopToken && digest(desktopToken);
  const desktopAuthenticated = (req) => {
    const header = req.headers['x-sitenote-desktop'];
    return !desktopHash || (typeof header === 'string' && header.length === 64 && timingSafeEqual(digest(header), desktopHash));
  };
  const keyStore = web && config.webKeysFile && createKeyStore(config.webKeysFile);
  const options = {
    ...serverConfig,
    textModel: config.textModel || 'gpt-5.4-mini',
    transport: config.transport || fetch,
    upstream: config.upstream || ((url, options) => new WebSocket(url, options)),
    safetyId: hash.toString('hex'),
    get openaiKey() { return keyStore && keyStore.key('openaiKey') || config.openaiKey; },
    get sonioxKey() { return keyStore && keyStore.key('sonioxKey') || config.sonioxKey; },
  };
  const health = () => ({ ok: true, providers: { live: Boolean(options.openaiKey), soniox: Boolean(options.sonioxKey), text: Boolean(options.openaiKey) } });
  const limits = new Map();
  const allow = (key, cap) => {
    const now = Date.now();
    const hits = (limits.get(key) || []).filter((time) => now - time < 60_000);
    if (hits.length >= cap) return false;
    limits.set(key, [...hits, now]);
    return true;
  };

  const streams = new WebSocketServer({ noServer: true, maxPayload: 200_000, perMessageDeflate: false });
  let textPending = 0;
  const handler = async (req, res) => {
    if (!desktopAuthenticated(req) || (web && !web.accepts(req))) {
      return json(res, 403, {error: '노트북의 로컬 웹 주소에서 실행해 주세요.'});
    }
    if (web && await web.serve(req, res)) return;
    if (req.method === 'POST' && req.url === '/settings/keys' && keyStore) {
      if (!web.authenticated(req)) return json(res, 401, { error: '로컬 앱을 새로 열어 다시 시도하세요.' });
      if (!allow('settings', 10)) return json(res, 429, { error: '요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.' });
      const size = 4096;
      const changes = jsonType(req, size) && parseKeys(await readJson(req, size).catch(() => null));
      if (!changes) return json(res, 400, { error: 'API 키 형식이나 길이를 확인하세요.' });
      try {
        await keyStore.save(changes);
        return json(res, 200, health());
      } catch {
        return json(res, 500, { error: 'API 키를 서버에 저장하지 못했습니다.' });
      }
    }
    if (!authenticated(req.headers.authorization) && !web?.authenticated(req)) {
      return json(res, 401, { error: '앱 접근 토큰을 확인하세요.' });
    }
    if (!allow('http', 80)) return json(res, 429, { error: '요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.' });
    const path = req.url;
    if (req.method === 'GET' && path === '/health') return json(res, 200, health());
    if (req.method !== 'POST' || !['/summary', '/answer', '/categories'].includes(path)) return json(res, 404, { error: '요청을 찾을 수 없습니다.' });
    const categories = path === '/categories';
    const size = categories ? 110_000 : maxBytes;
    if (!jsonType(req, size)) return json(res, 400, { error: 'JSON 요청 형식 또는 크기를 확인하세요.' });
    if (!options.openaiKey) return json(res, 503, { error: '서버에 OpenAI API 키가 없습니다.' });
    const data = await readJson(req, size).catch(() => null);
    if (!(categories ? validCategories(data) : validTextRequest(path, data))) return json(res, 400, { error: '요청 항목 또는 길이를 확인하세요.' });
    if (textPending >= 2 || !allow('text', 24) || (categories && !allow('categories', 10))) return json(res, 429, { error: '조금 뒤에 다시 분석해 주세요.' });
    textPending++;
    try {
      return json(res, 200, categories ? await categoryResult(data, options) : await textResult(path, data, options));
    } catch {
      return json(res, 502, { error: '텍스트 처리에 실패했습니다. 모델 권한과 서버 연결을 확인하세요.' });
    } finally {
      textPending--;
    }
  };

  const settings = { requestTimeout: 20_000, headersTimeout: 10_000, maxHeaderSize: 8_192 };
  const server = config.tls ? createSecureServer({ ...settings, ...config.tls }, handler) : createServer(settings, handler);
  server.on('upgrade', (req, socket, head) => {
    const status = !desktopAuthenticated(req) ? '403 Forbidden'
      : req.url !== '/stream' ? '404 Not Found'
      : web && !web.accepts(req) ? '403 Forbidden'
      : !authenticated(req.headers.authorization) && !web?.authenticated(req, true) ? '401 Unauthorized'
      : (streams.clients.size >= 2 || !allow('stream', 30)) ? '429 Too Many Requests' : null;
    if (status) return socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    streams.handleUpgrade(req, socket, head, (ws) => handleStream(ws, options, Boolean(web?.authenticated(req, true))));
  });
  const ping = setInterval(() => {
    for (const ws of streams.clients) {
      if (ws.alive === false) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, 30_000).unref();
  server.on('close', () => { clearInterval(ping); streams.close(); });
  return server;
}
