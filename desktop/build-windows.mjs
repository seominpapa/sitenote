import { constants } from 'node:fs';
import { access, copyFile, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Platform, Arch, build } from 'electron-builder';
import { buildDocumentConverter } from './build-document-converter.mjs';

const projectDir = import.meta.dirname;
const dist = join(projectDir, '..', 'dist');
const runtime = join(dist, 'runtime');
const artifact = 'Sitenote-Windows-x64.exe';

async function assertReadable(path) {
  try {
    await access(path, constants.R_OK);
    if (!(await stat(path)).isFile()) throw new Error('not a file');
  } catch (cause) {
    throw new Error(`Missing Windows package input: ${path}`, { cause });
  }
}

async function assertPe(path, machine) {
  const file = await open(path, 'r');
  try {
    const dos = Buffer.alloc(64);
    const pe = Buffer.alloc(6);
    if ((await file.read(dos, 0, dos.length, 0)).bytesRead !== dos.length ||
        dos.toString('ascii', 0, 2) !== 'MZ' ||
        (await file.read(pe, 0, pe.length, dos.readUInt32LE(60))).bytesRead !== pe.length ||
        pe.readUInt32LE(0) !== 0x4550 ||
        (machine !== undefined && pe.readUInt16LE(4) !== machine)) {
      throw new Error(`Unexpected Windows executable format: ${path}`);
    }
  } finally {
    await file.close();
  }
}

await Promise.all([
  join(projectDir, 'main.cjs'),
  join(projectDir, 'runtime.cjs'),
  join(runtime, 'server', 'app.mjs'),
  join(runtime, 'server', 'node_modules', 'ws', 'package.json'),
  join(runtime, 'dist', 'web', 'index.html'),
].map(assertReadable));

await buildDocumentConverter();
const paths = await build({
  projectDir,
  config: join(projectDir, 'electron-builder.win.yml'),
  targets: Platform.WINDOWS.createTarget('portable', Arch.x64),
  publish: 'never',
});
const output = join(dist, 'desktop-windows');
const built = join(output, artifact);
if (!paths.includes(built)) throw new Error(`Missing packaged artifact: ${built}`);
await Promise.all([
  assertPe(built),
  assertPe(join(output, 'win-unpacked', 'Sitenote.exe'), 0x8664),
]);

const destination = join(dist, artifact);
const temporary = `${destination}.${process.pid}.tmp`;
try {
  await copyFile(built, temporary);
  await rename(temporary, destination);
} finally {
  await rm(temporary, { force: true });
}
console.log(destination);
