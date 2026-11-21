const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { origin } = require('../runtime.cjs');
const { registerNoteIpc } = require('../note-ipc.cjs');
const { scanPdf } = require('./pdf-fixtures.cjs');

test('imports exact bytes from the OS picker; only trusted frames may save and reveal originals', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'sitenote-note-ipc-'));
  try {
    const callbacks = new Map();
    const contents = {mainFrame:{url:origin + '/'}};
    const window = {webContents:contents};
    const event = {sender:contents, senderFrame:contents.mainFrame};
    const original = join(parent, '정기 회의.md');
    const bytes = Buffer.from('# 안전 점검\r\n동쪽 출입구');
    await writeFile(original, bytes);
    const observed = [];
    const disk = {
      status:() => ({folder:parent}),
      chooseFolder:async (...args) => observed.push(['folder', ...args]),
      saveImport:async (...args) => observed.push(['save', ...args]),
      sync:async (...args) => observed.push(['sync', ...args]),
      revealOriginal:async () => original,
    };
    const dialog = async (_window, info) => ({canceled:false, filePaths:[info.properties.includes('openDirectory') ? parent : original]});
    registerNoteIpc({handle:(key, fn) => callbacks.set(key, fn)}, () => window, disk, dialog, (path) => observed.push(['reveal', path]));
    const call = (name, ...args) => callbacks.get('sitenote:notes-' + name)(event, ...args);
    await assert.rejects(callbacks.get('sitenote:notes-pick')({...event, senderFrame:{...contents.mainFrame}}), /허용되지/);
    await assert.rejects(call('pick', original), /허용되지/);
    await assert.rejects(call('reveal', '../unsafe'), /허용되지/);
    await assert.rejects(call('sync', [{id:'bad/path','transcript.md':'data'}]), /허용되지/);
    await assert.rejects(call('sync', [{id:'valid',folderName:'20261121_../other','transcript.md':'data'}]), /허용되지/);
    const picked = await call('pick');
    assert.deepEqual({...picked, id:undefined}, {id:undefined, filename:'정기 회의.md',markdown:'# 안전 점검\n동쪽 출입구'});
    assert.equal(typeof picked.id, 'string');
    await assert.rejects(call('save-import', {id:'other','transcript.md':'other'}), /허용되지/);
    const entry = {id:picked.id, folderName:'20261121_정기 회의', imported:true, 'transcript.md':picked.markdown};
    await call('save-import', entry);
    assert.deepEqual(observed[0], ['save',entry,picked.filename,bytes]);
    await assert.rejects(call('save-import', entry), /허용되지/);
    assert.equal(await call('reveal', picked.id), true);
    assert.deepEqual(observed[1], ['reveal',original]);
    assert.deepEqual(await call('choose', [entry]), {folder:parent});
    assert.deepEqual(observed[2], ['folder',parent,[entry]]);
    await call('sync', [], [picked.id]);
    assert.deepEqual(observed[3], ['sync',[],[picked.id]]);
  } finally { await rm(parent, {recursive:true, force:true}); }
});

test('rejects a scan PDF at file selection without creating an import draft', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'sitenote-scan-ipc-'));
  try {
    const filePath = join(parent, '회의 스캔.pdf');
    await writeFile(filePath, scanPdf());

    const callbacks = new Map();
    const contents = {mainFrame:{url:origin + '/'}};
    const event = {sender:contents, senderFrame:contents.mainFrame};
    let saves = 0;
    const disk = {saveImport:async () => { saves++; }};
    registerNoteIpc({handle:(key, fn) => callbacks.set(key, fn)}, () => ({webContents:contents}), disk,
      async (_parent, {filters}) => {
        assert.equal(filters[0].extensions.includes('pdf'), true);
        return {canceled:false, filePaths:[filePath]};
      }, () => {});
    await assert.rejects(callbacks.get('sitenote:notes-pick')(event), /스캔 PDF는 지원하지 않습니다/);
    await assert.rejects(callbacks.get('sitenote:notes-save-import')(event, {
      id:'empty-draft', folderName:'20261121_회의 스캔', imported:true, 'transcript.md':'내용',
    }), /허용되지/);
    assert.equal(saves, 0);
  } finally { await rm(parent, {recursive:true, force:true}); }
});
