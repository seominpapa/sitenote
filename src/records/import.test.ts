import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importedRecord } from './import.ts';
import { parseTranscript, transcriptMarkdown } from './markdown.ts';
import { createRecord } from './model.ts';
import { resolveOriginalSources, searchOriginalAnswers, searchPastOriginals } from '../recordContext.ts';

test('imported document survives Markdown round-trip and can be cited within the same meeting project', () => {
  const id = 'document';
  const text = '비상 대피 집결지는 동쪽 출입구로 확정했습니다.';
  const record = importedRecord({id, filename:'안전 점검.HWPX', markdown:'가'.repeat(2399) + '🚧나다\n\n' + text}, '한강');
  assert.equal(record.title,'안전 점검');
  assert.equal(record.turns[1].text.startsWith('🚧'),true);
  assert.deepEqual(parseTranscript(transcriptMarkdown(record)),record);
  const candidates = searchOriginalAnswers([record], '비상 대피 집결지 어디인가요?');
  assert.equal(candidates.length,1);
  assert.equal(candidates[0].originalFilename,'안전 점검.HWPX');
  assert.equal(candidates[0].timeMs,undefined);
  const now = '2099-01-01T00:00:00.000Z';
  const active = createRecord({id:'meeting', kind:'meeting', project:'한강', now});
  assert.equal(searchPastOriginals([record],active,'비상 대피 집결지 어디인가요?').length,1);
  assert.equal(searchPastOriginals([record],{...active,project:'다른 현장'},'비상 대피 집결지 어디인가요?').length,0);
  assert.equal(resolveOriginalSources([record],active,[candidates[0].reference])[0].text.includes(text),true);
});

test('import chunks on paragraphs where possible and rejects invalid documents', () => {
  const md = '가'.repeat(1800) + '\r\n\r\n' + '나'.repeat(1800);
  assert.deepEqual(importedRecord({id:'r',filename:'meeting.markdown',markdown:md}).turns.map(turn => turn.text.length),[1800,1800]);
  assert.throws(() => importedRecord({id:'r',filename:'meeting.txt',markdown:'  '}),/문서/);
  assert.throws(() => importedRecord({id:'r',filename:'../meeting.md',markdown:'내용'}),/문서/);
});
