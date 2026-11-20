import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { webBuild } from '../server/web-build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const serverDir = join(root, 'server');
const webRoot = join(root, 'dist', 'web');
const windows = process.platform === 'win32';
const host = '127.0.0.1';

export function webPort(raw = '8787') {
  const port = Number(raw);
  if (!/^\d{4,5}$/.test(raw) || port < 1024 || port > 65535) {
    throw new Error('SITE_WEB_PORT는 1024~65535 사이의 포트여야 합니다.');
  }
  return port;
}

export async function endpointStatus(address, request = fetch, expectedBuild) {
  try {
    const response = await request(address + '/__sitenote/ready', {
      redirect: 'error', signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) return 'occupied';
    const info = await response.json();
    if (info?.app !== 'sitenote-web') return 'occupied';
    return expectedBuild && info.build !== expectedBuild ? 'stale' : 'ready';
  } catch (error) {
    return error.cause?.code === 'ECONNREFUSED' ? 'free' : 'occupied';
  }
}

function run(command, args, options) {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  const result = new Promise(done => {
    child.once('error', error => done({ error }));
    child.once('exit', (code, signal) => done({ code, signal }));
  });
  return { child, result };
}

async function npm(command, cwd) {
  const cmd = windows
    ? run(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'npm', ...command], { cwd })
    : run('npm', command, { cwd });
  const { code, error } = await cmd.result;
  if (error?.code === 'ENOENT') throw new Error('Node.js와 함께 npm을 설치한 뒤 다시 여세요.');
  if (code !== 0) throw new Error('npm ' + command.join(' ') + ' 실행에 실패했습니다.');
}

function modified(path) {
  return statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0;
}

function latest(path) {
  if (!existsSync(path)) return 0;
  if (!statSync(path).isDirectory()) return modified(path);
  return Math.max(modified(path), ...readdirSync(path, { withFileTypes: true })
    .filter(entry => !entry.isSymbolicLink() && !entry.name.endsWith('.test.ts'))
    .map(entry => latest(join(path, entry.name))));
}

const readJson = path => JSON.parse(readFileSync(path,'utf8'));

export function installedDependenciesMatch(dir, name, mode) {
  try {
    const locked = readJson(join(dir,'package-lock.json')).packages;
    const installed = readJson(join(dir,'node_modules','.package-lock.json')).packages;
    const required = 'node_modules/' + name;
    const actualVersion = readJson(join(dir,required,'package.json')).version;
    if (!locked?.[required]?.version || locked[required].version !== actualVersion || !installed?.[required]) return false;
    if (Object.keys(installed).some(path => !Object.hasOwn(locked,path))) return false;
    return Object.entries(locked).every(([path,entry]) => {
      if (!path) return true;
      if (!Object.hasOwn(installed,path)) {
        // npm's installed lock may omit platform-specific packages and dev-only packages.
        return entry.optional === true || (mode === '--omit=dev' && (entry.dev === true || entry.devOptional === true));
      }
      return isDeepStrictEqual(entry,installed[path]) && existsSync(join(dir,path,'package.json'));
    });
  } catch {
    return false;
  }
}

async function prepareDependencies(dir, name, mode) {
  if (!installedDependenciesMatch(dir,name,mode)) {
    await npm(['ci', mode, '--no-audit', '--no-fund'], dir);
  }
}

function needsWebBuild() {
  const build = modified(join(webRoot, 'index.html'));
  const sources = existsSync(join(root, 'web', 'index.html'));
  return !build || (sources && ['web', 'src', 'package.json', 'package-lock.json'].some(path => latest(join(root, path)) > build));
}

function readWebBuild() {
  return webBuild(readFileSync(join(webRoot, 'index.html')), serverDir);
}

