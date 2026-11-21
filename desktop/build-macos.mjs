import { copyFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Platform, Arch, build } from 'electron-builder';
import { buildDocumentConverter } from './build-document-converter.mjs';

const projectDir = import.meta.dirname;
const dist = join(projectDir, '..', 'dist');
const runtime = join(dist, 'runtime');
const args = process.argv.slice(2);
if (process.platform !== 'darwin' || args.length > 1 || (args[0] && !['arm64', 'x64'].includes(args[0]))) {
  throw new Error('On macOS, run npm run dist:mac -- [arm64|x64].');
}
const architectures = args.length ? args : ['arm64', 'x64'];
const inputs = [
  join(projectDir, 'main.cjs'), join(projectDir, 'runtime.cjs'),
  join(runtime, 'server', 'app.mjs'), join(runtime, 'server', 'node_modules', 'ws', 'package.json'),
  join(runtime, 'dist', 'web', 'index.html'),
];
for (const path of inputs) {
  if (!(await stat(path).catch(() => null))?.isFile()) throw new Error(`Missing Mac package input: ${path}`);
}

await buildDocumentConverter();
const built = await build({
  projectDir,
  config: join(projectDir, 'electron-builder.mac.yml'),
  targets: Platform.MAC.createTarget('dmg', ...architectures.map(arch => Arch[arch])),
  publish: 'never',
});

for (const arch of architectures) {
  const name = `Sitenote-macOS-${arch}.dmg`;
  const source = join(dist, 'desktop-mac', name);
  const destination = join(dist, name);
  if (!built.includes(source)) throw new Error(`Missing packaged artifact: ${source}`);
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await copyFile(source, temporary);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  console.log(destination);
}
