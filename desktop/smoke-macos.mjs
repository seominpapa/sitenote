import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron, expect } from '@playwright/test';

const command = promisify(execFile);
const arch = process.argv[2];
if (process.platform !== 'darwin' || (arch !== 'arm64' && arch !== 'x64')) {
  throw new Error('On macOS, run node desktop/smoke-macos.mjs arm64|x64.');
}

const image = join(import.meta.dirname, '..', 'dist', `Sitenote-macOS-${arch}.dmg`);
const temp = await mkdtemp(join(tmpdir(), 'Sitenote smoke '));
const mount = join(temp, 'Mounted app');
const profile = join(temp, 'QA profile');
const bundle = join(mount, 'Sitenote.app');
const executable = join(bundle, 'Contents', 'MacOS', 'Sitenote');
let mounted = false;
let app;

async function validateImage() {
  await command('hdiutil', ['verify', image]);
  await mkdir(mount);
  await mkdir(profile);
  await command('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, image]);
  mounted = true;
  assert.equal(await readlink(join(mount, 'Applications')), '/Applications');
  assert((await lstat(executable)).isFile());
  for (const filename of ['Open-Sans-OFL.txt', 'react-LICENSE.txt', 'react-dom-LICENSE.txt', 'scheduler-LICENSE.txt']) {
    assert((await lstat(join(bundle, 'Contents', 'Resources', 'runtime', 'licenses', filename))).isFile());
  }
  assert.equal((await command('lipo', ['-archs', executable])).stdout.trim(), arch === 'x64' ? 'x86_64' : 'arm64');
  await command('codesign', ['--verify', '--deep', '--strict', bundle]);
  const plist = join(bundle, 'Contents', 'Info.plist');
  assert((await command('plutil', ['-extract', 'NSMicrophoneUsageDescription', 'raw', plist])).stdout.includes('마이크'));
}

async function validateRunningApp() {
  app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${profile}`], timeout: 45_000 });
  const window = await app.firstWindow();
  await expect(window.getByRole('button', { name: 'Sitenote 홈' })).toBeVisible();
  await expect(window.getByText('로컬 서버 연결됨')).toBeVisible();
  assert.equal(await app.evaluate(({app}) => app.getPath('userData')), profile);
  assert.equal(await app.evaluate(() => process.arch), arch);
  assert.equal(await window.evaluate(() => window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function'), true);
  const external = await fetch(new URL('/health', window.url()), {signal: AbortSignal.timeout(3_000)});
  assert.equal(external.status, 403);
  assert.equal(await window.evaluate(() => new Promise((resolve, reject) => {
    const url = new URL('/stream', window.location.href);
    url.protocol = 'ws:';
    const socket = new WebSocket(url);
    const timer = setTimeout(() => { socket.close(); reject(Error('WebSocket timed out')); }, 5_000);
    socket.addEventListener('open', () => { clearTimeout(timer); socket.close(); resolve('connected'); }, {once:true});
    socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('WebSocket failed')); }, {once:true});
  })), 'connected');
}

try {
  await validateImage();
  await validateRunningApp();
  console.log(`Verified ${arch} image, signature, and app with its bundled HTTP and WebSocket server.`);
} finally {
  try { await app?.close(); }
  finally {
    if (mounted) await command('hdiutil', ['detach', mount]);
    await rm(temp, { recursive:true, force:true });
  }
}
