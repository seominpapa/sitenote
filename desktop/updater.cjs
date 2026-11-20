const { createHash } = require('node:crypto');
const { constants } = require('node:fs');
const { lstat, mkdir, open, rename, unlink } = require('node:fs/promises');
const { isAbsolute, join } = require('node:path');

const repo = 'seominpapa/sitenote';
const latest = `https://api.github.com/repos/${repo}/releases/latest`;
const downloads = `https://github.com/${repo}/releases/download/`;
const releaseHosts = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
const maxAsset = 512 * 1024 * 1024;
const maxMetadata = 512 * 1024;
const messages = Object.freeze({
  incompatible:'이 운영체제 또는 앱 버전의 자동 확인을 지원하지 않습니다.',
  unavailable:'공식 GitHub 배포 정보를 확인하지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요.',
  release:'새 버전의 공식 설치 파일과 SHA-256 정보를 확인하지 못했습니다.',
  download:'업데이트 파일을 저장하지 못했습니다. 네트워크와 디스크 공간을 확인하고 다시 시도하세요.',
  checksum:'업데이트 파일을 검증하지 못했습니다. 업데이트를 다시 다운로드하세요.',
  missing:'먼저 새 버전을 확인하고 업데이트 파일을 다운로드하세요.',
  busy:'업데이트를 처리하는 중입니다. 잠시 뒤 다시 시도하세요.',
});

function version(value) {
  const fields = typeof value === 'string' && /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.exec(value);
  return fields ? fields.slice(1).map(Number) : undefined;
}

function newer(candidate, current) {
  for (let index = 0; index < 3; index++) {
    if (candidate[index] !== current[index]) return candidate[index] > current[index];
  }
  return false;
}

function assetFor(platform, arch) {
  if (platform === 'win32' && arch === 'x64') return 'Sitenote-Windows-x64.exe';
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return `Sitenote-macOS-${arch}.dmg`;
}

function readRelease(data, current, assetName) {
  const tag = typeof data?.tag_name === 'string' && data.tag_name.startsWith('v') ? data.tag_name : '';
  const next = version(tag.slice(1));
  if (!next || data.draft !== false || data.prerelease !== false) throw Error(messages.release);
  if (!newer(next, current)) return undefined;
  const found = Array.isArray(data.assets) ? data.assets.filter(value => value?.name === assetName) : [];
  const asset = found[0];
  const url = downloads + tag + '/' + assetName;
  if (found.length !== 1 || asset.state !== 'uploaded' || asset.browser_download_url !== url
    || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maxAsset
    || typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw Error(messages.release);
  return { url, version:tag.slice(1), assetName, size:asset.size, sha256:asset.digest.slice(7) };
}

const requestHeaders = {'User-Agent':'Sitenote-Desktop'};

async function fetchRelease(request) {
  try {
    const response = await request(latest, {redirect:'manual', signal:AbortSignal.timeout(15_000), headers:{
      ...requestHeaders, Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2022-11-28',
    }});
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw Error();
    }
    let length = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      length += chunk.byteLength;
      if (length > maxMetadata) throw Error();
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch {
    throw Error(messages.unavailable);
  }
}

async function fetchAsset(url, request) {
  const signal = AbortSignal.timeout(15 * 60_000);
  for (let count = 0; count < 4; count++) {
    const response = await request(url, { redirect:'manual', signal, headers:requestHeaders });
    if (response.status === 200 && response.body) return response.body;
    await response.body?.cancel();
    if (![301,302,303,307,308].includes(response.status)) break;
    const location = response.headers.get('location');
    if (!location) break;
    const next = new URL(location, url);
    if (next.protocol !== 'https:' || !releaseHosts.has(next.hostname) || next.username || next.password || next.port) break;
    url = next.href;
  }
  throw Error(messages.download);
}

const privateMode = info => process.platform === 'win32' || !(info.mode & 0o077);

async function stageDirectory(directory, create = false) {
  if (create) {
    try { await mkdir(directory, {mode:0o700}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || !privateMode(info)) throw Error(messages.download);
}

async function discardPartial(path) {
  try { await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function saveVerified(path, partial, release, request) {
  // Use a fixed staging slot so aborted download leftovers never accumulate.
  await discardPartial(partial);
  const file = await open(partial, 'wx', 0o600);
  try {
    const hash = createHash('sha256');
    let size = 0;
    const body = await fetchAsset(release.url, request);
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > release.size) throw Error(messages.checksum);
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    if (size !== release.size || hash.digest('hex') !== release.sha256) throw Error(messages.checksum);
    await file.sync();
    await file.close();
    await rename(partial, path);
  } finally {
    await file.close().catch(() => {});
    await discardPartial(partial).catch(() => {});
  }
}

const sameFile = (a,b) => a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

async function verifyOnDisk(path, release) {
  const before = await lstat(path);
  if (!before.isFile() || !privateMode(before) || before.nlink !== 1 || before.size !== release.size) return false;
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    if (!sameFile(before, await file.stat())) return false;
    const hash = createHash('sha256');
    // No more than the previously checked asset size is ever read.
    for await (const chunk of file.createReadStream({autoClose:false, end:release.size - 1})) hash.update(chunk);
    return hash.digest('hex') === release.sha256 && sameFile(before, await lstat(path));
  } finally {
    await file.close();
  }
}

async function findStaged(directory, candidate) {
  try {
    await stageDirectory(directory);
    const path = join(directory, candidate.assetName);
    if (await verifyOnDisk(path, candidate)) return {...candidate, path};
  } catch {
    // No usable cached installer; the explicit download will report storage errors if relevant.
  }
}

function createUpdater({currentVersion, userData, platform = process.platform, arch = process.arch, fetch:request = globalThis.fetch}) {
  const installed = version(currentVersion);
  const assetName = assetFor(platform, arch);
  const directory = typeof userData === 'string' && isAbsolute(userData) ? join(userData, 'updates') : undefined;
  let candidate;
  let staged;
  let busy = false;

  const exclusive = async operation => {
    if (busy) throw Error(messages.busy);
    busy = true;
    try { return await operation(); } finally { busy = false; }
  };
  const status = (state, release) => ({status:state, currentVersion,
    ...(release && {version:release.version, assetName:release.assetName, size:release.size}),
  });

  return {
    check:() => exclusive(async () => {
      candidate = undefined;
      if (!installed || !assetName || !directory) throw Error(messages.incompatible);
      candidate = readRelease(await fetchRelease(request), installed, assetName);
      staged = candidate && await findStaged(directory, candidate);
      return candidate ? status(staged ? 'downloaded' : 'available', candidate) : status('current');
    }),
    download:() => exclusive(async () => {
      if (!candidate) throw Error(messages.missing);
      staged = undefined;
      try {
        await stageDirectory(directory, true);
        const path = join(directory, candidate.assetName);
        await saveVerified(path, path + '.partial', candidate, request);
        staged = {...candidate, path};
        return status('downloaded', candidate);
      } catch (error) {
        throw Error(error.message === messages.checksum ? messages.checksum : messages.download);
      }
    }),
    verifiedFile:() => exclusive(async () => {
      if (!candidate || !staged) throw Error(messages.missing);
      const {path, version, assetName} = staged;
      try {
        await stageDirectory(directory);
        if (!await verifyOnDisk(path, staged)) throw Error();
        return {path, version, assetName};
      } catch {
        staged = undefined;
        throw Error(messages.checksum);
      }
    }),
  };
}

module.exports = { createUpdater };