async function prepare() {
  if (needsWebBuild()) {
    if (!existsSync(join(root, 'web', 'index.html')) || !existsSync(join(root, 'package-lock.json'))) {
      throw new Error('웹 앱 파일을 찾을 수 없습니다. Sitenote ZIP 전체를 압축 해제한 뒤 다시 여세요.');
    }
    await prepareDependencies(root, 'vite', '--include=dev');
    await npm(['run', 'web:build'], root);
  }
  await prepareDependencies(serverDir, 'ws', '--omit=dev');
}

async function openBrowser(address) {
  if (process.argv.includes('--no-open') || process.env.SITE_WEB_NO_OPEN === '1') return;
  const launch = windows
    ? run(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '""', address], { windowsVerbatimArguments: true })
    : run(process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [address]);
  if ((await launch.result).code !== 0) console.log('브라우저 주소창에 ' + address + ' 을 입력하세요.');
}

function requireAvailablePort(status, port) {
  if (status === 'stale') throw new Error('이전 버전의 Sitenote가 실행 중입니다. 녹음을 저장하고 기존 실행 창에서 Ctrl+C로 종료한 뒤 새 실행기를 다시 여세요.');
  if (status === 'occupied') throw new Error(port + ' 포트를 다른 프로그램이 사용하고 있습니다. 해당 서버를 종료하거나 SITE_WEB_PORT에 다른 포트를 지정하세요.');
}

export async function prepareWebLaunch(port, {
  probe = build => endpointStatus('http://' + host + ':' + port,fetch,build),
  needsBuild = needsWebBuild, prepare:prepareApp = prepare, readBuild = readWebBuild,
} = {}) {
  const initial = await probe();
  requireAvailablePort(initial,port);
  if (initial === 'ready') {
    // A live instance may still serve the old assets. Do not rebuild underneath it.
    if (needsBuild()) requireAvailablePort('stale',port);
    const build = readBuild();
    const status = await probe(build);
    requireAvailablePort(status,port);
    if (status === 'ready') return {reuse:true,build};
  }
  await prepareApp();
  const build = readBuild();
  const status = await probe(build);
  requireAvailablePort(status,port);
  return {reuse:status === 'ready',build};
}

async function start() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 18)) throw new Error('Node.js 22.18 이상이 필요합니다.');
  const port = webPort(process.env.SITE_WEB_PORT);
  const address = 'http://' + host + ':' + port;
  const {reuse,build} = await prepareWebLaunch(port);
  if (reuse) {
    console.log('이미 실행 중인 Sitenote: ' + address);
    await openBrowser(address);
    return;
  }

  const { child, result } = run(process.execPath, ['--env-file-if-exists=.env', 'index.mjs'], {
    cwd: serverDir,
    env: { ...process.env, SITE_HOST: host, SITE_PORT: String(port), SITE_WEB_ROOT: webRoot, SITE_TLS_CERT: '', SITE_TLS_KEY: '' },
  });
  let stopped = false;
  const stop = () => { stopped = true; child.kill(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (!windows) process.once('SIGHUP', stop);
  const exited = Symbol();
  try {
    for (let attempt = 0; attempt < 40 && !stopped; attempt++) {
      if (await endpointStatus(address, fetch, build) === 'ready') {
        console.log('Sitenote: ' + address + '\n서버를 끄려면 이 창에서 Ctrl+C를 누르세요.');
        await openBrowser(address);
        const { code, signal, error } = await result;
        if (!stopped && (code !== 0 || signal)) throw error ?? new Error('웹 서버가 비정상 종료되었습니다.');
        return;
      }
      if (await Promise.race([result.then(() => exited), delay(250)]) === exited) {
        if (!stopped) throw new Error('웹 서버를 시작하지 못했습니다. 위 메시지를 확인하세요.');
        return;
      }
    }
    if (!stopped) throw new Error('웹 서버가 준비 시간 내에 응답하지 않았습니다.');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (!windows) process.removeListener('SIGHUP', stop);
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && resolve(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  start().catch(error => {
    console.error('Sitenote: ' + error.message);
    process.exitCode = 1;
  });
}
