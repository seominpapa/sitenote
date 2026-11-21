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
const folderName = title => `20261121_${title}`;
const notePath = (folder, title, filename) => join(folder, 'Sitenote', 'notes', folderName(title), filename);
const originalPath = (folder, title) => join(folder, 'Sitenote', 'originals', folderName(title), 'original.txt');
const entry = (id, transcript, fields = {}) => ({ id, folderName:folderName(id), 'transcript.md':transcript, ...fields });

test('sync atomically materializes notes and applies updates and deletions', async () => {
  const { folder, files } = await fixture();
  assert.deepEqual(files.status(), { folder, root: join(folder, 'Sitenote') });

  await files.sync([
    entry('one', '# One', {'summary.md':'Short'}),
    entry('two', '# Two'),
  ]);
  assert.equal(await readFile(notePath(folder, 'one', 'transcript.md'), 'utf8'), '# One');
  assert.equal(await readFile(notePath(folder, 'one', 'summary.md'), 'utf8'), 'Short');

  await files.sync([entry('one', '# Updated')], ['two']);
  assert.equal(await readFile(notePath(folder, 'one', 'transcript.md'), 'utf8'), '# Updated');
  assert.deepEqual(await readdir(join(folder, 'Sitenote', 'notes')), [folderName('one')]);
  await assert.rejects(readFile(notePath(folder, 'one', 'summary.md')));
});

test('import creates only the Markdown and text archive in the public folders; exact bytes stay private', async () => {
  const { folder, profile, files } = await fixture();
  const original = Buffer.from([0, 255, 1, 2, 3]);
  const first = await files.saveImport(
    entry('imported', '# Converted\n\nHeading and body'),
    'field.docx', original,
  );
  assert.equal(await readFile(first.path).then((value) => value.equals(original)), true);
  assert.equal(first.path.startsWith(profile + '/'), true);
  assert.equal(await readFile(notePath(folder, 'imported', 'transcript.md'), 'utf8'), '# Converted\n\nHeading and body');
  assert.deepEqual(await readdir(notePath(folder, 'imported', '')), ['transcript.md']);
  assert.equal(await readFile(originalPath(folder, 'imported'), 'utf8'), '# Converted\n\nHeading and body');
  assert.deepEqual(await readdir(join(originalPath(folder, 'imported'), '..')), ['original.txt']);
  assert.equal(await files.revealOriginal('imported'), first.path);

  const duplicate = await files.saveImport(
    entry('imported', '# Converted'),
    'field.docx', original,
  );
  assert.equal(duplicate.path, first.path);

  const second = await files.saveImport(
    entry('imported', '# Converted again'),
    'field.docx', Buffer.from('different'),
  );
  assert.notEqual(second.path, first.path);
  assert.equal(basename(second.path), 'field-2.docx');
  assert.equal(await readFile(first.path).then((value) => value.equals(original)), true);
  assert.equal(await files.revealOriginal('imported'), second.path);

  await files.sync([entry('imported', '# Later edit',{imported:true,'summary.md':'App only'})]);
  assert.equal(await readFile(notePath(folder, 'imported', 'transcript.md'), 'utf8'), '# Later edit');
  assert.deepEqual(await readdir(notePath(folder, 'imported', '')), ['transcript.md']);
  const latest = join(second.path, '..', '.latest');
  await rename(latest, `${latest}.old`);
  assert.equal(await files.revealOriginal('imported'), second.path);

  await files.sync([], ['imported']);
  assert.equal(await readFile(originalPath(folder, 'imported'), 'utf8'), '# Later edit');
  assert.equal(await readFile(first.path).then((value) => value.equals(original)), true);
  assert.equal(await files.revealOriginal('imported'), second.path);
});

