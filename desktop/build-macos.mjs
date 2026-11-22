import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rename, rm, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Platform, Arch, build } from 'electron-builder';
import { buildDocumentConverter } from './build-document-converter.mjs';
import { assertMacSigningReady, notarizeMacDmg, verifyMacDmgSignature } from './mac-signing.mjs';

const projectDir = import.meta.dirname;
const dist = join(projectDir, '..', 'dist');
const runtime = join(dist, 'runtime');
const args = process.argv.slice(2);
const signingOnly = args[0] === '--sign-only';
const notarizeOnly = args[0] === '--notarize-only';
if (signingOnly || notarizeOnly) args.shift();
if (process.platform !== 'darwin' || args.length > 1 || (args[0] && !['arm64', 'x64'].includes(args[0]))) {
  throw new Error('On macOS, run npm run dist:mac -- [--sign-only|--notarize-only] [arm64|x64].');
}
const architectures = args.length ? args : ['arm64', 'x64'];
const artifacts = architectures.map(arch => `Sitenote-macOS-${arch}.dmg`);
const builtDir = join(dist, 'desktop-mac');
const profile = process.env.APPLE_KEYCHAIN_PROFILE || 'Sitenote';
const exec = promisify(execFile);
const { version } = JSON.parse(await readFile(join(projectDir, 'package.json'), 'utf8'));

if (!notarizeOnly) await buildSignedDmg();
if (!signingOnly) {
  if (notarizeOnly) {
    for (const name of artifacts) await verifyDmgVersion(join(builtDir, name));
  }
  const results = await Promise.allSettled(artifacts.map(name => notarizeMacDmg(join(builtDir, name), profile)));
  const failures = results.flatMap((result, index) =>
    result.status === 'rejected' ? [`${artifacts[index]}: ${result.reason.message}`] : []);
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') console.log(`Apple accepted ${artifacts[index]} (submission ${result.value})`);
  });
  if (failures.length) throw new Error(failures.join('\n'));
  for (const name of artifacts) await copyReleaseDmg(name);
}

async function verifyDmgVersion(path) {
  await verifyMacDmgSignature(path);
  const mount = await mkdtemp(join(tmpdir(), 'sitenote-dmg-'));
  try {
    await exec('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, path]);
    try {
      const info = join(mount, 'Sitenote.app', 'Contents', 'Info.plist');
      const { stdout } = await exec('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', info]);
      if (stdout.trim() !== version) throw new Error(`${path} contains version ${stdout.trim()}, expected ${version}.`);
    } finally {
      await exec('hdiutil', ['detach', mount]);
    }
  } finally {
    await rmdir(mount).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function buildSignedDmg() {
  await assertMacSigningReady();
  await checkBuildInputs();
  await buildDocumentConverter();
  const built = await build({
    projectDir,
    config: join(projectDir, 'electron-builder.mac.yml'),
    targets: Platform.MAC.createTarget('dmg', ...architectures.map(arch => Arch[arch])),
    publish: 'never',
  });
  for (const name of artifacts) {
    const source = join(builtDir, name);
    if (!built.includes(source)) throw new Error(`Missing packaged artifact: ${source}`);
    await verifyMacDmgSignature(source);
  }
}

async function checkBuildInputs() {
  const inputs = [
    join(projectDir, 'main.cjs'), join(projectDir, 'runtime.cjs'),
    join(runtime, 'server', 'app.mjs'), join(runtime, 'server', 'node_modules', 'ws', 'package.json'),
    join(runtime, 'dist', 'web', 'index.html'),
  ];
  for (const path of inputs) {
    if (!(await stat(path).catch(() => null))?.isFile()) throw new Error(`Missing Mac package input: ${path}`);
  }
}

async function copyReleaseDmg(name) {
  const source = join(builtDir, name);
  const destination = join(dist, name);
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await copyFile(source, temporary);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  console.log(destination);
}
