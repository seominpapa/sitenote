import type { FileName } from '../src/records/store.ts';
import { buildNoteExport, buildNotesExport, noteFolderName, readableSummary, readableTranscript } from '../src/records/export.ts';
import { parseSummary, parseTranscript, summaryMarkdown, transcriptMarkdown } from '../src/records/markdown.ts';
import { assertId, isCategoryPath, safeId, type RecordData } from '../src/records/model.ts';
import { buildSummarySpeakerLabels } from '../src/records/summary-speakers.ts';
import { noteFiles, type NoteFilesEntry, type StoredRecord } from './note-files.ts';

type StorageIssue = { id: string; file: FileName; cause: unknown };
type Guard = (action: () => void) => void;

const librarySignal = 'sitenote:library-change';
let libraryChannel: BroadcastChannel | undefined;

export function watchLibrary(listener: () => void) {
  if (typeof BroadcastChannel === 'function') {
    try { libraryChannel ??= new BroadcastChannel(librarySignal); } catch { /* Storage events below. */ }
  }
  if (libraryChannel) {
    const channel = libraryChannel;
    channel.addEventListener('message', listener);
    return () => channel.removeEventListener('message', listener);
  }
  const storage = (event: StorageEvent) => { if (event.key === librarySignal) listener(); };
  window.addEventListener('storage', storage);
  window.addEventListener('focus', listener);
  return () => {
    window.removeEventListener('storage', storage);
    window.removeEventListener('focus', listener);
  };
}

function libraryChanged() {
  try {
    if (libraryChannel) libraryChannel.postMessage(null);
    else localStorage.setItem(librarySignal, crypto.randomUUID());
  } catch { /* The database committed; notifications are only a cache hint. */ }
}

let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  const opened = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('sitenote', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('markdown', { keyPath: 'id' });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
  });
  database = opened.catch(error => { database = undefined; throw error; });
  return database;
}

async function useStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore, result: (value: T) => void, guard: Guard) => void) {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction('markdown', mode);
    let value: T;
    transaction.oncomplete = () => resolve(value);
    transaction.onabort = () => reject(transaction.error ?? Error('브라우저에 기록을 저장하지 못했습니다.'));
    const guard: Guard = action => {
      try { action(); }
      catch (error) { reject(error); transaction.abort(); }
    };
    guard(() => operation(transaction.objectStore('markdown'), result => { value = result; }, guard));
  });
}

export async function deleteRecords(ids: readonly string[]): Promise<void> {
  const keys = [...new Set(ids)];
  keys.forEach(assertId);
  if (!keys.length) return;
  await useStore<void>('readwrite', store => {
    for (const id of keys) store.delete(id);
  });
  libraryChanged();
  await writeNoteFiles([], keys);
}

function parseStored(entry: StoredRecord | undefined, onIssue?: (issue: StorageIssue) => void): RecordData | undefined {
  if (!entry) return;
  let record;
  try {
    if (typeof entry['transcript.md'] !== 'string') throw Error('발언 원문이 없습니다.');
    record = parseTranscript(entry['transcript.md']);
    if (record.id !== entry.id) throw Error('저장소 키와 기록 ID가 일치하지 않습니다.');
  } catch (cause) {
    if (!onIssue) throw Error(`기록 ${entry.id}을(를) 열 수 없습니다.`, {cause});
    onIssue({id:entry.id, file:'transcript.md', cause});
    return;
  }
  if (entry['summary.md'] !== undefined) {
    try { return {...record, ...parseSummary(entry['summary.md'])}; }
    catch (cause) { onIssue?.({id:entry.id, file:'summary.md', cause}); }
  }
  return record;
}

function withRecord<T>(id: string, mode: IDBTransactionMode, action: (record: StoredRecord | undefined, store: IDBObjectStore) => T) {
  assertId(id);
  return useStore<T>(mode, (store, result, guard) => {
    const request = store.get(id);
    request.onsuccess = () => guard(() => result(action(request.result as StoredRecord | undefined, store)));
  });
}

