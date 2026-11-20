import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../app.mjs';

const accessToken = 'local-dev-settings-test-token-with-32-characters';
const configured = {ok: true, providers: {live: true, text: true, soniox: true}};
const empty = {ok: true, providers: {live: false, text: false, soniox: false}};
const openaiKey = 'sk-test-openai-fixture';
const sonioxKey = 'soniox-mock-key';

async function settingsFixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'sitenote-keys-'));
  const webKeysFile = join(home, 'user-config', 'provider-keys.json');
  await writeFile(join(home, 'index.html'), '<title>Sitenote</title>');
  const servers = [];
  t.after(async () => {
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
    await rm(home, {recursive:true, force:true});
  });
  return {
    webKeysFile,
    async launch(config) {
      const server = createApp({accessToken, webRoot: home, webKeysFile, ...config});
      servers.push(server);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const Origin = 'http://127.0.0.1:' + server.address().port;
      const http = (path, options) => fetch(Origin + path, options);
      const cookie = (await http('/')).headers.get('set-cookie')?.split(';')[0];
      const post = (path, body, headers = {Cookie: cookie, Origin}) => http(path, {
        method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body: JSON.stringify(body),
      });
      return {http, post, write: (body, headers) => post('/settings/keys', body, headers), Origin, cookie};
    },
  };
}

test('only the local same-origin web session can configure providers', async (t) => {
  const fixture = await settingsFixture(t);
  const browser = await fixture.launch();
  const { Origin, cookie: Cookie } = browser;
  assert.equal((await browser.write({openaiKey}, {Authorization: 'Bearer ' + accessToken, Origin})).status, 401);
  assert.equal((await browser.write({openaiKey}, {Cookie})).status, 401);
  assert.equal((await browser.write({openaiKey}, {Cookie, Origin: 'http://evil.invalid'})).status, 403);
  assert.equal((await browser.write({openaiKey}, {Cookie: 'sitenote_session=bad', Origin})).status, 401);
  await assert.rejects(stat(fixture.webKeysFile), {code:'ENOENT'});

  const native = await fixture.launch({webRoot: undefined});
  assert.equal((await native.write({openaiKey}, {Authorization: 'Bearer ' + accessToken})).status, 404);
  assert.deepEqual(await (await native.http('/health', {headers:{Authorization:'Bearer ' + accessToken}})).json(), empty);
});

test('saved keys remain private, apply immediately, and restore on restart', async (t) => {
  const fixture = await settingsFixture(t);
  const mock = async (_url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer ' + openaiKey);
    return new Response(JSON.stringify({status:'completed', output:[{type:'message',content:[{type:'output_text',text:'yes'}]}]}));
  };
  const app = await fixture.launch({sonioxKey: 'env-fallback', transport: mock});
  const result = await app.write({openaiKey: ' ' + openaiKey + ' ', sonioxKey: ' '});
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'),'no-store');
  const masked = await result.text();
  assert.doesNotMatch(masked, /sk-test|env-fallback/);
  assert.deepEqual(JSON.parse(masked), configured);
  if (process.platform !== 'win32') {
    assert.equal((await stat(fixture.webKeysFile)).mode & 0o777, 0o600);
    assert.equal((await stat(join(fixture.webKeysFile, '..'))).mode & 0o777, 0o700);
  }
  assert.deepEqual(JSON.parse(await readFile(fixture.webKeysFile, 'utf8')), {openaiKey});
  assert.deepEqual(await (await app.post('/answer', {question:'test', context:''})).json(), {answer:'yes'});
  assert.deepEqual(await (await app.write({sonioxKey})).json(), configured);
  assert.deepEqual(await (await app.write({openaiKey:'  '})).json(), configured);
  assert.deepEqual(JSON.parse(await readFile(fixture.webKeysFile, 'utf8')), {openaiKey, sonioxKey});
  assert.equal((await app.http('/provider-keys.json', {headers:{Cookie:app.cookie}})).status, 404);

  const restarted = await fixture.launch({openaiKey: 'env-openai', transport: mock});
  assert.deepEqual(await (await restarted.http('/health', {headers:{Cookie: restarted.cookie}})).json(), configured);
  assert.deepEqual(await (await restarted.post('/answer', {question:'test', context:''})).json(), {answer:'yes'});
  assert.equal((await restarted.http('/health', {headers:{Cookie: app.cookie}})).status, 401);
});

test('settings rejects malformed keys without writing or reflecting any key', async (t) => {
  const fixture = await settingsFixture(t);
  const app = await fixture.launch();
  for (const form of [null, [], {}, {openaiKey:null}, {openaiKey:'secret fixture'}, {sonioxKey:'secret\nfixture'}, {openaiKey:'x'.repeat(513)}, {openaiKey, unexpected:true}]) {
    const response = await app.write(form);
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /secret|sk-test/);
  }
  await assert.rejects(stat(fixture.webKeysFile), {code:'ENOENT'});
  assert.deepEqual(await (await app.http('/health', {headers:{Cookie: app.cookie}})).json(), empty);
});

test('failed key persistence leaves fallback state, and concurrent setting edits are merged', async (t) => {
  const fixture = await settingsFixture(t);
  const app = await fixture.launch();
  await mkdir(fixture.webKeysFile, {recursive:true});
  const rejected = await app.write({openaiKey});
  assert.equal(rejected.status, 500);
  assert.doesNotMatch(await rejected.text(), /sk-test/);
  assert.deepEqual(await (await app.http('/health', {headers:{Cookie: app.cookie}})).json(), empty);
  await rm(fixture.webKeysFile, {recursive: true});
  assert.deepEqual((await Promise.all([app.write({openaiKey}), app.write({sonioxKey})])).map(({status}) => status), [200, 200]);
  assert.deepEqual(await (await app.http('/health', {headers:{Cookie: app.cookie}})).json(), configured);
  assert.deepEqual(JSON.parse(await readFile(fixture.webKeysFile, 'utf8')), {openaiKey, sonioxKey});
});

test('insecure or corrupt saved key files are rejected without exposing their values', async (t) => {
  const fixture = await settingsFixture(t);
  await mkdir(join(fixture.webKeysFile, '..'), {recursive:true});
  await writeFile(fixture.webKeysFile, openaiKey, {mode:0o600});
  const error = await fixture.launch().then(() => null, (cause) => cause);
  assert.ok(error);
  assert.match(error.message, /안전하게 읽을/);
  assert.doesNotMatch(error.message, /sk-test/);
});
