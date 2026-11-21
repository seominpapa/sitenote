const {
  constants,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} = require('node:fs/promises');
const { lstatSync, readFileSync, renameSync, rmSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { basename, extname, isAbsolute, join } = require('node:path');

const storageName = 'Sitenote';
const markerName = '.sitenote-storage-v1';
const marker = 'Sitenote managed storage v1\n';

function absolutePath(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  return value;
}

function validId(value) {
  if (typeof value !== 'string' || !value || value.length > 512
      || value === '.' || value === '..' || /[\\/\0]/.test(value)) {
    throw new TypeError('note id is invalid');
  }
  return value;
}

function noteKey(id) {
  return Buffer.from(validId(id)).toString('base64url');
}

function validEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('note entry is invalid');
  validId(entry.id);
  if (typeof entry['transcript.md'] !== 'string') throw new TypeError('transcript.md must be a string');
  if (entry['summary.md'] !== undefined && typeof entry['summary.md'] !== 'string') {
    throw new TypeError('summary.md must be a string');
  }
  return entry;
}

function validFilename(filename) {
  if (typeof filename !== 'string' || !filename || filename === '.' || filename === '..'
      || filename !== basename(filename) || /[\\/\0]/.test(filename) || /^\.latest(?:$|[.-])/.test(filename)) {
    throw new TypeError('original filename is invalid');
  }
  return filename;
}

async function directory(path, create = false) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${path}`);
    if (!stat.isDirectory()) throw new Error(`Expected a directory: ${path}`);
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    await mkdir(path);
  }
}

async function regularFile(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${path}`);
  if (!stat.isFile()) throw new Error(`Expected a regular file: ${path}`);
  return stat;
}

async function prepareRoot(parent) {
  absolutePath(parent, 'folder');
  await directory(parent);
  const root = join(parent, storageName);
  let created = false;
  try {
    await directory(root);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(root);
    created = true;
  }
  const markerPath = join(root, markerName);
  if (!created) {
    const names = await readdir(root);
    if (!names.includes(markerName)) {
      if (names.length) throw new Error(`${root} is not managed by Sitenote`);
      await writeFile(markerPath, marker, { flag: 'wx' });
    } else {
      await regularFile(markerPath);
      if (await readFile(markerPath, 'utf8') !== marker) throw new Error(`${root} is not managed by Sitenote`);
    }
  } else {
    await writeFile(markerPath, marker, { flag: 'wx' });
  }
  for (const name of ['notes', 'originals']) await directory(join(root, name), true);
  return root;
}

