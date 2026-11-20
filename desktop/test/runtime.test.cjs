const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { configureSession, secureContents, origin, bindLocalServer } = require('../runtime.cjs');

test('desktop Chromium sends its capability only to its own app and stream', async () => {
  const hooks = {};
  const contents = { getURL: () => origin + '/' };
  const session = {
    webRequest: {
      onBeforeRequest: (fn) => { hooks.before = fn; },
      onBeforeSendHeaders: (fn) => { hooks.headers = fn; },
    },
    async setProxy(value) { hooks.proxy = value; },
    setPermissionCheckHandler(fn) { hooks.check = fn; },
    setPermissionRequestHandler(fn) { hooks.request = fn; },
  };
  await configureSession(session, 'private', () => contents, async () => true);
  assert.deepEqual(hooks.proxy, { mode: 'direct' });
  const run = (fn, url, requestHeaders = {}) => {
    let result;
    fn({ url, requestHeaders }, (value) => { result = value; });
    return result;
  };
  const stream = origin.replace('http:', 'ws:') + '/stream';
  const expected = {'Set-Copy': 'keep', 'X-Sitenote-Desktop': 'private'};
  for (const url of [origin + '/', origin + '/assets/app.js', stream]) {
    assert.deepEqual(run(hooks.before, url), { cancel: false });
    assert.deepEqual(run(hooks.headers, url, {'Set-Copy':'keep', 'x-SITENOTE-desktop':'forged'}), {requestHeaders: expected});
  }
  assert.deepEqual(run(hooks.before, 'blob:' + origin + '/export'), { cancel: false });
  for (const url of ['https://elsewhere.invalid/', origin.replace('127.0.0.1','localhost'), stream + '?other', stream.replace('/stream','/other'), origin.replace('//','//person@'), 'blob:https://elsewhere.invalid/export']) {
    assert.deepEqual(run(hooks.before, url), {cancel: true});
    assert.deepEqual(run(hooks.headers, url), {cancel: true});
  }
  const check = { isMainFrame: true, mediaType: 'audio', requestingUrl: origin + '/' };
  assert.equal(hooks.check(contents, 'media', origin, check), true);
  assert.equal(hooks.check(contents, 'media', origin + '/', {...check, securityOrigin: origin + '/'}), true);
  assert.equal(hooks.check(contents, 'media', origin, {...check, mediaType:'video'}), false);
  assert.equal(hooks.check(contents, 'media', origin, {...check, isMainFrame:false}), false);
  assert.equal(hooks.check(contents, 'media', 'https://elsewhere.invalid', check), false);
  assert.equal(hooks.check({}, 'media', origin, check), false);
  const request = (permission, details) => new Promise(done => hooks.request(contents, permission, done, details));
  const audio = { isMainFrame: true, mediaTypes: ['audio'], requestingUrl: origin + '/' };
  assert.equal(await request('media', audio), true);
  assert.equal(await request('media', {...audio, securityOrigin:origin + '/'}), true);
  assert.equal(await request('media', {...audio, securityOrigin:origin + '/subframe'}), false);
  assert.equal(await request('media', {...audio, securityOrigin:'https://elsewhere.invalid/'}), false);
  assert.equal(await request('media', {...audio, mediaTypes: ['audio','video']}), false);
  assert.equal(await request('media', {...audio, requestingUrl:'https://elsewhere.invalid'}), false);
  assert.equal(await request('display-capture', audio), false);
});

test('desktop denies popups, webviews, frames and off-app navigation', () => {
  const wc = new EventEmitter();
  wc.setWindowOpenHandler = (fn) => { wc.open = fn; };
  secureContents(wc);
  const blocked = (name, url, isMainFrame) => {
    let prevented = false;
    wc.emit(name, {url, isMainFrame, preventDefault: () => { prevented = true; }});
    return prevented;
  };
  assert.deepEqual(wc.open({url: origin + '/'}), {action:'deny'});
  assert.equal(blocked('will-frame-navigate', origin + '/#project', true), false);
  assert.equal(blocked('will-frame-navigate', origin + '/', false), true);
  assert.equal(blocked('will-frame-navigate', origin + '/assets/app.js', true), true);
  assert.equal(blocked('will-redirect', 'https://elsewhere.invalid', true), true);
  assert.equal(blocked('will-attach-webview', origin + '/', true), true);
});

test('server binds only the fixed loopback port and never adopts an existing process', async () => {
  for (const failure of [null, Object.assign(new Error('in use'), {code: 'EADDRINUSE'})]) {
    const server = new EventEmitter();
    server.listen = (port, host) => {
      assert.equal(port, 18787);
      assert.equal(host, '127.0.0.1');
      queueMicrotask(() => failure ? server.emit('error', failure) : server.emit('listening'));
    };
    if (failure) await assert.rejects(bindLocalServer(server), {code: 'EADDRINUSE'});
    else await bindLocalServer(server);
    assert.equal(server.listenerCount('listening'), 0);
    assert.equal(server.listenerCount('error'), 0);
  }
});
