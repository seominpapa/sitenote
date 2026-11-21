const { randomUUID } = require('node:crypto');
const { constants } = require('node:fs');
const { lstat, open } = require('node:fs/promises');
const { basename, extname } = require('node:path');
const { ownedPage } = require('./runtime.cjs');
const { convertDocument, documentExtensions, maxDocumentBytes, maxDocumentTextLength } = require('./document-import.cjs');

const noteId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const documentTypes = documentExtensions.filter(type => type !== 'doc');
const validFilename = name => name.length <= 255 && !/[\\/:\p{Cc}]/u.test(name) &&
  documentTypes.includes(extname(name).slice(1).toLowerCase());
const validEntry = value => value && typeof value === 'object' && !Array.isArray(value) && noteId(value.id) &&
  typeof value['transcript.md'] === 'string' && value['transcript.md'].length <= 16_000_000 &&
  (value['summary.md'] === undefined || (typeof value['summary.md'] === 'string' && value['summary.md'].length <= 1_000_000)) &&
  Object.keys(value).every(key => ['id', 'transcript.md', 'summary.md'].includes(key));
const validEntries = items => Array.isArray(items) && items.length <= 20_000 && items.every(validEntry);
const validDeletion = items => Array.isArray(items) && items.length <= 20_000 && items.every(noteId);
const invalid = () => Error('허용되지 않는 노트 저장 요청입니다.');
const sizeMessage = '파일은 20MB, 변환할 본문은 25만 자까지 가져올 수 있습니다.';

async function readSelectedDocument(path) {
  const filename = basename(path);
  if (!validFilename(filename)) throw Error('MD, TXT, DOCX, HWP 또는 HWPX 파일을 선택해 주세요.');
  const selected = await lstat(path);
  if (!selected.isFile() || selected.isSymbolicLink()) throw Error('일반 문서 파일을 선택해 주세요.');
  if (selected.size > maxDocumentBytes) throw Error(sizeMessage);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.dev !== selected.dev || stats.ino !== selected.ino) throw Error('문서 파일이 변경되었습니다. 다시 선택해 주세요.');
    if (stats.size > maxDocumentBytes) throw Error(sizeMessage);
    const bytes = Buffer.allocUnsafe(stats.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const {bytesRead} = await file.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stats.size || (await file.stat()).mtimeMs !== stats.mtimeMs) throw Error('문서 파일이 변경되었습니다. 다시 선택해 주세요.');
    return {filename, bytes:bytes.subarray(0,size)};
  } finally { await file.close(); }
}

function importError(error) {
  const message = String(error?.message ?? '');
  if (error?.code === 'DOCUMENT_IMPORT_ERROR') {
    if (/too large/.test(message)) return Error(sizeMessage);
    if (/protected|encrypted/.test(message)) return Error('암호가 걸렸거나 보호된 문서는 가져올 수 없습니다.');
    if (/image-only|no readable/.test(message)) return Error('읽을 수 있는 본문이 없습니다. 이미지로만 된 문서는 변환할 수 없습니다.');
    return Error('문서를 읽을 수 없습니다. 지원 형식과 파일 상태를 확인해 주세요.');
  }
  return error?.code ? Error('파일을 읽을 수 없습니다. 파일 위치와 읽기 권한을 확인해 주세요.') : error;
}

function registerNoteIpc(ipc, getWindow, disk, showDialog, reveal) {
  let draft;
  let pending = Promise.resolve();
  const operations = {
    status: [() => disk.status(), args => !args.length],
    choose: [async (window, entries) => {
      const result = await showDialog(window, {title:'노트 저장 폴더 선택', properties:['openDirectory', 'createDirectory']});
      if (result.canceled || result.filePaths.length !== 1) return;
      try {
        await disk.chooseFolder(result.filePaths[0], entries);
        return disk.status();
      } catch { throw Error('새 폴더로 노트와 원본을 복사하지 못했습니다. 현재 폴더와 새 폴더의 연결 상태 및 쓰기 권한을 확인해 주세요.'); }
    }, args => args.length === 1 && validEntries(args[0])],
    sync: [async (_window, entries, deletedIds) => {
      try { await disk.sync(entries, deletedIds); }
      catch { throw Error('노트 저장 폴더를 갱신하지 못했습니다.'); }
    }, args => args.length >= 1 && args.length <= 2 && validEntries(args[0]) && (args[1] === undefined || validDeletion(args[1]))],
    pick: [async window => {
      draft = undefined;
      const result = await showDialog(window, {title:'회의 문서 선택', properties:['openFile'],
        filters:[{ name:'회의 문서', extensions:documentTypes }]});
      if (result.canceled || result.filePaths.length !== 1) return;
      try {
        const {filename, bytes} = await readSelectedDocument(result.filePaths[0]);
        const markdown = await convertDocument(filename, bytes);
        const id = randomUUID();
        draft = {id, filename, bytes, markdown, contents:window.webContents};
        return {id, filename, markdown};
      } catch (error) { throw importError(error); }
    }, args => !args.length],
    'save-import': [async (window, entry) => {
      if (!draft || draft.contents !== window.webContents || draft.id !== entry.id ||
          entry['transcript.md'].length > maxDocumentTextLength * 4 || entry['summary.md'] !== undefined) throw invalid();
      const {filename, bytes, markdown} = draft;
      try { await disk.saveImport(entry, filename, bytes, markdown); }
      catch { throw Error('지정한 폴더에 원본 문서를 보관하지 못했습니다. 저장 폴더와 권한을 확인해 주세요.'); }
      finally { draft = undefined; }
    }, args => args.length === 1 && validEntry(args[0])],
    reveal: [async (_window, id) => {
      try {
        const path = await disk.revealOriginal(id);
        if (!path) return false;
        reveal(path);
        return true;
      } catch { return false; }
    }, args => args.length === 1 && noteId(args[0])],
  };
  for (const [name, [run, accepts]] of Object.entries(operations)) {
    ipc.handle('sitenote:notes-' + name, async (event, ...args) => {
      const window = getWindow();
      const contents = window?.webContents;
      const trusted = () => contents && contents === getWindow()?.webContents && event.sender === contents &&
        event.senderFrame && event.senderFrame === contents.mainFrame && ownedPage(event.senderFrame.url);
      if (!trusted() || !accepts(args)) throw invalid();
      const task = pending.then(() => {
        if (!trusted()) throw invalid();
        return run(window, ...args);
      });
      pending = task.catch(() => {});
      return task;
    });
  }
}

module.exports = { registerNoteIpc };
