import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { webBuild } from '../server/web-build.mjs';
import { installedDependenciesMatch } from './launch-web.mjs';
import { packageDesktop } from './package-web.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function zipFiles(zip) {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let index = zip.readUInt32LE(end + 16);
  const files = new Map();
  for (let file = 0; file < count; file++) {
    assert.equal(zip.readUInt32LE(index), 0x02014b50);
    const size = zip.readUInt32LE(index + 20);
    const nameSize = zip.readUInt16LE(index + 28);
    const mode = zip.readUInt32LE(index + 38) >>> 16;
    const position = zip.readUInt32LE(index + 42);
    const name = zip.toString('utf8', index + 46, index + 46 + nameSize);
    assert.equal(zip.readUInt32LE(position), 0x04034b50);
    const address = position + 30 + zip.readUInt16LE(position + 26) + zip.readUInt16LE(position + 28);
    const bytes = inflateRawSync(zip.subarray(address, address + size));
    assert.equal(bytes.length, zip.readUInt32LE(index + 24));
    files.set(name, {mode, bytes});
    index += 46 + nameSize + zip.readUInt16LE(index + 30) + zip.readUInt16LE(index + 32);
  }
  return files;
}

test('offline desktop staging is reproducible, matches the server digest, and includes only runtime dependencies', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sitenote-package-test-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const output = join(dir, 'release');
  const webRoot = join(dir, 'web');
  await mkdir(join(webRoot, 'assets'), {recursive:true});
  const index = '<!doctype html><script type="module" src="/assets/index-test.js"></script>';
  await writeFile(join(webRoot, 'index.html'), index);
  await writeFile(join(webRoot, 'assets', 'index-test.js'), 'export const ready = true;\n');
  const stage = await packageDesktop({root, output, webRoot, stageOnly:true});
  const serverDir = join(stage.runtime, 'server');
  const runtimeWeb = join(stage.runtime, 'dist', 'web');
  assert.deepEqual(await readdir(output), ['runtime']);
  assert.equal(await readFile(join(runtimeWeb, 'index.html'), 'utf8'), index);
  assert.equal(webBuild(Buffer.from(index), serverDir), webBuild(Buffer.from(index), join(root, 'server')));
  assert.equal(installedDependenciesMatch(serverDir, 'ws', '--omit=dev'), true);
  assert.equal(createRequire(join(serverDir, 'package.json')).resolve('ws'), await realpath(join(serverDir, 'node_modules', 'ws', 'index.js')));
  assert.match(await readFile(join(stage.runtime, 'licenses', 'Open-Sans-OFL.txt'), 'utf8'), /SIL OPEN FONT LICENSE/i);

  const {archive} = await packageDesktop({root, output, webRoot});
  const original = await readFile(archive);
  const files = zipFiles(original);
  for (const path of ['Sitenote.command', 'Sitenote.cmd', 'README.md', 'scripts/launch-web.mjs', 'server/index.mjs',
    'server/node_modules/.package-lock.json', 'server/node_modules/ws/LICENSE', 'web/fonts/Open-Sans-OFL.txt', 'dist/web/assets/index-test.js']) {
    assert(files.has(path), path + ' missing');
  }
  for (const dependency of ['react', 'react-dom', 'scheduler']) {
    const expected = await readFile(join(root, 'node_modules', dependency, 'LICENSE'));
    const name = `${dependency}-LICENSE.txt`;
    assert.match(expected.toString(), /MIT License/);
    assert.deepEqual(await readFile(join(stage.runtime, 'licenses', name)), expected);
    assert.deepEqual(files.get(`licenses/${name}`)?.bytes, expected);
  }
  assert.equal(files.get('Sitenote.command').mode & 0o777, 0o755);
  assert.equal(files.get('Sitenote.cmd').mode & 0o777, 0o644);
  assert(![...files.keys()].some(path => /(?:^|\/)(?:\.env$|\.local-signing|test|\.DS_Store)/.test(path)));
  await writeFile(join(stage.runtime, 'stage-in-use'), 'leave alone');
  await packageDesktop({root, output, webRoot, zipOnly:true});
  assert.equal(await readFile(join(stage.runtime, 'stage-in-use'), 'utf8'), 'leave alone');
  assert.deepEqual(await readFile(archive), original);
});
