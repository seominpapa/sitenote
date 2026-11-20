import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTurn, createRecord, searchRecords } from './core.ts';
import { createRecordStore, type RecordFiles } from './store.ts';

function fakeFiles() {
  const files = new Map<string, string>();
  const adapter: RecordFiles = {
    async listIds() { return [...new Set([...files.keys()].map(key => key.split('/')[0]!))]; },
    async read(id, name) { return files.get(`${id}/${name}`); },
    async write(id, name, value) { files.set(`${id}/${name}`, value); },
    async delete(id) { for (const path of files.keys()) if (path.startsWith(`${id}/`)) files.delete(path); },
  };
  return { files, adapter };
}

test('progressive writes are serialized and readable after creating a fresh store', async () => {
  const { files, adapter } = fakeFiles();
  const one = createRecord({ id: 'one', kind: 'meeting' });
  const store = createRecordStore(adapter);
  const spoken = applyTurn(one, { id: 'real-turn', role: 'speaker', section: 'meeting', speakerId: '0', text: '원본 문장', timeMs: 0 });
  const early = store.save(one);
  const later = store.save(spoken);
  await Promise.all([early, later]);
  await store.saveSummary(one.id, '# 회의록', ['담당자?']);
  const updated = { ...spoken, title: '새 제목' };
  await store.save(updated);
  assert.equal(files.size, 2);
  const records = await createRecordStore(adapter).list();
  assert.deepEqual(records, [{ ...updated, summary: '# 회의록', questions: ['담당자?'] }]);
  assert.equal(searchRecords(records, '원본 문장')[0]?.title, '새 제목');
  await store.delete(one.id);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(searchRecords(await store.list(), '원본 문장'), []);
});

test('write failures preserve prior original and do not poison the queue', async () => {
  const { adapter } = fakeFiles();
  const write = adapter.write;
  let fail = false;
  adapter.write = async (...args) => {
    if (fail) throw Error('disk full');
    await write(...args);
  };
  const store = createRecordStore(adapter);
  const one = createRecord({ id: 'one', kind: 'personal' });
  await store.save(one);
  fail = true;
  await assert.rejects(store.save({ ...one, title: 'Not persisted' }), /disk full/);
  await assert.rejects(store.saveSummary(one.id, 'Not persisted'), /disk full/);
  assert.deepEqual(await store.list(), [one]);
  fail = false;
  await store.save({ ...one, title: 'persisted' });
  assert.equal((await store.list())[0]?.title, 'persisted');
});

test('invalid paths and unknown IDs still reject the individual operation', async () => {
  const { files, adapter } = fakeFiles();
  const store = createRecordStore(adapter);
  await assert.rejects(store.delete('../secret'), /ID/);
  await assert.rejects(store.saveSummary('missing', 'summary'), /원문/);
  files.set('broken/transcript.md', 'corrupt');
  await assert.rejects(store.load('broken'), /broken/);
});

test('listing retains healthy records and valid originals from records with a damaged summary', async () => {
  const { files, adapter } = fakeFiles();
  const store = createRecordStore(adapter);
  const good = createRecord({ id: 'good', kind: 'personal', now:'2026-11-20T00:00:00.000Z' });
  const original = applyTurn(createRecord({ id: 'original', kind: 'meeting', now:'2026-11-19T00:00:00.000Z' }),
    {id:'spoken', section:'meeting', role:'speaker', timeMs:0, text:'정상 원문'});
  await store.save(good);
  await store.save(original);
  files.set('broken/transcript.md', 'corrupt');
  files.set('original/summary.md', '<!-- sitenote-summary malformed -->');
  const issues: Array<[string, string]> = [];
  assert.deepEqual(await store.list(issue => issues.push([issue.id, issue.file])), [good,original]);
  assert.deepEqual(issues, [['original','summary.md'],['broken','transcript.md']]);
  assert.deepEqual(await store.list(), [good,original]);
  assert.deepEqual(await store.load('original'), original);
});