test('chooseFolder projects the new snapshot and text archive without touching the previous folder', async () => {
  const { root, folder, files } = await fixture();
  const moving = entry('move', '# Source', {imported:true});
  const imported = await files.saveImport(moving, 'source.pdf', Buffer.from('pdf bytes'));
  const next = join(root, 'next');
  await mkdir(next);
  const targetFiles = createNoteFiles({ profile: join(root, 'target-profile'), defaultFolder: next });
  await mkdir(join(root, 'target-profile'));
  await targetFiles.saveImport({...moving, 'transcript.md':'# Target'}, 'source.pdf', Buffer.from('target bytes'));

  assert.deepEqual(await files.chooseFolder(next, [{ ...moving, 'transcript.md': '# After' }]), { folder: next });
  assert.deepEqual(files.status(), { folder: next, root: join(next, 'Sitenote') });
  assert.equal(await readFile(notePath(folder, 'move', 'transcript.md'), 'utf8'), '# Source');
  assert.equal(await readFile(imported.path, 'utf8'), 'pdf bytes');
  assert.equal(await readFile(notePath(next, 'move', 'transcript.md'), 'utf8'), '# Target');
  assert.equal(await readFile(join(next,'Sitenote','notes',folderName('move')+'-2','transcript.md'), 'utf8'), '# After');
  assert.equal(await readFile(join(next,'Sitenote','originals',folderName('move')+'-2','original.txt'), 'utf8'), '# After');

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

test('legacy originals remain untouched and can be opened after changing the save folder', async () => {
  const { root, folder, files } = await fixture();
  await files.sync([]);
  const legacy = join(folder, 'Sitenote', 'originals', key('legacy'));
  const legacyNote = join(folder, 'Sitenote', 'notes', key('legacy'));
  await Promise.all([mkdir(legacy),mkdir(legacyNote)]);
  await Promise.all([writeFile(join(legacy,'legacy.docx'),'exact raw'),writeFile(join(legacy,'.latest'),'legacy.docx'),
    writeFile(join(legacyNote,'source.md'),'legacy markdown')]);
  assert.equal(await files.revealOriginal('legacy'),join(legacy,'legacy.docx'));
  const next = join(root,'new');
  await mkdir(next);
  await files.chooseFolder(next,[entry('legacy','converted',{imported:true})]);
  assert.equal(await readFile(await files.revealOriginal('legacy'),'utf8'),'exact raw');
  assert.equal(await readFile(join(legacyNote,'source.md'),'utf8'),'legacy markdown');
  assert.equal(await readFile(originalPath(next,'legacy'),'utf8'),'converted');
});

test('never deletes untracked files, directories, or a replacement folder', async () => {
  const { folder, files } = await fixture();
  await files.sync([entry('owner','transcript')]);
  const note = notePath(folder,'owner','');
  await writeFile(join(note,'unmanaged.txt'),'keep');
  await files.sync([],['owner']);
  assert.deepEqual(await readdir(note), ['unmanaged.txt']);
  await files.sync([entry('second','owned')]);
  const second = notePath(folder,'second','');
  await rename(second,`${second}-moved`);
  await mkdir(second);
  await writeFile(join(second,'transcript.md'),'not app owned');
  await files.sync([],['second']);
  assert.equal(await readFile(join(second,'transcript.md'),'utf8'),'not app owned');
});

test('same date and title get independent folders; renaming keeps the original linked', async () => {
  const { folder, files } = await fixture();
  const duplicate = {folderName:folderName('회의록')};
  await files.sync([entry('left','First',duplicate),entry('right','Second',duplicate)]);
  assert.equal(await readFile(notePath(folder,'회의록','transcript.md'),'utf8'),'First');
  assert.equal(await readFile(notePath(folder,'회의록-2','transcript.md'),'utf8'),'Second');

  const imported = entry('document','본문',{folderName:folderName('현장 회의'),imported:true});
  const saved = await files.saveImport(imported,'report.pdf',Buffer.from('original'));
  await files.sync([{...imported,folderName:folderName('수정한 제목')}]);
  assert.equal(await files.revealOriginal('document'),saved.path);
  assert.equal(await readFile(originalPath(folder,'수정한 제목'),'utf8'),'본문');
  await assert.rejects(readFile(originalPath(folder,'현장 회의')),{code:'ENOENT'});
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
  await assert.rejects(files.sync([entry('../escape','no')]));
  await assert.rejects(files.sync([entry('safe','no',{folderName:'20261121_../escape'})]));
  await assert.rejects(files.saveImport(
    entry('safe','no'), '../escape.pdf', Buffer.from('no'),
  ));
  await assert.rejects(files.saveImport(
    entry('safe','no'), '.latest', Buffer.from('no'),
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
  await symlink(outside, join(folder, 'Sitenote', 'originals', folderName('unsafe-original')));
  await assert.rejects(files.saveImport(
    entry('unsafe-original','no'), 'source.pdf', Buffer.from('no'),
  ), /symbolic link/i);
  await rm(join(folder, 'Sitenote', 'notes'), { recursive: true });
  await symlink(outside, join(folder, 'Sitenote', 'notes'));
  await assert.rejects(files.sync([entry('safe','no')]), /symbolic link/i);
  assert.deepEqual(await readdir(outside), []);
});
