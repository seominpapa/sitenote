import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../app.mjs';

const accessToken = 'typed-followup-test-bearer-32-characters';
const draft = {action:'question', context:'현장 점검은 금요일입니다. 담당자는 미정입니다.'};
const judgement = {action:'judge', question:'누가 현장을 점검하나요?', answer:'김 대리가 점검합니다.', hasNext:false};
const output = (value) => Response.json({status:'completed', output:[{type:'message', content:[{type:'output_text', text:JSON.stringify(value)}]}]});

async function fixture(t, {transport, openaiKey = 'mock-typed-followup-key', web = false} = {}) {
  const webRoot = web ? await mkdtemp(join(tmpdir(), 'typed-followup-web-')) : undefined;
  if (webRoot) {
    t.after(() => rm(webRoot, {recursive:true, force:true}));
    await writeFile(join(webRoot, 'index.html'), 'Sitenote');
  }
  const server = createApp({accessToken, openaiKey, webRoot, transport:transport ?? (() => assert.fail('unexpected provider request'))});
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const cookie = web ? (await fetch(origin + '/')).headers.get('set-cookie').split(';')[0] : undefined;
  const auth = {Authorization: 'Bearer ' + accessToken};
  const post = (body, headers = auth, contentType = 'application/json') =>
    fetch(origin + '/followup', {
      method: 'POST', headers:{'Content-Type':contentType, ...headers}, body:JSON.stringify(body),
    });
  return {post, origin, cookie};
}

test('one text follow-up question uses only selected record context, is not stored and can return no question', async (t) => {
  const plan = ['목표는 무엇인가요?'];
  const question = '금요일 현장 점검은 누가 담당하나요?';
  const seen = [];
  const {post} = await fixture(t, {transport: async (url, init) => {
    assert.match(url, /\/v1\/responses$/u);
    assert.ok(init.signal instanceof AbortSignal);
    const body = JSON.parse(init.body);
    assert.equal(body.store, false);
    assert.equal(body.text.format.name, 'followup_question');
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.schema.additionalProperties, false);
    assert.match(body.instructions, /지시/u);
    seen.push(JSON.parse(body.input));
    return output({question: seen.length === 1 ? '  ' + question + '  ' : null});
  }});
  const response = await post({...draft, context: '  ' + draft.context + '  ', previousQuestions:plan});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {question});
  assert.deepEqual(await (await post(draft)).json(), {question:null});
  assert.deepEqual(seen, [{context:draft.context, previousQuestions:plan}, {context:draft.context}]);
});

test('typed answers share follow-up verdict semantics and surface provider failure without exposing answer or credentials', async (t) => {
  let calls = 0;
  const context = ['최종 기한은 언제인가요?'];
  const {post} = await fixture(t, {transport: async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    assert.equal(body.store, false);
    assert.equal(body.text.format.name, 'followup_verdict');
    assert.deepEqual(JSON.parse(body.input), {
      question: judgement.question, answer: judgement.answer, answerTruncated:false,
      knownQuestions:context, hasNext:calls === 2,
    });
    if (calls === 3) throw new Error('private mock-typed-followup-key: ' + judgement.answer);
    return output({verdict:'complete'});
  }});
  assert.deepEqual(await (await post({...judgement, context})).json(), {verdict:'complete'});
  assert.deepEqual(await (await post({...judgement, context, hasNext:true})).json(), {verdict:'advance'});
  const failed = await post({...judgement, context});
  assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), /private|mock-typed|김 대리/u);
  assert.deepEqual(await (await post({...judgement, answer:'잠시만요.'})).json(), {verdict:'wait'});
  assert.deepEqual(await (await post({...judgement, answer:'보충 질문 그만해 줘.'})).json(), {verdict:'complete'});
  assert.equal(calls, 3);
});

test('typed follow-up rejects invalid or unauthenticated input and accepts an authenticated same-origin browser', async (t) => {
  const {post, origin, cookie} = await fixture(t, {web:true});
  assert.equal((await post(draft, {})).status, 401);
  assert.equal((await post(draft, {Cookie:cookie})).status, 401);
  assert.equal((await post(draft, {Cookie:cookie, Origin:'https://other.invalid'})).status, 403);
  const browser = {Cookie:cookie, Origin:origin};
  assert.equal((await post(draft, browser, 'text/plain')).status, 400);
  for (const input of [
    null, [], {}, {...draft, action:'unknown'}, {...draft, context:'    '}, {...draft, context:'a'.repeat(8_001)},
    {...draft, previousQuestions:Array(6).fill('질문?')}, {...draft, previousQuestions:['?'.repeat(241)]},
    {...draft, previousQuestions:['   ']}, {...draft, previousQuestions:['질문?', false]}, {...draft, audio:'no'},
    {...judgement, question:''}, {...judgement, answer:'가'.repeat(2_001)}, {...judgement, hasNext:'false'},
    {...judgement, context:'entire transcript'}, {...judgement, knownQuestions:[]},
  ]) assert.equal((await post(input, browser)).status, 400, JSON.stringify(input)?.slice(0,120));
  assert.deepEqual(await (await post({...judgement, answer:'잠시만요.'}, browser)).json(), {verdict:'wait'});
});

test('rejects malformed generation output and ignores an exact repeat of a previous question', async (t) => {
  const results = [
    {question:'금요일 발표는 누가 하나요?\n자료는 언제 받나요?'},
    {question:'가'.repeat(501)}, {question:42}, {question:' ', extra:false}, {question:'   '},
    {question:'최종 기한은 언제인가요? '}, {verdict:'bad'},
  ];
  const {post} = await fixture(t, {transport: async () => output(results.shift())});
  for (let i = 0; i < 5; i++) assert.equal((await post(draft)).status, 502);
  assert.deepEqual(await (await post({...draft, previousQuestions:[' 최종 기한은 언제인가요 ? ']})).json(), {question:null});
  assert.equal((await post(judgement)).status, 502);
});

test('applies existing missing key handling and bounds follow-up traffic', async (t) => {
  const disabled = await fixture(t, {openaiKey:''});
  assert.equal((await disabled.post(draft)).status, 503);
  const {post} = await fixture(t);
  const hold = {...judgement, answer:'잠시만요.'};
  for (let i = 0; i < 12; i++) assert.equal((await post(hold)).status, 200);
  assert.equal((await post(hold)).status, 429);
});
