import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { crc32, deflateRawSync } from 'node:zlib';
import { webBuild } from '../server/web-build.mjs';
import { installedDependenciesMatch } from './launch-web.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const max32 = 0xffff_ffff;
const fontLicense = 'Open-Sans-OFL.txt';
const embeddedWebPackages = ['react', 'react-dom', 'scheduler'];
const staticExtension = /\.(?:css|js|json|mjs|wasm|woff2?|svg|png|ico|jpe?g|webp|avif)$/i;

async function file(base, name, path = name, mode = 0o644) {
  const source = join(base, name);
  if (!(await lstat(source)).isFile()) throw Error(`일반 파일이 아닙니다: ${name}`);
  return {path, mode, bytes:await readFile(source)};
}

async function webAssets(base, prefix = 'assets') {
  const entries = await readdir(join(base, prefix), {withFileTypes:true});
  const result = await Promise.all(entries.map(entry => {
    if (entry.name.startsWith('.')) return [];
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return webAssets(base, relative);
    if (!staticExtension.test(entry.name)) throw Error(`예상하지 못한 웹 빌드 파일: ${relative}`);
    return file(base, relative, `dist/web/${relative}`);
  }));
  return result.flat();
}

async function runtimeFiles(root, webRoot) {
  const server = join(root, 'server');
  if (!installedDependenciesMatch(server, 'ws', '--omit=dev')) {
    throw Error('서버 패키지가 잠금 파일과 다릅니다. 패키징할 컴퓨터에서 npm ci --prefix server --omit=dev를 실행하세요.');
  }
  const modules = (await readdir(server, {withFileTypes:true}))
    .filter(entry => entry.isFile() && !entry.name.startsWith('.') && /^(?:.+\.mjs|package(?:-lock)?\.json)$/.test(entry.name))
    .map(entry => file(server, entry.name, `server/${entry.name}`));
  const wsDir = join(server, 'node_modules', 'ws');
  const wsFiles = ['LICENSE', 'README.md', 'browser.js', 'index.js', 'package.json', 'wrapper.mjs',
    ...(await readdir(join(wsDir, 'lib'))).filter(name => name.endsWith('.js')).map(name => `lib/${name}`)];
  const [index, assets, entry] = await Promise.all([
    file(webRoot, 'index.html', 'dist/web/index.html'), webAssets(webRoot), file(server, 'index.mjs'),
  ]);
  if (!entry.bytes.length || !assets.some(item => /\.m?js$/.test(item.path))) throw Error('웹 빌드 또는 서버 파일이 비어 있습니다.');
  const available = new Set(assets.map(item => item.path));
  for (const [, path] of index.bytes.toString('utf8').matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)) {
    if (!available.has('dist/web' + path)) throw Error(`웹 빌드 자산을 찾을 수 없습니다: ${path}`);
  }
  return [...await Promise.all([
    ...modules, ...wsFiles.map(name => file(wsDir, name, `server/node_modules/ws/${name}`)),
    file(server, 'node_modules/.package-lock.json', 'server/node_modules/.package-lock.json'),
    file(root, `web/fonts/${fontLicense}`, `licenses/${fontLicense}`),
    ...embeddedWebPackages.map(name => file(root, `node_modules/${name}/LICENSE`, `licenses/${name}-LICENSE.txt`)),
  ]), index, ...assets];
}

async function writeTree(target, files) {
  await Promise.all(files.map(async ({path, mode, bytes}) => {
    const destination = join(target, path);
    await mkdir(dirname(destination), {recursive:true});
    await writeFile(destination, bytes, {mode});
  }));
}

function zipEntry({path, mode, bytes}, offset) {
  const name = Buffer.from(path);
  const data = deflateRawSync(bytes, {level:9});
  if (name.length > 0xffff || Math.max(data.length, bytes.length, offset) >= max32) throw Error('ZIP 크기 제한을 넘었습니다.');
  const crc = crc32(bytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6); // UTF-8 file names
  local.writeUInt16LE(8, 8); // Deflate
  local.writeUInt16LE(0x21, 12); // Fixed DOS date: 1980-01-01
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4); // Unix permissions, ZIP 2.0
  local.copy(central, 6, 4, 28);
  central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
  central.writeUInt32LE(offset, 42);
  return {local:[local,name,data], central:[central,name], size:local.length + name.length + data.length};
}

function archiveFiles(files) {
  const locals = [], directory = [];
  let offset = 0;
  const ordered = [...files].sort((left, right) => left.path < right.path ? -1 : Number(left.path > right.path));
  for (const entry of ordered) {
    const packed = zipEntry(entry, offset);
    locals.push(...packed.local);
    directory.push(...packed.central);
    offset += packed.size;
  }
  const directorySize = directory.reduce((size, entry) => size + entry.length, 0);
  if (offset + directorySize >= max32 || ordered.length >= 0xffff) throw Error('ZIP 크기 제한을 넘었습니다.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(ordered.length, 8);
  end.writeUInt16LE(ordered.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...directory, end]);
}

async function replaceRuntime(candidate, runtime, backup) {
  let moved = false;
  try { await rename(runtime, backup); moved = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await rename(candidate, runtime); }
  catch (error) {
    if (moved) await rename(backup, runtime);
    throw error;
  }
}

export async function packageDesktop({root = project, output = join(root, 'dist'), webRoot = join(root, 'dist', 'web'), stageOnly = false, zipOnly = false} = {}) {
  if (stageOnly && zipOnly) throw Error('런타임 준비와 ZIP 생성 중 하나를 선택하세요.');
  const files = await runtimeFiles(root, webRoot);
  await mkdir(output, {recursive:true});
  const workspace = await mkdtemp(join(output, '.package-web-'));
  const candidate = join(workspace, 'runtime');
  const runtime = join(output, 'runtime');
  const archive = join(output, 'Sitenote-Desktop.zip');
  try {
    await writeTree(candidate, files);
    const build = webBuild(await readFile(join(candidate, 'dist', 'web', 'index.html')), join(candidate, 'server'));
    const temporaryZip = join(workspace, 'Sitenote-Desktop.zip');
    if (!stageOnly) {
      const launchers = await Promise.all([
        file(root, 'Sitenote.command', 'Sitenote.command', 0o755), file(root, 'Sitenote.cmd'),
        file(root, 'README.md'), file(root, 'scripts/launch-web.mjs'), file(root, 'server/.env.example'),
      ]);
      const archiveRuntime = files.map(entry => entry.path === `licenses/${fontLicense}`
        ? {...entry, path:`web/fonts/${fontLicense}`} : entry);
      await writeFile(temporaryZip, archiveFiles([...launchers, ...archiveRuntime]));
    }
    if (!zipOnly) await replaceRuntime(candidate, runtime, join(workspace, 'old-runtime'));
    if (!stageOnly) await rename(temporaryZip, archive);
    return {build, ...(zipOnly ? {} : {runtime}), ...(stageOnly ? {} : {archive})};
  } finally {
    await rm(workspace, {recursive:true, force:true});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {values} = parseArgs({options:{'stage-only':{type:'boolean'}, 'zip-only':{type:'boolean'}, 'web-root':{type:'string'}}});
    const result = await packageDesktop({stageOnly:values['stage-only'], zipOnly:values['zip-only'],
      ...(values['web-root'] && {webRoot:resolve(values['web-root'])})});
    if (result.runtime) console.log(result.runtime, result.build);
    if (result.archive) console.log(result.archive, result.build);
  } catch (error) {
    console.error(`Sitenote: ${error.message}`);
    process.exitCode = 1;
  }
}
