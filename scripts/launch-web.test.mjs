import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { endpointStatus, installedDependenciesMatch, prepareWebLaunch, webPort } from './launch-web.mjs';
import { webBuild } from '../server/web-build.mjs';

test('reopens only a recognised Sitenote web server and never follows a redirect', async () => {
  const url = 'http://127.0.0.1:8787';
  assert.equal(await endpointStatus(url, async (request, options) => {
    assert.equal(request, url + '/__sitenote/ready');
    assert.equal(options.redirect, 'error');
    return Response.json({ app: 'sitenote-web', build: 'new' });
  }, 'new'), 'ready');
  for (const build of [undefined, 'old']) {
    assert.equal(await endpointStatus(url, async () => Response.json({app:'sitenote-web', build}), 'new'), 'stale');
  }
  for (const response of [Response.json({ app: 'different' }), new Response('text'), new Response(null, { status: 401 })]) {
    assert.equal(await endpointStatus(url, async () => response), 'occupied');
  }
  assert.equal(await endpointStatus(url, async () => {
    throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  }), 'free');
  assert.equal(await endpointStatus(url, async () => { throw new Error('timeout'); }), 'occupied');
});

test('launcher ports are decimal, non-privileged, and cannot inject shell syntax', () => {
  assert.equal(webPort(undefined), 8787);
  assert.equal(webPort('18787'), 18787);
  for (const value of ['1023', '65536', '0x2253', '8787 & whoami', '']) {
    assert.throws(() => webPort(value), /SITE_WEB_PORT/);
  }
});

test('preflight rejects an occupied port and a stale running app before preparing files', async () => {
  for (const [probe, needsBuild, error] of [
    [() => 'occupied', () => assert.fail('no build check on another service'), /18787 포트/],
    [() => 'ready', () => true, /이전 버전/],
    [build => build ? 'stale' : 'ready', () => false, /이전 버전/],
  ]) {
    await assert.rejects(prepareWebLaunch(18787, {
      async probe(build) { return probe(build); },
      needsBuild,
      prepare() { assert.fail('no install or build while a server is running'); },
      readBuild: () => 'fresh',
    }), error);
  }
});

test('launcher reuses an identical app and checks for another process after preparing a free port', async () => {
  const calls = [];
  const options = {
    async probe(build) { calls.push(['probe',build]); return 'ready'; },
    needsBuild: () => false,
    prepare() { calls.push(['prepare']); },
    readBuild: () => 'fresh',
  };
  assert.deepEqual(await prepareWebLaunch(18787, options), {reuse:true, build:'fresh'});
  assert.deepEqual(calls.splice(0), [['probe',undefined], ['probe','fresh']]);
  const free = [];
  const checkFree = {...options, async probe(build) { free.push(build); return 'free'; }};
  assert.deepEqual(await prepareWebLaunch(18787, checkFree), {reuse:false, build:'fresh'});
  assert.deepEqual(free, [undefined,'fresh']);
  assert.deepEqual(calls.splice(0), [['prepare']]);
  await assert.rejects(prepareWebLaunch(18787, {
    ...options, async probe(build) { return build ? 'occupied' : 'free'; },
  }), /18787 포트/);
});

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'sitenote-launch-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  return dir;
}

test('installed packages are compared to the lock graph rather than file times', async t => {
  const dir = await temporary(t);
  const web = {version:'8.3.8',integrity:'sha512-original'};
  const dependency = {version:'1.2.0'};
  const packages = {'':{name:'fixture'},'node_modules/vite':web,'node_modules/subdep':dependency,
    'node_modules/optional-for-other-platform':{version:'1.0.0',optional:true,os:['win32']}};
  for (const [name, entry] of [['vite', web], ['subdep', dependency]]) {
    await mkdir(join(dir,'node_modules',name), {recursive:true});
    await writeFile(join(dir,'node_modules',name,'package.json'), JSON.stringify(entry));
  }
  const hidden = join(dir,'node_modules','.package-lock.json');
  const lock = join(dir,'package-lock.json');
  await writeFile(hidden, JSON.stringify({packages:{'node_modules/vite':web,'node_modules/subdep':dependency}}));
  await writeFile(lock, JSON.stringify({packages}));
  await utimes(hidden, 0, 0);
  const installed = () => installedDependenciesMatch(dir,'vite','--include=dev');
  assert.equal(installed(), true, 'the actual baseline is already installed');
  await writeFile(lock, JSON.stringify({packages:{...packages,'node_modules/subdep':{version:'1.3.0'}}}));
  await utimes(lock, 0, 0);
  assert.equal(installed(), false, 'a changed transitive version invalidates an equal timestamp');
  await writeFile(lock, JSON.stringify({packages:{...packages,'node_modules/vite':{...web,integrity:'sha512-changed'}}}));
  assert.equal(installed(), false, 'new integrity for the same version requires reinstalling');
  await writeFile(lock, JSON.stringify({packages:{...packages,'node_modules/dev-only':{version:'1.0.0',dev:true}}}));
  assert.equal(installedDependenciesMatch(dir,'vite','--omit=dev'), true);
  assert.equal(installed(), false, 'dev mode requires its non-optional dev packages');
  await writeFile(lock, JSON.stringify({packages}));
  await rm(join(dir,'node_modules','subdep','package.json'));
  assert.equal(installed(), false, 'an installed lock cannot hide a missing package');
});

test('server fingerprint includes the lockfile contents without relying on timestamps', async t => {
  const dir = await temporary(t);
  const index = Buffer.from('<title>Sitenote</title>');
  const lock = join(dir,'package-lock.json');
  await writeFile(join(dir,'index.mjs'), 'export const app = 1;');
  await writeFile(lock, '{"versions":{"ws":"1.1.0"}}');
  const initial = webBuild(index,dir);
  await utimes(lock, 0, 0);
  assert.equal(webBuild(index,dir), initial);
  await writeFile(lock, '{"versions":{"ws":"1.2.0"}}');
  await utimes(lock, 0, 0);
  assert.notEqual(webBuild(index,dir), initial);
});
