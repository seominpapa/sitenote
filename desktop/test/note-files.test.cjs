const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { basename, join } = require('node:path');
const { test } = require('node:test');
const { createNoteFiles } = require('../note-files.cjs');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sitenote-files-'));
  const profile = join(root, 'profile');
  const folder = join(root, 'documents');
  await Promise.all([mkdir(profile), mkdir(folder)]);
  return { root, profile, folder, files: createNoteFiles({ profile, defaultFolder: folder }) };
}

const key = (id) => Buffer.from(id).toString('base64url');
const notePath = (folder, id, filename) => join(folder, 'Sitenote', 'notes', key(id), filename);

test('sync atomically materializes notes and applies updates and deletions', async () => {
  const { folder, files } = await fixture();
  assert.deepEqual(files.status(), { folder, root: join(folder, 'Sitenote') });

  await files.sync([
    { id: 'one', 'transcript.md': '# One', 'summary.md': 'Short' },
    { id: 'two', 'transcript.md': '# Two' },
  ]);
  assert.equal(await readFile(notePath(folder, 'one', 'transcript.md'), 'utf8'), '# One');
  assert.equal(await readFile(notePath(folder, 'one', 'summary.md'), 'utf8'), 'Short');

  await files.sync([{ id: 'one', 'transcript.md': '# Updated' }], ['two']);
  assert.equal(await readFile(notePath(folder, 'one', 'transcript.md'), 'utf8'), '# Updated');
  assert.deepEqual(await readdir(join(folder, 'Sitenote', 'notes')), [key('one')]);
  await assert.rejects(readFile(notePath(folder, 'one', 'summary.md')));
});

test('saveImport preserves exact originals, converted Markdown, and collision history', async () => {
  const { folder, files } = await fixture();
  const original = Buffer.from([0, 255, 1, 2, 3]);
  const first = await files.saveImport(
    { id: 'imported', 'transcript.md': '# Clean\n\nBody' },
    'field.docx', original, '# Converted\n\nHeading and body',
  );
  assert.equal(await readFile(first.path).then((value) => value.equals(original)), true);
  assert.equal(await readFile(notePath(folder, 'imported', 'source.md'), 'utf8'), '# Converted\n\nHeading and body');
  assert.equal(await files.revealOriginal('imported'), first.path);

  const duplicate = await files.saveImport(
    { id: 'imported', 'transcript.md': '# Clean' },
    'field.docx', original, '# Converted',
  );
  assert.equal(duplicate.path, first.path);

  const second = await files.saveImport(
    { id: 'imported', 'transcript.md': '# Clean again' },
    'field.docx', Buffer.from('different'), '# Converted again',
  );
  assert.notEqual(second.path, first.path);
  assert.equal(basename(second.path), 'field-2.docx');
  assert.equal(await readFile(first.path).then((value) => value.equals(original)), true);
  assert.equal(await files.revealOriginal('imported'), second.path);

  await files.sync([{ id: 'imported', 'transcript.md': '# Later edit' }]);
  assert.equal(await readFile(notePath(folder, 'imported', 'source.md'), 'utf8'), '# Converted again');

  const note = join(folder, 'Sitenote', 'notes', key('imported'));
  await rename(note, `${note}.old`);
  await files.sync([{ id: 'imported', 'transcript.md': '# Recovered edit' }]);
  assert.equal(await readFile(notePath(folder, 'imported', 'source.md'), 'utf8'), '# Converted again');
  const latest = join(folder, 'Sitenote', 'originals', key('imported'), '.latest');
  await rename(latest, `${latest}.old`);
  assert.equal(await files.revealOriginal('imported'), second.path);

  await files.sync([], ['imported']);
  assert.equal(await readFile(first.path).then((value) => value.equals(original)), true);
  assert.equal(await files.revealOriginal('imported'), second.path);
});

