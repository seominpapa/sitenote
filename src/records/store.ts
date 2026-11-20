import { assertId, type RecordData } from './model.ts';
import { parseSummary, parseTranscript, summaryMarkdown, transcriptMarkdown } from './markdown.ts';

export type FileName = 'transcript.md' | 'summary.md';
export type RecordIssue = { id: string; file: FileName; cause: unknown };
export type RecordFiles = {
  listIds: () => Promise<string[]>;
  read: (id: string, name: FileName) => Promise<string | undefined>;
  write: (id: string, name: FileName, content: string) => Promise<void>;
  delete: (id: string) => Promise<void>;
};

export function createRecordStore(files: RecordFiles) {
  let pending: Promise<unknown> = Promise.resolve();
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = pending.then(operation);
    pending = next.catch(() => {}); // The caller gets the error; later operations can still run.
    return next;
  }

  async function open(id: string, onIssue?: (issue: RecordIssue) => void, skipDamagedTranscript = false): Promise<RecordData | undefined> {
    let record: RecordData;
    try {
      assertId(id);
      const transcript = await files.read(id, 'transcript.md');
      if (transcript === undefined) return undefined;
      record = parseTranscript(transcript);
      if (record.id !== id) throw Error('폴더 이름과 기록 ID가 일치하지 않습니다.');
    } catch (cause) {
      if (!skipDamagedTranscript) throw Error(`기록 ${id}을(를) 열 수 없습니다.`, { cause });
      onIssue?.({id,file:'transcript.md',cause});
      return undefined;
    }
    try {
      const summary = await files.read(id, 'summary.md');
      return summary === undefined ? record : { ...record, ...parseSummary(summary) };
    } catch (cause) {
      onIssue?.({id,file:'summary.md',cause});
      return record;
    }
  }

  return {
    load: (id: string, onIssue?: (issue: RecordIssue) => void) => enqueue(() => open(id,onIssue)),
    list: (onIssue?: (issue: RecordIssue) => void) => enqueue(async () => {
      const records: RecordData[] = [];
      for (const id of await files.listIds()) {
        const record = await open(id,onIssue,true);
        if (record) records.push(record);
      }
      return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }),
    save: (record: RecordData) => enqueue(async () => {
      assertId(record.id);
      await files.write(record.id, 'transcript.md', transcriptMarkdown(record));
    }),
    saveSummary: (id: string, markdown: string, questions?: readonly string[]) => enqueue(async () => {
      assertId(id);
      if (await files.read(id, 'transcript.md') === undefined) throw Error('요약을 저장할 원문이 없습니다.');
      await files.write(id, 'summary.md', summaryMarkdown(markdown, questions));
    }),
    delete: (id: string) => enqueue(async () => { assertId(id); await files.delete(id); }),
  };
}
