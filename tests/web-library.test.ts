import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecord, type RecordData, type Turn } from '../src/records/core.ts';
import { classifyRecords } from '../web/api.ts';
import { categoryTree } from '../web/library.ts';

const record = (id: string, day: number, fields: Partial<RecordData> = {}) => ({
  ...createRecord({ id, kind: 'meeting', now: `2026-11-0${day}T12:00:00.000Z` }), ...fields,
});

test('shared categories preserve hierarchy, uncategorized records, and newest first', () => {
  const old = record('old', 1, { category: ['업무', '안전'] });
  const recent = record('recent', 3, { category: ['업무', '안전'] });
  const parent = record('parent', 2, { category: ['업무'] });
  const isolated = record('uncategorized', 4);
  const original = Object.freeze([old, parent, isolated, recent]);
  const [work, fallback] = categoryTree(original);
  assert.deepEqual(work.path, ['업무']);
  assert.deepEqual(work.records.map(({ id }) => id), ['parent']);
  assert.deepEqual(work.children[0].path, ['업무', '안전']);
  assert.deepEqual(work.children[0].records.map(({ id }) => id), ['recent', 'old']);
  assert.equal(fallback.label, '미분류');
  assert.deepEqual(fallback.records.map(({ id }) => id), ['uncategorized']);
  assert.deepEqual(fallback.path, []);
  assert.deepEqual(categoryTree(original, 'date').flatMap(node => node.records.map(({id}) => id)), ['uncategorized', 'recent', 'parent', 'old']);
});

test('explicit folders remain in the shared tree without any recordings and accept a moved note', () => {
  const folders = [['업무','준공'], ['안전']];
  const [safety, work] = categoryTree([], 'category', folders);
  assert.deepEqual(safety.path, ['안전']);
  assert.deepEqual(work.children[0].path, ['업무', '준공']);
  assert.deepEqual(work.children[0].records, []);
  const moved = record('note', 1, {category: ['업무','준공']});
  const [, withNote] = categoryTree([moved], 'category', [...folders, folders[0]]);
  assert.deepEqual(withNote.children.map(folder => folder.path), [['업무','준공']]);
  assert.deepEqual(withNote.children[0].records, [moved]);
});

test('AI classification chunks records and sends only bounded excerpts and metadata', async t => {
  const turn = (role: Turn['role'], text: string): Turn => ({ id: role, section: 'meeting', role, text, timeMs: 0 });
  type Entry = {id:string; title:string; project?:string; kind:string; excerpt:string};
  const batches: Entry[][] = [];
  const taxonomy = [['회의', '안전']];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, '/categories');
    assert.equal(init.credentials, 'same-origin');
    const { records, knownPaths } = JSON.parse(String(init.body));
    assert.deepEqual(knownPaths, taxonomy);
    batches.push(records);
    return Response.json({ assignments: records.map(({ id }: Entry) => ({id, path:['회의','안전']})) });
  });
  const input = Array.from({length:25}, (_, i) => record(`rec-${i}`, 1));
  const first = {...input[0], title:'제목'.repeat(70), project:'현장'.repeat(70), summary:'요약'.repeat(201), turns:[turn('speaker','비공개 원문')]};
  const last = {...input[24], turns:[turn('ai','AI 발화 제외'),turn('speaker','참가자\n발언')]};
  assert.equal((await classifyRecords([first, ...input.slice(1, 24), last], [...taxonomy, ...taxonomy])).length, 25);
  assert.deepEqual(batches.map(batch => batch.length), [24, 1]);
  assert.deepEqual(Object.keys(batches[0][0]).sort(), ['excerpt','id','kind','project','title']);
  assert.equal(batches[0][0].excerpt, '요약'.repeat(200));
  assert.equal(batches[0][0].title.length, 120);
  assert.equal(batches[0][0].project?.length, 120);
  assert.equal(batches[1][0].excerpt, '참가자 발언');
  assert.deepEqual(await classifyRecords([]), []);
});

test('AI classification rejects missing, duplicated, unexpected, or malformed assignments', async t => {
  const valid = { id:'known', path:['업무'] };
  const cases = [null, [], [valid, valid], [{...valid,id:'unknown'}], [{...valid,path:[''] }], [{...valid,path:['업무/안전']}]];
  t.mock.method(globalThis, 'fetch', async () => Response.json({ assignments: cases.shift() }));
  const input = [record('known', 1)];
  while (cases.length) await assert.rejects(classifyRecords(input), /분류 결과/);
});
