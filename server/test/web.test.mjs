import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { createApp } from '../app.mjs';

test('desktop app serves bundled files with a same-origin session, isolated from other sites', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sitenote-static-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<title>Sitenote</title>');
  await writeFile(join(root, 'assets/app-Q7.js'), '/* bundled */');
  const server = createApp({accessToken: 'desktop-tests-secret-value-not-used', webRoot: root});
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise(done => server.close(done));
    await rm(root, {recursive: true, force: true});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const http = (path, opts) => fetch(origin + path, opts);
  const socket = (headers) => {
    const ws = new WebSocket(origin.replace('http','ws') + '/stream', {headers});
    ws.on('error', () => {});
    sockets.push(ws);
    return ws;
  };

  const ready = await (await http('/__sitenote/ready')).json();
  assert.equal(ready.app, 'sitenote-web');
  assert.match(ready.build, /^[a-f0-9]{64}$/);
  const wrongHost = request(origin + '/__sitenote/ready', {headers:{host:'rebinding.invalid'}});
  wrongHost.end();
  const [rejection] = await once(wrongHost, 'response');
  rejection.resume();
  assert.equal(rejection.statusCode, 403);
  assert.equal((await http('/health')).status, 401);
  const landing = await http('/');
  const cookie = landing.headers.get('set-cookie');
  assert.equal(landing.status, 200);
  assert.match(cookie, /^sitenote_session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict$/);
  assert.doesNotMatch(await landing.text(), /desktop-tests-secret/);
  const head = await http('/', {method:'HEAD'});
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const asset = await http('/assets/app-Q7.js');
  assert.match(asset.headers.get('content-type'), /javascript/);
  assert.equal(await asset.text(), '/* bundled */');
  assert.equal((await http('/assets/missing.js')).status, 404);
  assert.equal((await http('/assets/%2E%2E%2Fapp.mjs')).status, 401);

  const Cookie = cookie.split(';')[0];
  assert.equal((await http('/health',{headers:{Cookie}})).status, 200);
  assert.equal((await http('/health',{headers:{Cookie, Origin:'https://another-site.invalid'}})).status, 403);
  assert.equal((await http('/summary',{method:'POST', headers:{Cookie,'Content-Type':'application/json'}, body:'{}'})).status, 401);
  assert.equal((await http('/summary',{method:'POST', headers:{Cookie,Origin:origin,'Content-Type':'application/json'}, body:'{}'})).status, 503);
  const denied = socket({Cookie,Origin:'https://another-site.invalid'});
  const [, response] = await once(denied, 'unexpected-response');
  assert.equal(response.statusCode, 403);
  response.resume();
  assert.ok(await once(socket({Cookie,Origin:origin}), 'open'));
  assert.ok(await once(socket({Authorization:'Bearer desktop-tests-secret-value-not-used'}), 'open'));
});

test('Electron capability protects the bootstrap, API and WebSocket upgrade without replacing origin/cookie checks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sitenote-electron-'));
  await writeFile(join(root, 'index.html'), '<title>Sitenote</title>');
  const accessToken = 'electron-test-bearer-with-32-characters';
  const desktopToken = 'a'.repeat(64);
  const gate = {'X-Sitenote-Desktop':desktopToken};
  const server = createApp({accessToken, webRoot:root, desktopToken});
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    if (server.listening) await new Promise(done => server.close(done));
    await rm(root, {recursive:true, force:true});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const http = (path, headers) => fetch(origin + path, {headers});
  const socket = (headers) => {
    const ws = new WebSocket(origin.replace('http','ws') + '/stream', {headers});
    ws.on('error', () => {});
    sockets.push(ws);
    return ws;
  };
  for (const path of ['/', '/__sitenote/ready', '/health']) {
    assert.equal((await http(path, {})).status, 403);
    assert.equal((await http(path, {'X-Sitenote-Desktop': 'b'.repeat(64), Authorization:'Bearer '+accessToken})).status, 403);
  }
  const landing = await http('/', gate);
  assert.equal(landing.status, 200);
  const Cookie = landing.headers.get('set-cookie').split(';')[0];
  assert.equal((await http('/health', gate)).status, 401);
  assert.equal((await http('/health', {...gate,Cookie})).status, 200);
  assert.equal((await http('/health', {...gate,Cookie,Origin:'https://different.invalid'})).status, 403);
  for (const [headers, status] of [[{Cookie,Origin:origin},403], [{...gate,Cookie,Origin:'https://different.invalid'},403], [{...gate,Origin:origin},401]]) {
    const [, response] = await once(socket(headers), 'unexpected-response');
    assert.equal(response.statusCode, status);
    response.resume();
  }
  assert.ok(await once(socket({...gate,Cookie,Origin:origin}), 'open'));
});
