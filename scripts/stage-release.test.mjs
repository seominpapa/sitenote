import assert from 'node:assert/strict';
import { execFile as exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(exec);
const stageRelease = fileURLToPath(new URL('./stage-release.mjs', import.meta.url));
const desktopFiles = [
  'Sitenote-Desktop.zip', 'Sitenote-macOS-arm64.dmg', 'Sitenote-macOS-x64.dmg',
  'Sitenote-Windows-x64.exe', 'THIRD-PARTY-NOTICES.txt',
];

async function fixture(t, names) {
  const dir = await mkdtemp(join(tmpdir(), 'sitenote-stage-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await Promise.all(names.map(name => writeFile(join(dir, name), `Fixture: ${name}\n`)));
  return dir;
}

test('stages only desktop release assets and hashes; preserves any previously built APK', async t => {
  const apk = 'Sitenote-Android-arm64.apk';
  const dir = await fixture(t, [...desktopFiles, apk, 'SHA256SUMS.txt']);
  const { stdout } = await execFile(process.execPath, [stageRelease, dir]);
  const output = stdout.trim();
  assert.deepEqual((await readdir(output)).sort(), [...desktopFiles, 'SHA256SUMS.txt'].sort());
  const expected = [];
  for (const name of desktopFiles) {
    const bytes = await readFile(join(output, name));
    assert.deepEqual(bytes, await readFile(join(dir, name)));
    expected.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`);
  }
  assert.equal(await readFile(join(output, 'SHA256SUMS.txt'), 'utf8'), expected.join(''));
  assert.equal(await readFile(join(dir, apk), 'utf8'), `Fixture: ${apk}\n`);
  assert.equal(await readFile(join(dir, 'SHA256SUMS.txt'), 'utf8'), 'Fixture: SHA256SUMS.txt\n');
});

test('fails without creating an upload folder when a required desktop artifact is missing', async t => {
  const missing = 'Sitenote-Windows-x64.exe';
  const names = desktopFiles.filter(name => name !== missing);
  const dir = await fixture(t, names);
  await assert.rejects(execFile(process.execPath, [stageRelease, dir]), /Sitenote-Windows-x64\.exe/);
  assert.deepEqual((await readdir(dir)).sort(), names.sort());
});