function noteFilesEntry(record: RecordData, importMarkdown?: string): NoteFilesEntry {
  const summary = record.originalFilename ? undefined : readableSummary(record);
  return {id:record.id, folderName:noteFolderName(record), 'transcript.md':readableTranscript(record, importMarkdown),
    ...(record.originalFilename && {imported:true}), ...(summary && {'summary.md':summary})};
}

function projectNoteFile(entry: StoredRecord | undefined) {
  if (!entry || !safeId.test(entry.id)) return;
  const record = parseStored(entry, () => {});
  if (record) return noteFilesEntry(record, typeof entry.importMarkdown === 'string' ? entry.importMarkdown : undefined);
}

function snapshotEntries() {
  return useStore<NoteFilesEntry[]>('readonly', (store, result) => {
    const request = store.getAll();
    request.onsuccess = () => result(request.result.map(projectNoteFile).filter((entry: NoteFilesEntry | undefined): entry is NoteFilesEntry => !!entry));
  });
}

const deletedFilesPrefix = 'sitenote:deleted-note-file:';
export const noteFileError = 'sitenote:note-file-error';
let pendingFiles: Promise<unknown> = Promise.resolve();
function queueNoteFiles<T>(task: () => Promise<T>) {
  const next = pendingFiles.then(task);
  pendingFiles = next.catch(() => {});
  return next;
}

function writeNoteFiles(ids: readonly string[], deletions: readonly string[] = []) {
  const desktop = noteFiles();
  if (!desktop || (!ids.length && !deletions.length)) return;
  return queueNoteFiles(async () => {
    for (const id of deletions) localStorage.setItem(deletedFilesPrefix + id, '1');
    const latest = await Promise.all(ids.map(id => withRecord(id, 'readonly', projectNoteFile)));
    await desktop.sync(latest.filter((entry): entry is NoteFilesEntry => !!entry), deletions);
    for (const id of deletions) localStorage.removeItem(deletedFilesPrefix + id);
  }).catch(() => {
    window.dispatchEvent(new CustomEvent(noteFileError, {detail:deletions.length ? 'delete' : 'save'}));
  });
}

async function syncSnapshot() {
  const desktop = noteFiles();
  if (!desktop) return;
  const entries = await snapshotEntries();
  const liveIds = new Set(entries.map(entry => entry.id));
  const deletedIds = Object.keys(localStorage).filter(key => key.startsWith(deletedFilesPrefix))
    .map(key => key.slice(deletedFilesPrefix.length)).filter(id => safeId.test(id) && !liveIds.has(id));
  for (const id of deletedIds) {
    await desktop.sync([], [id]);
    localStorage.removeItem(deletedFilesPrefix + id);
  }
  for (const entry of entries) await desktop.sync([entry]);
}

export function refreshNoteFiles() {
  return queueNoteFiles(syncSnapshot);
}

export async function chooseNoteFolder() {
  const desktop = noteFiles();
  if (!desktop) return;
  return queueNoteFiles(async () => {
    return desktop.chooseFolder(await snapshotEntries());
  });
}

export async function saveImportedRecord(record: RecordData, importMarkdown: string) {
  const desktop = noteFiles();
  if (!desktop) throw Error('데스크톱 앱에서 문서를 가져올 수 있습니다.');
  const entry = {id:record.id, 'transcript.md':transcriptMarkdown(record), importMarkdown};
  await useStore<void>('readwrite', store => { store.add(entry); });
  try {
    await queueNoteFiles(() => desktop.saveImport(noteFilesEntry(record, importMarkdown)));
  } catch (error) {
    await useStore<void>('readwrite', store => { store.delete(record.id); });
    throw error;
  }
  libraryChanged();
}

const version = (record: RecordData) => new Date(Math.max(Date.now(), Date.parse(record.updatedAt) + 1)).toISOString();