test('chooseFolder copies the snapshot and archives while leaving the previous folder untouched', async () => {
  const { root, folder, files } = await fixture();
  const entry = { id: 'move', 'transcript.md': '# Before' };
  const imported = await files.saveImport(entry, 'source.pdf', Buffer.from('pdf bytes'), '# Source');
  await files.saveImport(entry, 'source.pdf', Buffer.from('new pdf bytes'), '# Source');
  await files.saveImport(entry, 'source.pdf', Buffer.from('pdf bytes'), '# Source');
  const next = join(root, 'next');
  await mkdir(next);
  const targetFiles = createNoteFiles({ profile: join(root, 'target-profile'), defaultFolder: next });
  await mkdir(join(root, 'target-profile'));
  await targetFiles.saveImport(entry, 'source.pdf', Buffer.from('target bytes'), '# Target');

  assert.deepEqual(await files.chooseFolder(next, [{ ...entry, 'transcript.md': '# After' }]), { folder: next });
  assert.deepEqual(files.status(), { folder: next, root: join(next, 'Sitenote') });
  assert.equal(await readFile(notePath(folder, 'move', 'transcript.md'), 'utf8'), '# Before');
  assert.equal(await readFile(imported.path, 'utf8'), 'pdf bytes');
  assert.equal(await readFile(notePath(next, 'move', 'transcript.md'), 'utf8'), '# After');
  assert.equal(await readFile(notePath(next, 'move', 'source.md'), 'utf8'), '# Source');
  const targetOriginal = join(next, 'Sitenote', 'originals', key('move'), 'source.pdf');
  assert.equal(await readFile(targetOriginal, 'utf8'), 'target bytes');
  const archiveFolder = join(next, 'Sitenote', 'originals', key('move'));
  const copiedBytes = await Promise.all((await readdir(archiveFolder))
    .filter((name) => name !== '.latest').map((name) => readFile(join(archiveFolder, name), 'utf8')));
  assert.deepEqual(copiedBytes.sort(), ['new pdf bytes', 'pdf bytes', 'target bytes'].sort());

  const restarted = createNoteFiles({ profile: join(root, 'profile'), defaultFolder: folder });
  assert.deepEqual(restarted.status(), { folder: next, root: join(next, 'Sitenote') });
  assert.equal(await readFile(await restarted.revealOriginal('move'), 'utf8'), 'pdf bytes');
  const config = join(root, 'profile', 'note-files.json');
  await rename(config, `${config}.old`);
  const recovered = createNoteFiles({ profile: join(root, 'profile'), defaultFolder: folder });
  assert.deepEqual(recovered.status(), { folder: next, root: join(next, 'Sitenote') });

  const third = join(root, 'third');
  await mkdir(third);
  await writeFile(join(next, 'Sitenote', '.sitenote-storage-v1'), 'corrupt');
  await assert.rejects(files.chooseFolder(third, []), /not managed by Sitenote/i);
  assert.deepEqual(files.status(), { folder: next, root: join(next, 'Sitenote') });
});

test('corrupt configuration is ignored without operating on its folder', async () => {
  const { root, profile, folder } = await fixture();
  const trap = join(root, 'trap');
  await mkdir(trap);
  await writeFile(join(trap, 'sentinel'), 'untouched');
  await writeFile(join(profile, 'note-files.json'), JSON.stringify({ folder: trap }) + ' trailing data');

  const files = createNoteFiles({ profile, defaultFolder: folder });
  assert.deepEqual(files.status(), { folder, root: join(folder, 'Sitenote') });
  assert.deepEqual(await readdir(trap), ['sentinel']);
});

test('rejects traversal, symlinks, and an unrelated nonempty managed directory', async (t) => {
  const { root, folder, files } = await fixture();
  await assert.rejects(files.sync([{ id: '../escape', 'transcript.md': 'no' }]));
  await assert.rejects(files.saveImport(
    { id: 'safe', 'transcript.md': 'no' }, '../escape.pdf', Buffer.from('no'), 'no',
  ));
  await assert.rejects(files.saveImport(
    { id: 'safe', 'transcript.md': 'no' }, '.latest', Buffer.from('no'), 'no',
  ));

  const unrelated = join(root, 'unrelated');
  await mkdir(join(unrelated, 'Sitenote'), { recursive: true });
  await writeFile(join(unrelated, 'Sitenote', 'keep.txt'), 'keep');
  await assert.rejects(files.chooseFolder(unrelated, []), /not managed by Sitenote/i);
  assert.equal(await readFile(join(unrelated, 'Sitenote', 'keep.txt'), 'utf8'), 'keep');
  assert.deepEqual(files.status(), { folder, root: join(folder, 'Sitenote') });

  if (process.platform === 'win32') return t.skip('symlink creation requires elevated Windows privileges');
  const outside = join(root, 'outside');
  await mkdir(outside);
  await files.sync([]);
  await symlink(outside, join(folder, 'Sitenote', 'originals', key('unsafe-original')));
  await assert.rejects(files.saveImport(
    { id: 'unsafe-original', 'transcript.md': 'no' }, 'source.pdf', Buffer.from('no'), 'no',
  ), /symbolic link/i);
  await rm(join(folder, 'Sitenote', 'notes'), { recursive: true });
  await symlink(outside, join(folder, 'Sitenote', 'notes'));
  await assert.rejects(files.sync([{ id: 'safe', 'transcript.md': 'no' }]), /symbolic link/i);
  assert.deepEqual(await readdir(outside), []);
});
