import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTurn, createRecord, type RecordData } from './records/model.ts';
import { parseTranscript, transcriptMarkdown } from './records/markdown.ts';
import { appendTypedFollowup, pendingTypedQuestions, typedJudgeRequest, typedQuestionRequest } from './typedFollowup.ts';

const record = () => createRecord({id:'meeting-1', kind:'meeting', now:'2026-11-20T00:00:00.000Z'});
const pair = {id:'entry-1', origin:'manual' as const, question:' 담당자는 누구인가요? ', answer:' 박민수입니다.\r\n자료 정리도 맡습니다. '};
const timestamp = '2026-11-20T00:21:00.000Z';

test('a local written pair persists distinctly in the followup section, preserving the meeting speech and ordering', () => {
  const base = applyTurn(record(), {id:'speech', role:'speaker', section:'meeting', timeMs:500, text:'회의 원본'});
  const next = appendTypedFollowup(base, pair, timestamp);
  assert.deepEqual(next.turns, [
    base.turns[0],
    {id:'entry-1-question', section:'followup', role:'user', entry:'typed-question', timeMs:1_260_000, text:'담당자는 누구인가요?'},
    {id:'entry-1-answer', section:'followup', role:'user', entry:'typed-answer', timeMs:1_260_001, text:'박민수입니다.\n자료 정리도 맡습니다.'},
  ]);
  assert.deepEqual(parseTranscript(transcriptMarkdown(next)), next);
  assert.deepEqual(base.turns.map(turn => turn.text), ['회의 원본']);
});

test('recording a generated answer closes only the AI copy of a previously unresolved summary question on reopen', () => {
  const base = {...record(), questions:['  담당자는   누구인가요? ', '담당자는 누구인가요?', '기한은 언제인가요?', ' ', '길'.repeat(501)]};
  const manual = appendTypedFollowup(base, pair, timestamp);
  assert.deepEqual(pendingTypedQuestions(manual), ['담당자는 누구인가요?', '기한은 언제인가요?']);
  const next = appendTypedFollowup(manual, {...pair, id:'ai-1', origin:'ai'}, timestamp);
  assert.deepEqual(pendingTypedQuestions(next), ['기한은 언제인가요?']);
  assert.equal(next.turns.at(-2)?.role, 'ai');
  assert.equal(next.turns.at(-2)?.timeMs, 1_260_002);
  assert.throws(() => appendTypedFollowup(next, {...pair, id:'ai-1', origin:'ai'}, timestamp), /이미/);
});

test('empty, oversized, invalid-id, and nonmeeting writes never create partial pairs', () => {
  assert.throws(() => appendTypedFollowup(record(), {...pair, question:' '}, timestamp), /질문/);
  assert.throws(() => appendTypedFollowup(record(), {...pair, answer:'x'.repeat(2001)}, timestamp), /답변/);
  assert.throws(() => appendTypedFollowup(record(), {...pair, id:'../file'}, timestamp), /ID/);
  assert.throws(() => appendTypedFollowup({...record(), kind:'personal'}, pair, timestamp), /회의/);
});

test('a spoken prompt stays pending unless speech answered it before the next prompt', () => {
  const base = {...record(), questions:['담당자는 누구인가요?', '기한은 언제인가요?', '어디에서 하나요?']};
  const turns = [
    {id:'ai-1', role:'ai', text:base.questions[0]},
    {id:'ai-2', role:'ai', text:base.questions[1]},
    {id:'reply', role:'speaker', text:'다음 주 금요일입니다.'},
    {id:'ai-3', role:'ai', text:base.questions[2], interrupted:true},
    {id:'draft', role:'user', text:'장소가 어딘가요?', entry:'typed-question'},
  ] as const;
  const spoken = turns.reduce<RecordData>((state, turn, timeMs) => applyTurn(state, {...turn, timeMs, section:'followup'}), base);
  assert.deepEqual(pendingTypedQuestions(spoken), [base.questions[0], base.questions[2]]);
});

test('generation uses only the active meeting material and an exact bounded history, judge includes no recording context', () => {
  const summary = '🧱'.repeat(3500);
  const base = applyTurn({...record(), title:'토목 회의', summary}, {id:'speech', role:'speaker', section:'meeting',
    timeMs:100, text:'오늘 안전 점검위원을 지정했습니다. ' + '회의자료'.repeat(3000)});
  const early = typedQuestionRequest(base);
  assert.equal(early?.action, 'question');
  assert.ok(early && early.context.length <= 8000);
  assert.ok(early?.context.includes('토목 회의'));
  assert.ok(early?.context.includes('안전 점검위원'));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(early?.context ?? ''));
  const next = appendTypedFollowup(base, {...pair, origin:'ai'}, timestamp);
  assert.deepEqual(typedQuestionRequest(next)?.previousQuestions, ['담당자는 누구인가요?']);
  assert.equal(typedQuestionRequest(record()), undefined);
  assert.deepEqual(typedJudgeRequest(' 담당자? ', ' 박민수 ', ['다음 질문?']), {
    action:'judge', question:'담당자?', answer:'박민수', context:['다음 질문?'], hasNext:true,
  });
  assert.equal(typedJudgeRequest('담당자?', '박민수', []).hasNext, false);
});
