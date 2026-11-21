import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import SiteAudio from '../../modules/site-audio/index.ts';
import { assertId, isOriginalFilename, safeId, type RecordData } from './model.ts';
import { buildNoteExport, buildNotesExport, noteFolderName, readableSummary, readableTranscript } from './export.ts';
import { createRecordStore, type FileName } from './store.ts';
import { convertDocument, maxDocumentBytes } from './document-converter.cjs';
import { importedRecord } from './import.ts';

const directory = () => new Directory(Paths.document, 'records');
const file = (id: string, name: FileName) => new File(directory(), id, name);
const documentText = (id: string) => new File(directory(), id, 'document.txt');
const archives = () => new Directory(Paths.document, 'note-originals');
const folderKey = 'sitenote-note-folder';
export type AndroidNoteFolder = {uri: string; label: string};
let folder: AndroidNoteFolder | undefined;
let queue: Promise<unknown> = Promise.resolve();
let reportFolderIssue: (kind: 'delete' | 'save') => void = () => {};
const audioName = /^audio-[A-Za-z0-9_-]{1,80}\.wav$/;

function enqueue<T>(task: () => Promise<T>) {
  const next = queue.then(task);
  queue = next.catch(() => {});
  return next;
}

async function readImportedText(record: RecordData) {
  if (!record.originalFilename) return;
  const entry = documentText(record.id);
  if (entry.exists) return entry.text();
  const legacy = new File(directory(), record.id, 'source.md');
  if (legacy.exists) return legacy.text();
}

async function publishNote(folderUri: string, note: RecordData) {
  const transcript = readableTranscript(note, await readImportedText(note)) + '\n';
  const summary = note.originalFilename ? undefined : readableSummary(note);
  await SiteAudio.publishNoteFiles(folderUri, note.id, noteFolderName(note), transcript,
    summary ? summary + '\n' : null, Boolean(note.originalFilename));
}

function copyNote(id: string) {
  if (!folder) return;
  return enqueue(async () => {
    if (!folder) return;
    const note = await store.load(id);
    if (note) await publishNote(folder.uri, note);
  }).catch(() => reportFolderIssue('save'));
}

async function copyFolder(next: AndroidNoteFolder) {
  for (const note of await store.list()) await publishNote(next.uri, note);
}

export async function loadAndroidNoteFolder(report: typeof reportFolderIssue) {
  if (Platform.OS !== 'android') return;
  reportFolderIssue = report;
  const raw = await SecureStore.getItemAsync(folderKey);
  if (!raw) return;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || !('uri' in value) || !('label' in value) ||
      typeof value.uri !== 'string' || !value.uri.startsWith('content://') || typeof value.label !== 'string') {
    throw Error('노트 저장 폴더 설정을 읽지 못했습니다.');
  }
  folder = {uri:value.uri, label:value.label};
  return folder;
}

export function chooseAndroidNoteFolder() {
  return enqueue(async () => {
    const next = await SiteAudio.pickNoteFolder();
    if (!next) return;
    await copyFolder(next);
    await SecureStore.setItemAsync(folderKey, JSON.stringify(next));
    folder = next;
    return next;
  });
}

function localImportError(error: unknown) {
  const text = error instanceof Error ? error.message : '';
  if (/too large/.test(text)) return Error('파일은 20MB, 변환할 본문은 25만 자까지 가져올 수 있습니다.');
  if (/protected|encrypted/.test(text)) return Error('암호가 걸렸거나 보호된 문서는 가져올 수 없습니다.');
  if (/image-only PDF|PDF.*OCR/i.test(text)) return Error('스캔 PDF는 지원하지 않습니다. 텍스트를 선택할 수 있는 PDF를 추가해 주세요.');
  if (/image-only|no readable/.test(text)) return Error('읽을 수 있는 본문이 없습니다. 이미지로만 된 문서는 변환할 수 없습니다.');
  return Error('문서를 읽을 수 없습니다. 지원 형식과 파일 상태를 확인해 주세요.');
}

const store = createRecordStore({
  async listIds() {
    const root = directory();
    return root.exists ? root.list().flatMap(entry => entry instanceof Directory && safeId.test(entry.name) ? [entry.name] : []) : [];
  },
  async read(id, name) {
    const entry = file(id, name);
    return entry.exists ? entry.text() : undefined;
  },
  async write(id, name, content) {
    new Directory(directory(), id).create({ intermediates: true, idempotent: true });
    await SiteAudio.writeTextAtomic(file(id, name).uri, content);
  },
  async delete(id) {
    const entry = new Directory(directory(), id);
    if (entry.exists) entry.delete();
  },
});