export const records = {
  async list(onIssue: (issue: StorageIssue) => void = () => {}) {
    const snapshot = await useStore<StoredRecord[]>('readonly', (store, result) => {
      const request = store.getAll();
      request.onsuccess = () => result(request.result);
    });
    return snapshot.flatMap(entry => {
      if (entry.id === categoryUndoId) return [];
      const record = parseStored(entry, onIssue);
      return record ? [record] : [];
    }).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  },
  load: (id: string) => withRecord(id, 'readonly', entry => parseStored(entry)),
  async create(record: RecordData) {
    assertId(record.id);
    await useStore<void>('readwrite', store => { store.add({id:record.id, 'transcript.md':transcriptMarkdown(record)}); });
    libraryChanged();
    await writeNoteFiles([record.id]);
  },
  update: (id: string, edit: (latest: RecordData) => RecordData) => withRecord(id, 'readwrite', (entry, store) => {
    const latest = parseStored(entry);
    if (!latest) return;
    const candidate = edit(latest);
    if (candidate === latest) return {record:latest, changed:false};
    if (candidate.id !== id) throw Error('수정할 기록 ID가 올바르지 않습니다.');
    const updated = {...candidate, updatedAt:version(latest)};
    store.put({...entry, 'transcript.md':transcriptMarkdown(updated)});
    return {record:updated, changed:true};
  }).then(async result => {
    if (result?.changed) {
      libraryChanged();
      await writeNoteFiles([id]);
    }
    return result?.record;
  }),
  saveSummary: (base: RecordData, markdown: string, questions: string[]) => withRecord(base.id, 'readwrite', (entry, store) => {
    const latest = parseStored(entry);
    if (!latest || latest.updatedAt !== base.updatedAt || latest.summary !== base.summary ||
      JSON.stringify(latest.questions) !== JSON.stringify(base.questions)) return;
    const summarySpeakerLabels = latest.kind === 'meeting' ? buildSummarySpeakerLabels(base) : undefined;
    const {summaryNeedsSpeakerRefresh:_stale,...record} = latest;
    store.put({...entry, ...(latest.summaryNeedsSpeakerRefresh && {'transcript.md':transcriptMarkdown(record)}),
      'summary.md':summaryMarkdown(markdown, questions, summarySpeakerLabels)});
    return {...record, summary:markdown, questions, summarySpeakerLabels};
  }).then(async record => {
    if (record) {
      libraryChanged();
      await writeNoteFiles([record.id]);
    }
    return record;
  }),
};

const foldersKey = 'sitenote:folders';

export function loadFolders(): string[][] {
  try {
    const paths: unknown = JSON.parse(localStorage.getItem(foldersKey) ?? '[]');
    if (Array.isArray(paths) && paths.every(isCategoryPath)) return paths;
  } catch {}
  throw Error('이 브라우저에서 폴더 목록을 읽지 못했습니다.');
}

export function saveFolders(paths: string[][]): void {
  try { localStorage.setItem(foldersKey, JSON.stringify(paths)); }
  catch { throw Error('이 브라우저에 폴더 목록을 저장하지 못했습니다.'); }
  libraryChanged();
}

export type CategoryUndoEntry = { id: string; path: string[]; updatedAt: string };
const categoryUndoKey = 'sitenote:category-undo';
// Invalid as a note ID, without changing the Markdown store schema for existing tabs.
const categoryUndoId = '_category-undo';
type UndoJournal = { id: typeof categoryUndoId; entries: CategoryUndoEntry[] };

function isUndoEntry(value: unknown): value is CategoryUndoEntry {
  if (!value || typeof value !== 'object') return false;
  const {id, path, updatedAt} = value as Partial<CategoryUndoEntry>;
  return typeof id === 'string' && safeId.test(id) && isCategoryPath(path) &&
    typeof updatedAt === 'string' && Number.isFinite(Date.parse(updatedAt));
}

