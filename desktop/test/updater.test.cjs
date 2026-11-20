const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtemp, readdir, readFile, rm, symlink, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { createUpdater } = require('../updater.cjs');

const base = 'https://github.com/seominpapa/sitenote';
const latest = 'https://api.github.com/repos/seominpapa/sitenote/releases/latest';
const asset = 'Sitenote-Windows-x64.exe';
const body = Buffer.from('test fixture payload');
const digest = 'sha256:' + createHash('sha256').update(body).digest('hex');

function release({version = 'v0.1.10', name = asset, checksum = digest, url, size = body.length} = {}) {
  return {tag_name:version, prerelease:false, draft:false, assets:[{
    name, size, state:'uploaded', digest:checksum,
    browser_download_url:url ?? `${base}/releases/download/${version}/${name}`,
  }]};
}

async function fixture(t, fetch, options = {}) {
  const userData = await mkdtemp(join(tmpdir(), 'sitenote-update-test-'));
  t.after(() => rm(userData, {recursive:true, force:true}));
  return {userData, updater:createUpdater({currentVersion:'0.1.9', userData, platform:'win32', arch:'x64', fetch, ...options})};
}

test('updates use official pinned assets and verify them again before handoff', async t => {
  const requests = [];
  const {updater} = await fixture(t, async (url, options) => {
    requests.push(String(url));
    assert.equal(options.redirect, 'manual');
    if (String(url) === latest) return Response.json(release());
    if (String(url).startsWith(base)) return new Response(null, {status:302, headers:{location:'https://release-assets.githubusercontent.com/object?sig=fixture'}});
    return new Response(body);
  });
  assert.deepEqual(await updater.check(), {status:'available', currentVersion:'0.1.9', version:'0.1.10', assetName:asset, size:body.length});
  await assert.rejects(updater.verifiedFile());
  assert.equal((await updater.download()).status, 'downloaded');
  const result = await updater.verifiedFile();
  assert.equal(result.assetName, asset);
  assert.deepEqual(await readFile(result.path), body);
  assert.deepEqual(requests, [latest, `${base}/releases/download/v0.1.10/${asset}`, 'https://release-assets.githubusercontent.com/object?sig=fixture']);
  await writeFile(result.path, Buffer.alloc(body.length));
  await assert.rejects(updater.verifiedFile(), /검증/);
});

test('does not downgrade, use nonstable versions, or load substituted assets', async t => {
  let data = release({version:'v0.1.8'});
  const {updater} = await fixture(t, async url => {
    assert.equal(String(url), latest);
    return Response.json(data);
  });
  assert.deepEqual(await updater.check(), {status:'current',currentVersion:'0.1.9'});
  data = {...release(), prerelease:true};
  await assert.rejects(updater.check());
  data = release({url:`https://untrusted.example/${asset}`});
  await assert.rejects(updater.check());
  data = release({checksum:null});
  await assert.rejects(updater.check());
  await assert.rejects(updater.download());
});

test('disallowed redirects are never followed and bad downloads are removed', async t => {
  let badResponse = new Response(null, {status:302, headers:{location:'https://release-assets.githubusercontent.com.example/download'}});
  const {updater,userData} = await fixture(t, async url => {
    if (String(url) === latest) return Response.json(release());
    assert.match(String(url), /^https:\/\/github\.com\//);
    return badResponse;
  });
  await updater.check();
  await assert.rejects(updater.download());
  badResponse = new Response(Buffer.alloc(body.length));
  await assert.rejects(updater.download(), /검증/);
  assert.deepEqual(await readdir(join(userData,'updates')), []);
});

test('a Mac check selects the appropriate DMG and refuses unsupported platforms', async t => {
  const name = 'Sitenote-macOS-arm64.dmg';
  const {updater} = await fixture(t, async () => Response.json(release({name})), {platform:'darwin',arch:'arm64'});
  assert.equal((await updater.check()).assetName, name);
  const unsupported = await fixture(t, async () => assert.fail('unsupported build should not contact GitHub'), {arch:'arm64'});
  await assert.rejects(unsupported.updater.check(), /지원/);
});

test('existing verified payload survives restart, but links are never handed off', async t => {
  const fetch = async url => String(url) === latest ? Response.json(release()) : new Response(body);
  const {updater,userData} = await fixture(t, fetch);
  await updater.check();
  await updater.download();
  const {path} = await updater.verifiedFile();
  const restarted = createUpdater({currentVersion:'0.1.9', userData, platform:'win32', arch:'x64', fetch});
  assert.equal((await restarted.check()).status,'downloaded');
  await rm(path);
  const impostor = join(userData, 'impostor');
  await writeFile(impostor, body, {mode:0o600});
  await symlink(impostor, path, 'file').catch(error => {
    if (error.code !== 'EPERM' || process.platform !== 'win32') throw error;
    t.diagnostic('This Windows test runner cannot create symbolic links; stage is still invalid without the file.');
  });
  await assert.rejects(restarted.verifiedFile(), /검증/);
  assert.equal((await restarted.check()).status,'available');
  await restarted.download();
  assert.deepEqual(await readFile((await restarted.verifiedFile()).path),body);
  assert.deepEqual(await readFile(impostor),body);
});
