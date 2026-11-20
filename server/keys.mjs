import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const names = new Set(['openaiKey', 'sonioxKey']);

export function parseKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length || entries.length > names.size) return null;
  const keys = {};
  for (const [name, raw] of entries) {
    if (!names.has(name) || typeof raw !== 'string' || raw.length > 512) return null;
    const trimmed = raw.trim();
    if (trimmed && !/^[!-~]+$/.test(trimmed)) return null;
    if (trimmed) keys[name] = trimmed;
  }
  return keys;
}

function load(path) {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077)) || info.size > 4096) throw Error();
      const keys = parseKeys(JSON.parse(readFileSync(fd, 'utf8')));
      if (!keys) throw Error();
      return keys;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('서버에 저장된 API 키 파일을 안전하게 읽을 수 없습니다. 파일의 형식과 소유자 전용 권한을 확인하세요.');
  }
}

export function createKeyStore(path) {
  let current = load(path);
  let pending = Promise.resolve();
  return {
    key(name) { return current[name]; },
    save(changes) {
      if (!Object.keys(changes).length) return pending;
      const task = pending.then(async () => {
        const next = { ...current, ...changes };
        const stage = path + '.' + randomUUID() + '.tmp';
        try {
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          await writeFile(stage, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx', flush: true });
          await rename(stage, path);
          current = next;
        } catch {
          await unlink(stage).catch(() => {});
          throw new Error('API 키를 서버에 저장하지 못했습니다.');
        }
      });
      pending = task.catch(() => {});
      return task;
    },
  };
}
