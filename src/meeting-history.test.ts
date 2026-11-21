import assert from 'node:assert/strict';
import test from 'node:test';
import { meetingQuestionHistory } from './meeting-history.ts';
import { createRecord, type Turn } from './records/model.ts';
import type { VoiceSearchPlan } from './records/search.ts';

const turn = (id: string, minutes: number, text: string, role: Turn['role'] = 'speaker'): Turn =>
  ({id, section:'meeting', role, timeMs:minutes*60_000, text});
const record = {
  ...createRecord({id:'active-meeting', kind:'meeting'}),
  turns:[turn('opening',0,'첫 안건은 봄철 비상 점검입니다.'), turn('pipes',2,'배관 납품일은 12일입니다.'),
    turn('middle',33,'기중기 점검은 동쪽 야적장에서 진행합니다.'), turn('ai',40,'기중기 점검은 서쪽일 것입니다.', 'ai'),
    ...Array.from({length:20}, (_, i) => turn('later-'+i,60+i,'곧 회의를 마무리합니다.')),
    turn('question',82,'기중기 점검 어디서 해?')],
};
const current = (range: VoiceSearchPlan['range'], terms = ''): VoiceSearchPlan => ({scope:'current',range,terms,sameProject:false});

test('a long overview submits every confirmed turn in chronological order, only up to the start of the question', () => {
  const speech = Array.from({length:90},(_,i) => turn(`topic-${i}`,i,`안건 ${i}: ${'검토 내용 '.repeat(28)}`));
  const long = {...record, turns:[...speech,turn('made-up',45,'AI가 지어낸 내용','ai'),turn('question-now',90,'현재 질문 원문')]};
  const pending = turn('pending',89.5,'저장 중인 마지막 결정입니다.');
  const history = meetingQuestionHistory(long,90*60_000,[pending],current('overview','안건'));
  assert.equal(history.scope,'current');
  const text = history.recap?.chunks.join('') ?? '';
  for (const [index,line] of text.split('\n').filter(Boolean).entries()) {
    assert.ok(index < speech.length ? line.includes(`안건 ${index}:`) : line.includes(pending.text));
  }
  assert.equal(text.split('\n').filter(Boolean).length,91);
  assert.doesNotMatch(text,/AI가 지어낸 내용|현재 질문 원문/u);
  assert.match(history.context,/안건 0:[\s\S]+안건 4\d:[\s\S]+마지막 결정/u);
});

test('explicit current-meeting topic looks throughout earlier speech without uploading a broad recap', () => {
  const result = meetingQuestionHistory(record,82*60_000,[],current('topic','기중기 점검'));
  assert.equal(result.scope,'current');
  assert.equal(result.recap,undefined);
  assert.match(result.context,/동쪽 야적장/u);
  assert.doesNotMatch(result.context,/서쪽|회의를 마무리/u);
  const paraphrase = meetingQuestionHistory(record,82*60_000,[],current('topic','크레인 검사'));
  assert.match(paraphrase.recap?.chunks.join('') ?? '', /동쪽 야적장/u);
  assert.doesNotMatch(paraphrase.recap?.chunks.join('') ?? '', /서쪽|어디서 해/u);
});

test('picks the opening of a long meeting and does not substitute recent closing chatter', () => {
  const {context} = meetingQuestionHistory(record,81*60_000,[],current('opening'));
  assert.match(context, /회의 초반[\s\S]*첫 안건은 봄철 비상 점검[\s\S]*배관 납품일/u);
  assert.doesNotMatch(context, /기중기|마무리|active-meeting/u);
  const openingTopic = meetingQuestionHistory(record,82*60_000,[],current('opening','기중기 점검'));
  assert.doesNotMatch(openingTopic.recap?.chunks.join('') ?? openingTopic.context, /동쪽/u);
});

test('recalls a user’s earlier question and includes its still-saving original turn', () => {
  const pending = {...turn('prior-question', 72, '배관 압력은 누가 측정하나요?', 'user'), section:'meeting-ai' as const};
  const {context} = meetingQuestionHistory(record,82*60_000,[pending],current('prior-question'));
  assert.match(context, /앞서 한 질문[\s\S]*배관 압력은 누가 측정하나요/u);
  assert.doesNotMatch(context, /회의를 마무리|어디서 해\?/u);
});

test('a request for saved notes or clarification never exposes the current meeting', () => {
  for (const scope of ['latest','related','newest_note','clarify'] as const) {
    assert.deepEqual(meetingQuestionHistory(record,82*60_000,[],{...current('overview'),scope}), {
      ...(scope === 'clarify' ? {} : {scope:'saved'}),context:'',
    });
  }
  assert.deepEqual(meetingQuestionHistory(record,82*60_000,[]),{context:''});
});

test('uses the earlier question to find its answer in meeting speech', () => {
  const pending = {...turn('prior-question', 72, '기중기 점검 어디서 해?', 'user'), section:'meeting-ai' as const};
  const {context} = meetingQuestionHistory(record,82*60_000,[pending],current('prior-question'));
  assert.match(context, /앞서 한 질문[\s\S]*기중기 점검 어디서 해\?[\s\S]*동쪽 야적장/u);
  assert.doesNotMatch(context, /서쪽|마무리/u);
});