export const recordStore = {
  ...store,
  async save(record: RecordData) {
    await store.save(record);
    await copyNote(record.id);
  },
  async saveSummary(id: string, markdown: string, questions?: readonly string[]) {
    await store.saveSummary(id, markdown, questions);
    await copyNote(id);
  },
  async delete(id: string) {
    await store.delete(id);
    if (!folder) return;
    await enqueue(async () => {
      if (folder) await SiteAudio.deleteNoteFiles(folder.uri, id);
    }).catch(() => reportFolderIssue('delete'));
  },
  async importDocument(id: string, project?: string) {
    assertId(id);
    const selected = await SiteAudio.pickNoteDocument();
    if (!selected) return;
    const input = new File(selected.cachePath);
    try {
      if (!isOriginalFilename(selected.filename)) throw Error('MD, TXT, DOCX, HWP, HWPX 또는 PDF 파일을 선택해 주세요.');
      if (!input.exists || (input.size ?? 0) > maxDocumentBytes) throw Error('가져올 파일을 확인할 수 없습니다.');
      const bytes = await input.bytes();
      const markdown = await Promise.resolve().then(() => convertDocument(selected.filename, bytes)).catch(error => { throw localImportError(error); });
      const record = importedRecord({id,filename:selected.filename,markdown}, project);
      const archive = new Directory(archives(), id);
      if (archive.exists) throw Error('이미 사용 중인 기록입니다. 문서를 다시 선택해 주세요.');
      try {
        archive.create({intermediates:true});
        await input.copy(new File(archive,selected.filename));
        new Directory(directory(), id).create({intermediates:true});
        await SiteAudio.writeTextAtomic(documentText(id).uri, markdown);
        await store.save(record);
      } catch (error) {
        if (archive.exists) archive.delete();
        await store.delete(id);
        throw error;
      }
      await copyNote(id);
      return record;
    } finally {
      try { if (input.exists) input.delete(); } catch { /* Cache cleanup may be retried by the system. */ }
    }
  },
  async openOriginal(record: RecordData) {
    assertId(record.id);
    if (!isOriginalFilename(record.originalFilename)) throw Error('연결된 원본 파일이 없습니다.');
    const original = new File(archives(), record.id, record.originalFilename);
    if (Platform.OS === 'android' && original.exists) {
      try {
        await SiteAudio.openOriginalNote(original.contentUri, record.id, record.originalFilename);
        return;
      } catch { /* A native attachment viewer might not be installed. */ }
    } else if (folder) {
      await SiteAudio.openLegacyNote(folder.uri, record.id, record.originalFilename);
      return;
    }
    if (!original.exists || !await Sharing.isAvailableAsync()) throw Error('이 기기에서 원본 문서를 열 수 없습니다.');
    await Sharing.shareAsync(original.uri,{dialogTitle:'원본 문서 열기'});
  },
  archiveUri(id: string, name: string): string {
    assertId(id);
    if (!audioName.test(name)) throw Error('녹음 파일 이름이 올바르지 않습니다.');
    const entry = new Directory(directory(), id);
    entry.create({ intermediates: true, idempotent: true });
    return new File(entry, name).uri;
  },
  audioFiles(id: string): { name: string; uri: string }[] {
    assertId(id);
    const entry = new Directory(directory(), id);
    return entry.exists ? entry.list().flatMap(item => item instanceof File && audioName.test(item.name) && (item.size ?? 0) > 44
      ? [{ name: item.name, uri: item.uri }] : []) : [];
  },
  async export(record: RecordData): Promise<void> {
    if (!await Sharing.isAvailableAsync()) throw Error('이 기기에서 파일을 내보낼 수 없습니다.');
    const {filename, markdown} = buildNoteExport(record, await readImportedText(record));
    const out = new File(Paths.cache, filename);
    out.create({ overwrite: true });
    await out.write(markdown);
    await Sharing.shareAsync(out.uri, { mimeType: 'text/markdown', UTI: 'net.daringfireball.markdown', dialogTitle: '기록 내보내기' });
  },
  async exportAll(): Promise<void> {
    if (!await Sharing.isAvailableAsync()) throw Error('이 기기에서 파일을 내보낼 수 없습니다.');
    const { filename, bytes } = buildNotesExport(await store.list());
    const out = new File(Paths.cache, filename);
    out.create({overwrite:true});
    await out.write(bytes);
    await Sharing.shareAsync(out.uri, {mimeType:'application/zip', UTI:'public.zip-archive', dialogTitle:'전체 내보내기'});
  },
};
