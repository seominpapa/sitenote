import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import SiteAudio from '../../modules/site-audio/index.ts';
import { assertId, safeId, type RecordData } from './model.ts';
import { summaryMarkdown, transcriptMarkdown } from './markdown.ts';
import { createRecordStore, type FileName } from './store.ts';

const directory = () => new Directory(Paths.document, 'records');
const file = (id: string, name: FileName) => new File(directory(), id, name);
const audioName = /^audio-[A-Za-z0-9_-]{1,80}\.wav$/;

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
  async export(selection: readonly RecordData[] | RecordData): Promise<void> {
    if (!await Sharing.isAvailableAsync()) throw Error('이 기기에서 파일을 내보낼 수 없습니다.');
    const records = 'id' in selection ? [selection] : selection;
    if (!records.length) throw Error('내보낼 기록이 없습니다.');
    const out = new File(Paths.cache, 'Sitenote-내보내기.md');
    out.create({ overwrite: true });
    const markdown = records.map(record => `${transcriptMarkdown(record)}${record.summary ?
      `\n## 요약\n\n${summaryMarkdown(record.summary, record.questions)}` : ''}`).join('\n---\n\n');
    out.write(markdown);
    await Sharing.shareAsync(out.uri, { mimeType: 'text/markdown', UTI: 'net.daringfireball.markdown', dialogTitle: '기록 내보내기' });
  },
};
