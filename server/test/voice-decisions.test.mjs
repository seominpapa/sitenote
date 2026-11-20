import assert from 'node:assert/strict';
import test from 'node:test';
import { consentAnswer } from '../consent.mjs';
import { judgeFollowup } from '../followup.mjs';

test('consent accepts short, unambiguous Korean choices and declines explicit refusals', () => {
  for (const raw of ['네.', '예!', '네, 시작해 주세요.', '예, 네', '보충 질문 시작해 줘', '해 주세요', '동의합니다']) {
    assert.equal(consentAnswer(raw), true, raw);
  }
  for (const raw of ['아니요.', '아니오!', '아니에요.', '하지 마세요', '아니요, 이대로 마칠게요.', '이대로 마치기', '취소해 줘']) {
    assert.equal(consentAnswer(raw), false, raw);
  }
  for (const raw of [undefined, '', '네?', '아니요?', '「네」', '네, 근데 지금은 아니에요.', '좋긴 한데요', '아, 네가 시작해 줘', '시작해 주면 좋을까요?', '네, 아니요', '네! 지금은 하지 마세요']) {
    assert.equal(consentAnswer(raw), undefined, String(raw));
  }
});

const input = {question: '담당자는 누구인가요?', answer:'김 대리입니다.'};
const output = (value) => Response.json({status:'completed', output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
const options = (transport) => ({ openaiKey: 'fixture-key-not-real', textModel: 'fixture-model', transport });

test('sends bounded structured decision data and returns a validated verdict', async () => {
  let called = 0;
  const answer = '담'.repeat(3_000);
  const result = await judgeFollowup({ ...input, answer, context:['기한은 언제인가요?'], hasNext:true, extra:'do not send' }, options(async (url, init) => {
    called++;
    assert.match(url, /\/v1\/responses$/);
    assert.ok(init.signal instanceof AbortSignal);
    const body = JSON.parse(init.body);
    assert.equal(body.store, false);
    assert.equal(body.text.format.schema.additionalProperties, false);
    const data = JSON.parse(body.input);
    assert.deepEqual(Object.keys(data).sort(), ['answer','answerTruncated','hasNext','knownQuestions','question']);
    assert.deepEqual(data.knownQuestions, ['기한은 언제인가요?']);
    assert.ok(data.answer.length <= 2_000);
    assert.equal(data.answerTruncated, true);
    return output({ verdict:'wait' });
  }));
  assert.equal(called, 1);
  assert.equal(result, 'wait');
  for (const verdict of ['advance','clarify','wait']) {
    assert.equal(await judgeFollowup(input, options(async () => output({verdict}))), verdict);
  }
  assert.equal(await judgeFollowup(input, options(async () => output({verdict:'complete'}))), 'advance');
  assert.equal(await judgeFollowup({...input, hasNext:false}, options(async () => output({verdict:'complete'}))), 'complete');
});

test('does not send empty or pending answers or explicit stop commands', async () => {
  let calls = 0;
  const mocked = options(async () => { calls++; return output({verdict:'advance'}); });
  for (const answer of ['   ', '음…', '잠시만요.', '계속 말할게요.']) {
    assert.equal(await judgeFollowup({...input, answer}, mocked), 'wait');
  }
  assert.equal(await judgeFollowup({...input, answer:'보충 질문 그만해 줘.'}, mocked), 'complete');
  assert.equal(await judgeFollowup({...input, question:''}, mocked), 'wait');
  assert.equal(calls, 0);
});

test('provider errors, invalid results and canceled epochs leave the current question open', async () => {
  for (const bad of [null, {verdict:'skip'}, {verdict:'advance', ignored:true}]) {
    assert.equal(await judgeFollowup(input, options(async () => output(bad))), 'wait');
  }
  assert.equal(await judgeFollowup(input, options(async () => { throw Error('unavailable'); })), 'wait');
  const controller = new AbortController();
  const canceled = options(async (_url, {signal}) => {
    controller.abort();
    assert.equal(signal.aborted, true);
    return output({verdict:'advance'});
  });
  assert.equal(await judgeFollowup(input, canceled, controller.signal), 'wait');
  assert.equal(await judgeFollowup({...input, answer:'보충 질문 그만해 줘.'}, {}, controller.signal), 'wait');
});