function legacyCategoryUndo(): CategoryUndoEntry[] {
  try {
    const entries: unknown = JSON.parse(localStorage.getItem(categoryUndoKey) ?? '[]');
    if (Array.isArray(entries) && entries.every(isUndoEntry)) return entries;
  } catch {}
  throw Error('AI 분류 되돌리기 정보를 읽지 못했습니다.');
}

function readUndo(value: UndoJournal | undefined) {
  if (!value) return legacyCategoryUndo();
  if (!Array.isArray(value.entries) || !value.entries.every(isUndoEntry)) throw Error('AI 분류 되돌리기 정보를 읽지 못했습니다.');
  return value.entries;
}

export function loadCategoryUndo() {
  return useStore<CategoryUndoEntry[]>('readonly', (store, result, guard) => {
    const request = store.get(categoryUndoId);
    request.onsuccess = () => guard(() => result(readUndo(request.result)));
  });
}

export const sameCategory = (left?: readonly string[], right?: readonly string[]) =>
  left === right || (!!left && !!right && left.length === right.length && left.every((label,index)=>label === right[index]));

type CategoryChange = { records: RecordData[]; entries: CategoryUndoEntry[]; stale?: boolean };

function editCategoryBatch(ids: string[], edit: (note: RecordData) => RecordData | undefined,
  expected?: readonly CategoryUndoEntry[]) {
  ids.forEach(assertId);
  return useStore<CategoryChange>('readwrite', (store, result, guard) => {
    const requests = ids.map(id => store.get(id));
    const journal = store.get(categoryUndoId);
    journal.onsuccess = () => guard(() => {
      const entries = readUndo(journal.result);
      if (expected && JSON.stringify(expected) !== JSON.stringify(entries)) {
        result({records:[], entries, stale:true});
        return;
      }
      const updated = requests.flatMap(request => {
        const entry = request.result as StoredRecord | undefined;
        const note = parseStored(entry);
        const changed = note && edit(note);
        if (!changed) return [];
        const next = {...changed, updatedAt:version(note)};
        store.put({...entry, 'transcript.md':transcriptMarkdown(next)});
        return [next];
      });
      const nextUndo = expected ? [] : updated.map(({id, category, updatedAt}) => ({id, path:category!, updatedAt}));
      if (updated.length || expected?.length) store.put({id:categoryUndoId, entries:nextUndo} satisfies UndoJournal);
      result({records:updated, entries:updated.length || expected?.length ? nextUndo : entries});
    });
  }).then(async result => {
    if (!result.stale && (result.records.length || expected?.length)) libraryChanged();
    await writeNoteFiles(result.records.map(record => record.id));
    return result;
  });
}

export function applyCategories(assignments: readonly {id: string; path: string[]}[]) {
  const paths = new Map(assignments.map(({id,path}) => {
    if (!isCategoryPath(path)) throw Error('올바르지 않은 분류입니다.');
    return [id, path];
  }));
  return editCategoryBatch([...paths.keys()], note => note.category ? undefined : {...note, category:paths.get(note.id)});
}

export function undoCategories(expected: readonly CategoryUndoEntry[]) {
  const entries = new Map(expected.map(entry => [entry.id, entry]));
  return editCategoryBatch([...entries.keys()], note => {
    const entry = entries.get(note.id);
    if (entry && note.updatedAt === entry.updatedAt && sameCategory(note.category, entry.path)) return {...note, category:undefined};
  }, expected);
}

export async function exportRecord(record: RecordData) {
  const original = record.originalFilename
    ? await withRecord(record.id, 'readonly', entry => entry?.importMarkdown).catch(() => undefined)
    : undefined;
  const {filename, markdown} = buildNoteExport(record, original);
  download(new Blob([markdown], {type:'text/markdown;charset=utf-8'}), filename);
}

export function exportRecords(records: readonly RecordData[]) {
  const { filename, bytes } = buildNotesExport(records);
  download(new Blob([bytes], {type:'application/zip'}), filename);
}

function download(data: Blob, filename: string) {
  const url = URL.createObjectURL(data);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
