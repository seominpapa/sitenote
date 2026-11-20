import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.mjs';

const {
  SITE_PORT = '8787', SITE_HOST = '127.0.0.1', SITE_ACCESS_TOKEN,
  SITE_TLS_CERT, SITE_TLS_KEY, OPENAI_API_KEY, OPENAI_TEXT_MODEL, SONIOX_API_KEY, SITE_WEB_ROOT,
} = process.env;

const port = Number(SITE_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error('SITE_PORT는 1024–65535 사이여야 합니다.');
if (Boolean(SITE_TLS_CERT) !== Boolean(SITE_TLS_KEY)) throw new Error('SITE_TLS_CERT와 SITE_TLS_KEY를 함께 설정하세요.');
const tls = SITE_TLS_CERT ? { cert: readFileSync(SITE_TLS_CERT), key: readFileSync(SITE_TLS_KEY) } : undefined;
if (SITE_WEB_ROOT && (SITE_HOST !== '127.0.0.1' || tls)) {
  throw new Error('노트북 웹앱은 http://127.0.0.1에서만 실행할 수 있습니다.');
}
if (!tls && !['127.0.0.1', '::1'].includes(SITE_HOST)) throw new Error('로컬 루프백 밖에서 접속하려면 서버 TLS를 설정하세요.');
const userConfig = process.platform === 'win32' ? (process.env.LOCALAPPDATA || homedir())
  : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
  : join(homedir(), '.config');
const server = createApp({
  accessToken: SITE_ACCESS_TOKEN || (SITE_WEB_ROOT ? randomBytes(32).toString('hex') : undefined), tls,
  webRoot: SITE_WEB_ROOT,
  webKeysFile: SITE_WEB_ROOT ? join(userConfig, 'Sitenote', 'provider-keys.json') : undefined,
  openaiKey: OPENAI_API_KEY, sonioxKey: SONIOX_API_KEY, textModel: OPENAI_TEXT_MODEL,
});
server.listen(port, SITE_HOST, () => console.log('Sitenote: ' + (tls ? 'https://' : 'http://') + SITE_HOST + ':' + port));
