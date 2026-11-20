const { homedir } = require('node:os');
const { join } = require('node:path');

const host = '127.0.0.1';
const port = 18787;
const origin = 'http://' + host + ':' + port;
const stream = 'ws://' + host + ':' + port + '/stream';
const header = 'X-Sitenote-Desktop';

function parse(raw) {
  try {
    const url = new URL(raw);
    return !url.username && !url.password ? url : undefined;
  } catch {
    return undefined;
  }
}

function ownedPage(raw) {
  const url = parse(raw);
  return url?.protocol === 'http:' && url.origin === origin && url.pathname === '/' && !url.search;
}

function ownedOrigin(value) {
  return value === origin || value === origin + '/';
}

function requestKind(raw) {
  const url = parse(raw);
  if (!url) return;
  if ((url.protocol === 'http:' && url.origin === origin) || url.href === stream) return 'local';
  if (url.protocol === 'blob:' && url.origin === origin) return 'blob';
}

function bindLocalServer(server) {
  return new Promise((resolve, reject) => {
    const done = (error) => {
      server.removeListener('listening', listening);
      server.removeListener('error', done);
      if (error) reject(error);
      else resolve();
    };
    const listening = () => done();
    server.once('listening', listening).once('error', done);
    try { server.listen(port, host); } catch (error) { done(error); }
  });
}

function providerKeysFile() {
  const base = process.platform === 'win32' ? process.env.LOCALAPPDATA || homedir()
    : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : join(homedir(), '.config');
  return join(base, 'Sitenote', 'provider-keys.json');
}

async function configureSession(session, token, getContents, requestMicrophone, microphoneGranted = () => true) {
  await session.setProxy({ mode: 'direct' });
  session.webRequest.onBeforeRequest((details, done) => done({cancel: !requestKind(details.url)}));
  session.webRequest.onBeforeSendHeaders((details, done) => {
    const kind = requestKind(details.url);
    if (!kind) return done({cancel: true});
    if (kind !== 'local') return done({});
    const allowed = Object.fromEntries(Object.entries(details.requestHeaders ?? {})
      .filter(([name]) => name.toLowerCase() !== header.toLowerCase()));
    return done({requestHeaders: {...allowed, [header]: token}});
  });
  const ownedMicrophone = (contents, permission, details) =>
    Boolean(contents && contents === getContents() && permission === 'media'
      && details?.isMainFrame && ownedPage(details.requestingUrl) && ownedPage(contents.getURL())
      && (!details.securityOrigin || ownedOrigin(details.securityOrigin)));
  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    ownedOrigin(requestingOrigin) && ownedMicrophone(contents, permission, details)
      && details.mediaType === 'audio' && microphoneGranted());
  session.setPermissionRequestHandler((contents, permission, done, details) => {
    if (!ownedMicrophone(contents, permission, details)
        || details.mediaTypes?.length !== 1 || details.mediaTypes[0] !== 'audio') return done(false);
    return Promise.resolve().then(requestMicrophone)
      .then((allowed) => done(Boolean(allowed) && ownedMicrophone(contents, permission, details)), () => done(false));
  });
  session.setDisplayMediaRequestHandler?.((_request, done) => done({}));
}

function secureContents(contents) {
  const deny = (event) => event.preventDefault();
  const blockNavigation = (event, legacyUrl, _legacySameDocument, legacyMainFrame) => {
    if (!(event.isMainFrame ?? legacyMainFrame) || !ownedPage(event.url ?? legacyUrl)) deny(event);
  };
  contents.setWindowOpenHandler(() => ({action: 'deny'}));
  contents.on('will-attach-webview', deny);
  contents.on('will-frame-navigate', blockNavigation);
  contents.on('will-redirect', blockNavigation);
}

module.exports = { origin, port, ownedPage, configureSession, secureContents, bindLocalServer, providerKeysFile };
