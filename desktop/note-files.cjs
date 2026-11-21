const {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
  writeFile,
} = require('node:fs/promises');
const { lstatSync, readFileSync, renameSync, rmSync } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
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
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new TypeError('note id is invalid');
  }
  return value;
}

function noteKey(id) {
  return Buffer.from(validId(id)).toString('base64url');
}

function validFolderName(value) {
  return typeof value === 'string' && /^\d{8}_[^\\/:*?"<>|\p{Cc}]+$/u.test(value) &&
    !/[ .]$/.test(value) && Buffer.byteLength(value) <= 180;
}

function validEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('note entry is invalid');
  validId(entry.id);
  if (!validFolderName(entry.folderName)) throw new TypeError('note folder name is invalid');
  if (entry.imported !== undefined && entry.imported !== true) throw new TypeError('note import flag is invalid');
  if (typeof entry['transcript.md'] !== 'string') throw new TypeError('transcript.md must be a string');
  if (entry['summary.md'] !== undefined && typeof entry['summary.md'] !== 'string') {
    throw new TypeError('summary.md must be a string');
  }
  return entry;
}

function validFilename(filename) {
  if (typeof filename !== 'string' || !filename || filename === '.' || filename === '..'
      || filename !== basename(filename) || /[\\/:\p{Cc}]/u.test(filename) || /^\.latest(?:$|[.-])/.test(filename)) {
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

async function statIfPresent(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function replaceFile(path, value, exclusive = false) {
  if (exclusive) {
    const handle = await open(path,'wx',0o600);
    try { await handle.writeFile(value); }
    catch (error) {
      await handle.close().catch(() => {});
      await rm(path,{force:true});
      throw error;
    }
    await handle.close();
    return;
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, value, {flag:'wx', mode:0o600});
    await rename(temp, path);
  } finally { await rm(temp, {force:true}); }
}

const digest = (value) => createHash('sha256').update(value).digest('hex');
const identity = (stat) => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
const publicFiles = { notes:['transcript.md', 'summary.md'], originals:['original.txt'] };

async function readProjection(index, id) {
  const path = join(index, noteKey(id) + '.json');
  const stat = await statIfPresent(path);
  if (!stat) return;
  if (!stat.isFile()) throw new Error('Invalid note folder index');
  const item = JSON.parse(await readFile(path, 'utf8'));
  if (!validFolderName(item.requested) || !(item.name === item.requested ||
      (item.name?.startsWith(item.requested + '-') && /^\d{1,5}$/.test(item.name.slice(item.requested.length + 1))))) {
    throw new Error('Invalid note folder index');
  }
  return item;
}

async function ownsFile(path, hash) {
  const stat = await statIfPresent(path);
  return typeof hash === 'string' && stat?.isFile() && stat.nlink === 1 &&
    stat.size <= 64_000_000 && digest(await readFile(path)) === hash;
}

async function ownsFolder(path, entry) {
  const stat = await statIfPresent(path);
  return entry && stat?.isDirectory() && identity(stat) === entry.identity;
}

async function cleanProjection(root, previous, branch) {
  const managed = previous?.[branch];
  if (!managed) return;
  const parent = join(root,branch);
  await directory(parent);
  const path = join(parent,previous.name);
  if (!await ownsFolder(path, managed)) return;
  for (const name of publicFiles[branch]) {
    const file = join(path,name);
    if (await ownsFile(file, managed.files[name])) await rm(file);
  }
  await rmdir(path).catch(error => { if (!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code)) throw error; });
}

async function useProjection(root, entry, previous) {
  if (previous?.requested === entry.folderName &&
      await ownsFolder(join(root,'notes',previous.name),previous.notes) &&
      (!entry.imported || await ownsFolder(join(root,'originals',previous.name),previous.originals))) {
    for (const branch of entry.imported ? ['notes','originals'] : ['notes']) {
      for (const name of publicFiles[branch]) {
        const file = join(root,branch,previous.name,name);
        if (await statIfPresent(file) && !await ownsFile(file, previous[branch].files[name])) return;
      }
    }
    return previous;
  }
}

async function newProjection(root, entry) {
  for (let counter = 1; counter <= 10000; counter++) {
    const name = counter === 1 ? entry.folderName : `${entry.folderName}-${counter}`;
    const notes = join(root,'notes',name);
    const originals = join(root,'originals',name);
    const collisions = await Promise.all([statIfPresent(notes),statIfPresent(originals)]);
    if (collisions.some(stat => stat?.isSymbolicLink())) throw new Error('Refusing symbolic link in note folders');
    if (collisions.some(Boolean)) continue;
    try { await mkdir(notes, {mode:0o700}); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    try {
      if (entry.imported) await mkdir(originals, {mode:0o700});
      const owned = async path => ({identity:identity(await lstat(path)), files:{}});
      return {name,requested:entry.folderName,notes:await owned(notes),...(entry.imported && {originals:await owned(originals)})};
    } catch (error) {
      await rmdir(notes);
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Too many matching note folders');
}

async function writeProjectionFiles(root, projection, branch, contents) {
  const target = join(root,branch,projection.name);
  const managed = projection[branch];
  if (!await ownsFolder(target,managed)) throw new Error('Note folder changed while saving');
  const files = {};
  for (const name of publicFiles[branch]) {
    const path = join(target,name);
    const old = await statIfPresent(path);
    if (old && !await ownsFile(path,managed.files[name])) throw new Error('Note file changed while saving');
    if (contents[name] === undefined) {
      if (old) await rm(path);
    } else {
      files[name] = digest(contents[name]);
      if (!old || files[name] !== managed.files[name]) await replaceFile(path, contents[name], !old);
    }
  }
  return {...managed,files};
}

async function writeNote(root, index, entry) {
  const previous = await readProjection(index,entry.id);
  const projection = await useProjection(root,entry,previous) ?? await newProjection(root,entry);
  let progress = projection;
  try {
    progress = {...progress,notes:await writeProjectionFiles(root,projection,'notes',{
      'transcript.md':entry['transcript.md'], 'summary.md':entry.imported ? undefined : entry['summary.md'],
    })};
    if (entry.imported) progress = {...progress,originals:await writeProjectionFiles(root,projection,'originals',{'original.txt':entry['transcript.md']})};
    await replaceFile(join(index,noteKey(entry.id)+'.json'),JSON.stringify(progress));
  } catch (error) {
    if (projection !== previous) {
      await cleanProjection(root,progress,'notes').catch(() => {});
      await cleanProjection(root,progress,'originals').catch(() => {});
    }
    throw error;
  }
  if (previous && previous.name !== projection.name) {
    await cleanProjection(root,previous,'notes');
    await cleanProjection(root,previous,'originals');
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
      const handle = await open(path, 'wx', 0o600);
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

async function originalAt(root, id) {
  if (!root) return;
  const originals = join(root,'originals');
  const folder = join(originals,noteKey(id));
  try {
    await directory(root);
    await directory(originals);
    await directory(folder);
    const latest = await recoverLatest(folder);
    if (!latest) return;
    const name = validFilename((await readFile(latest,'utf8')).trim());
    const path = join(folder,name);
    await regularFile(path);
    return path;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function indexFor(profile, root) {
  await directory(profile,true);
  const indices = join(profile,'note-projections');
  await directory(indices,true);
  const stat = await lstat(root);
  const index = join(indices,digest(identity(stat)));
  await directory(index,true);
  return index;
}

function createNoteFiles({ profile, defaultFolder }) {
  absolutePath(profile, 'profile');
  absolutePath(defaultFolder, 'defaultFolder');
  const config = join(profile, 'note-files.json');
  const configBackup = `${config}.old`;
  const rawArchive = join(profile,'note-documents');
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
    const index = await indexFor(profile,root);
    for (const entry of entries) await writeNote(root,index,entry);
    for (const id of deletedIds) {
      const previous = await readProjection(index,id);
      if (previous) await cleanProjection(root,previous,'notes');
      await rm(join(index,noteKey(id)+'.json'),{force:true});
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
    const index = await indexFor(profile,nextRoot);
    for (const entry of snapshotEntries) {
      if (oldRoot !== nextRoot && entry.imported && !await originalAt(rawArchive,entry.id)) {
        const legacy = await originalAt(oldRoot,entry.id);
        if (legacy) await saveOriginal(entry.id,basename(legacy),await readFile(legacy));
      }
      await writeNote(nextRoot,index,entry);
    }
    await persist(next);
    folder = next;
    return { folder };
  }

  async function saveOriginal(id, filename, bytes) {
    await directory(profile,true);
    await directory(rawArchive,true);
    await directory(join(rawArchive,'originals'),true);
    return archive(rawArchive,id,filename,bytes);
  }

  async function saveImport(entry, filename, bytes) {
    validEntry(entry);
    validFilename(filename);
    if (!(bytes instanceof Uint8Array)) throw new TypeError('original bytes must be a Uint8Array');
    const root = await prepareRoot(folder);
    const index = await indexFor(profile,root);
    const path = await saveOriginal(entry.id,filename,Buffer.from(bytes));
    await writeNote(root,index,{...entry,imported:true});
    return {path};
  }

  async function revealOriginal(id) {
    validId(id);
    return await originalAt(rawArchive,id) ?? originalAt(await existingRoot(folder),id);
  }

  return { status, chooseFolder, sync, saveImport, revealOriginal };
}

module.exports = { createNoteFiles, validFolderName };