async function existingRoot(parent) {
  const root = join(parent, storageName);
  try {
    await directory(parent);
    await directory(root);
    await regularFile(join(root, markerName));
    if (await readFile(join(root, markerName), 'utf8') !== marker) {
      throw new Error(`${root} is not managed by Sitenote`);
    }
    return root;
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

async function recoverNote(target) {
  const backup = `${target}.old`;
  let hasTarget = false;
  let hasBackup = false;
  try { await directory(target); hasTarget = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await directory(backup); hasBackup = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (hasTarget && hasBackup) await rm(backup, { recursive: true });
  else if (!hasTarget && hasBackup) await rename(backup, target);
  return hasTarget || hasBackup;
}

async function sourceFrom(root, id) {
  if (!root) return;
  const notes = join(root, 'notes');
  const folder = join(notes, noteKey(id));
  const path = join(folder, 'source.md');
  try {
    await directory(notes);
    if (!await recoverNote(folder)) return;
    await regularFile(path);
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

async function writeNote(root, entry, source) {
  const notes = join(root, 'notes');
  await directory(notes);
  const target = join(notes, noteKey(entry.id));
  const hadTarget = await recoverNote(target);
  const retainedSource = source === undefined && hadTarget ? await sourceFrom(root, entry.id) : source;
  const stage = await mkdtemp(join(notes, `.tmp-${noteKey(entry.id)}-`));
  const backup = `${target}.old`;
  try {
    await writeFile(join(stage, 'transcript.md'), entry['transcript.md'], { flag: 'wx' });
    if (entry['summary.md'] !== undefined) {
      await writeFile(join(stage, 'summary.md'), entry['summary.md'], { flag: 'wx' });
    }
    if (retainedSource !== undefined) await writeFile(join(stage, 'source.md'), retainedSource, { flag: 'wx' });
    if (hadTarget) await rename(target, backup);
    try {
      await rename(stage, target);
    } catch (error) {
      if (hadTarget) await rename(backup, target);
      throw error;
    }
    if (hadTarget) await rm(backup, { recursive: true });
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

function collisionName(filename, sequence) {
  if (sequence === 1) return filename;
  const extension = extname(filename);
  return `${filename.slice(0, filename.length - extension.length)}-${sequence}${extension}`;
}

async function recoverLatest(folder) {
  const latest = join(folder, '.latest');
  const backup = `${latest}.old`;
  let hadLatest = false;
  try {
    await regularFile(latest);
    hadLatest = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await regularFile(backup);
    if (hadLatest) await rm(backup);
    else {
      await rename(backup, latest);
      hadLatest = true;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return hadLatest ? latest : undefined;
}

async function recordLatest(folder, filename) {
  const latest = join(folder, '.latest');
  const backup = `${latest}.old`;
  const hadLatest = Boolean(await recoverLatest(folder));
  const temp = join(folder, `.latest-${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx');
  try {
    await handle.writeFile(filename);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (hadLatest) await rename(latest, backup);
  try {
    await rename(temp, latest);
  } catch (error) {
    if (hadLatest) await rename(backup, latest);
    throw error;
  }
  if (hadLatest) await rm(backup);
}

async function archive(root, id, filename, value) {
  const originals = join(root, 'originals');
  await directory(originals);
  const folder = join(originals, noteKey(id));
  await directory(folder, true);
  for (let sequence = 1; ; sequence += 1) {
    const path = join(folder, collisionName(filename, sequence));
    try {
      await regularFile(path);
      if ((await readFile(path)).equals(value)) {
        await recordLatest(folder, basename(path));
        return path;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const handle = await open(path, 'wx');
      try {
        await handle.writeFile(value);
        await handle.sync();
        await handle.close();
      } catch (error) {
        await handle.close().catch(() => {});
        await rm(path, { force: true });
        throw error;
      }
      await recordLatest(folder, basename(path));
      return path;
    }
  }
}

async function copyOriginals(fromRoot, toRoot) {
  if (!fromRoot || fromRoot === toRoot) return;
  const source = join(fromRoot, 'originals');
  await directory(source);
  for (const key of await readdir(source)) {
    const sourceFolder = join(source, key);
    await directory(sourceFolder);
    const targetFolder = join(toRoot, 'originals', key);
    await directory(targetFolder, true);
    const copiedNames = new Map();
    const latest = await recoverLatest(sourceFolder);
    for (const name of await readdir(sourceFolder)) {
      if (/^\.latest(?:$|[.-])/.test(name)) continue;
      const sourceFile = join(sourceFolder, name);
      await regularFile(sourceFile);
      const bytes = await readFile(sourceFile);
      for (let sequence = 1; ; sequence += 1) {
        const candidate = join(targetFolder, collisionName(name, sequence));
        try {
          await regularFile(candidate);
          if ((await readFile(candidate)).equals(bytes)) {
            copiedNames.set(name, basename(candidate));
            break;
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          try {
            await copyFile(sourceFile, candidate, constants.COPYFILE_EXCL);
          } catch (copyError) {
            if (copyError.code !== 'EEXIST') await rm(candidate, { force: true });
            throw copyError;
          }
          copiedNames.set(name, basename(candidate));
          break;
        }
      }
    }
    if (latest) {
      const latestName = validFilename((await readFile(latest, 'utf8')).trim());
      if (!copiedNames.has(latestName)) throw new Error(`Invalid original archive metadata: ${latest}`);
      await recordLatest(targetFolder, copiedNames.get(latestName));
    }
  }
}

function createNoteFiles({ profile, defaultFolder }) {
  absolutePath(profile, 'profile');
  absolutePath(defaultFolder, 'defaultFolder');
  const config = join(profile, 'note-files.json');
  const configBackup = `${config}.old`;
  let folder = defaultFolder;
  try {
    let hasConfig = false;
    let hasBackup = false;
    try { hasConfig = lstatSync(config).isFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { hasBackup = lstatSync(configBackup).isFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (hasConfig && hasBackup) rmSync(configBackup);
    else if (!hasConfig && hasBackup) renameSync(configBackup, config);
    const stat = lstatSync(config);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe config');
    const saved = JSON.parse(readFileSync(config, 'utf8'));
    folder = absolutePath(saved.folder, 'configured folder');
  } catch {}

  const status = () => ({ folder, root: join(folder, storageName) });

  async function persist(next) {
    await directory(profile, true);
    try {
      const stat = await lstat(config);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Refusing unsafe note-files config');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const temp = join(profile, `.note-files-${randomUUID()}.tmp`);
    const backup = configBackup;
    await writeFile(temp, JSON.stringify({ folder: next }) + '\n', { flag: 'wx' });
    try {
      let hadConfig = false;
      try {
        await rename(config, backup);
        hadConfig = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      try {
        await rename(temp, config);
      } catch (error) {
        if (hadConfig) await rename(backup, config);
        throw error;
      }
      if (hadConfig) await rm(backup, { force: true }).catch(() => {});
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async function sync(entries, deletedIds = []) {
    if (!Array.isArray(entries) || !Array.isArray(deletedIds)) throw new TypeError('entries and deletedIds must be arrays');
    entries.forEach(validEntry);
    deletedIds.forEach(validId);
    const ids = new Set(entries.map((entry) => entry.id));
    if (ids.size !== entries.length || deletedIds.some((id) => ids.has(id))) throw new TypeError('duplicate note id');
    const root = await prepareRoot(folder);
    for (const entry of entries) await writeNote(root, entry);
    for (const id of deletedIds) {
      const target = join(root, 'notes', noteKey(id));
      try {
        if (await recoverNote(target)) await rm(target, { recursive: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  async function chooseFolder(next, snapshotEntries) {
    absolutePath(next, 'folder');
    if (!Array.isArray(snapshotEntries)) throw new TypeError('snapshotEntries must be an array');
    snapshotEntries.forEach(validEntry);
    const ids = new Set(snapshotEntries.map((entry) => entry.id));
    if (ids.size !== snapshotEntries.length) throw new TypeError('duplicate note id');
    const oldRoot = await existingRoot(folder);
    const nextRoot = await prepareRoot(next);
    await copyOriginals(oldRoot, nextRoot);
    for (const entry of snapshotEntries) {
      await writeNote(nextRoot, entry, await sourceFrom(oldRoot, entry.id));
    }
    await persist(next);
    folder = next;
    return { folder };
  }

  async function saveImport(entry, filename, bytes, markdown) {
    validEntry(entry);
    validFilename(filename);
    if (!(bytes instanceof Uint8Array)) throw new TypeError('original bytes must be a Uint8Array');
    if (typeof markdown !== 'string') throw new TypeError('converted Markdown must be a string');
    const root = await prepareRoot(folder);
    const originalFolder = join(root, 'originals', noteKey(entry.id));
    let firstImport = false;
    try { await directory(originalFolder); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(originalFolder, {mode:0o700});
      firstImport = true;
    }
    try {
      const path = await archive(root, entry.id, filename, Buffer.from(bytes));
      await writeNote(root, entry, markdown);
      return { path };
    } catch (error) {
      if (firstImport) await rm(originalFolder, {recursive:true,force:true}).catch(() => {});
      throw error;
    }
  }

  async function revealOriginal(id) {
    const key = noteKey(id);
    const root = await existingRoot(folder);
    if (!root) return;
    const originals = join(root, 'originals');
    await directory(originals);
    const originalFolder = join(originals, key);
    try {
      await directory(originalFolder);
      const latest = await recoverLatest(originalFolder);
      if (!latest) return;
      await regularFile(latest);
      const name = validFilename((await readFile(latest, 'utf8')).trim());
      const path = join(originalFolder, name);
      await regularFile(path);
      return path;
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }

  return { status, chooseFolder, sync, saveImport, revealOriginal };
}

module.exports = { createNoteFiles };
