import { randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import WebSocket from 'ws';
import { createApp } from '../app.mjs';
import { handleStream } from '../stream.mjs';

const token = randomBytes(32).toString('hex');
const authorization = { Authorization: 'Bearer ' + token };
const keys = { accessToken: token, openaiKey: 'mock-openai', sonioxKey: 'mock-soniox', textModel: 'gpt-5.4-mini' };
const wallTimeout = setTimeout;
const nextTick = () => new Promise(resolve => wallTimeout(resolve, 20));
const ref = '[record:c7595458-b44b-4a22-a2f8-187ee2709c3d#17]';
const context = ref + '\n{"role":"speaker","text":"납기 5월 10일"}';
const audio = Buffer.from([1, 127]).toString('base64');
const event = (socket, type, extra = {}) => socket.emit('message', JSON.stringify({ type, ...extra }));
const jsonMessages = (socket, type) => socket.messages.map(raw => JSON.parse(raw)).filter(message => message.type === type);
const speech = (socket, text, start_ms, end_ms, is_final = true) => event(socket, undefined, {
  tokens: [{text, start_ms, end_ms, is_final, speaker:'1'}],
});
const endpoint = (socket) => event(socket, undefined, {tokens:[{text:'<end>', is_final:true}]});
const questionConfig = (socket) => jsonMessages(socket, 'session.start')[0].session;
const inputQuestion = (session) => session.input.filter(item => item.role === 'user').at(-1)?.content[0].text;
const inputEvidence = (session) => session.input.find(item => item.role === 'user'
  && item.content[0].text.startsWith('다음은 참고 데이터입니다: '))?.content[0].text;
const reply = (socket, id, text) => {
  event(socket, 'session.started');
  event(socket, 'session.output_audio.delta', {delta:audio, event_id:`${id}-audio`});
  event(socket, 'session.output_transcript.delta', {delta:text, event_id:`${id}-text`, start_ms:10, end_ms:40});
};
const finishReply = (t, socket) => {
  t.mock.timers.tick(1_200);
  assert.equal(jsonMessages(socket, 'session.close').length, 1);
  event(socket, 'session.closed', {reason:'close_requested'});
};

class MockProvider extends EventEmitter {
  readyState = 0;
  messages = [];
  bufferedAmount = 0;
  send(data) {
    this.messages.push(data);
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  terminate() {
    this.close();
  }
}

async function setup(t, options = {}) {
  const providers = [];
  const app = createApp({
    ...keys,
    ...options.config,
    upstream(url, opts) {
      const ws = new MockProvider();
      providers.push({ ws, url, opts });
      return ws;
    },
    transport: options.transport,
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const base = 'http://127.0.0.1:' + app.address().port;
  const request = (path, body, headers = authorization) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sockets = [];
  const socket = (headers = authorization) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/stream', { headers });
    ws.on('error', () => {});
    sockets.push(ws);
    return ws;
  };
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await new Promise((ok) => app.close(ok));
  });
  return { providers, request, socket, base };
}

async function connect(t, setup, headers) {
  const ws = setup.socket(headers);
  const messages = [];
  ws.on('message', (message) => messages.push(JSON.parse(message)));
  await once(ws, 'open');
  t.after(() => ws.terminate());
  return { messages, send: (message) => ws.send(JSON.stringify(message)) };
}

test('authenticated HTTP and WebSocket; health reveals only enabled providers', async (t) => {
  const { request, socket, providers } = await setup(t);
  assert.equal((await request('/health', undefined, {})).status, 401);
  assert.equal((await request('/health', undefined, { Authorization: 'Bearer a' })).status, 401);
  const health = await request('/health');
  assert.deepEqual(await health.json(), { ok: true, providers: { live: true, soniox: true, text: true } });
  const notFound = await request('/missing');
  assert.equal(notFound.status, 404);
  const ws = socket({});
  const [_, response] = await once(ws, 'unexpected-response');
  assert.equal(response.statusCode, 401);
  response.resume();
  ws.terminate();
  assert.equal(providers.length, 0);
});

test('meeting transcribes through Soniox and flushes final tokens without starting OpenAI', async (t) => {
  const app = await setup(t);
  const { messages, send } = await connect(t, app);
  send({ type: 'start', mode: 'meeting', timeMs: 123 });
  await nextTick();
  const son = app.providers[0];
  assert.match(son.url, /^wss:\/\/stt-rt\.soniox\.com/);
  son.ws.open();
  const stt = JSON.parse(son.ws.messages[0]);
  assert.equal(stt.model, 'stt-rt-v6');
  assert.equal(stt.enable_speaker_diarization, true);
  assert.equal(stt.enable_endpoint_detection, true);
  assert.equal(stt.sample_rate, 24000);
  event(son.ws, undefined, { tokens: [{ text: '안녕', is_final: true, start_ms: 0, end_ms: 40, speaker: '1' }] });
  send({ type: 'audio', audio });
  await nextTick();
  assert.equal(app.providers.length, 1);
  assert.deepEqual(son.ws.messages[1], Buffer.from(audio, 'base64'));
  assert.equal(messages.find((event) => event.type === 'soniox').offsetMs, 123);
  assert.equal(messages.some((event) => event.type === 'audio'), false);

  send({ type: 'audio', audio, suppressed: true });
  await nextTick();
  assert.deepEqual(son.ws.messages.at(-1), Buffer.alloc(2));
  send({ type: 'finish' });
  await nextTick();
  assert.equal(son.ws.messages.at(-1), '');
  assert.equal(messages.some((event) => event.type === 'finished'), false);
  event(son.ws, undefined, { tokens: [{ text: '.', is_final: true }], finished: true });
  await nextTick();
  assert.equal(messages.filter((event) => event.type === 'soniox').at(-1).tokens[0].text, '.');
  assert.deepEqual(messages.find((event) => event.type === 'finished'), { type: 'finished', flushed: true });
});

test('followup requests model-generated opening question, skip, and handles errors without leaking keys', async (t) => {
  const app = await setup(t);
  const { messages, send } = await connect(t, app);
  send({ type: 'start', mode: 'followup', timeMs: 0, context, voice:'cedar' });
  await nextTick();
  const soniox = app.providers[0].ws;
  const live = app.providers[1].ws;
  live.open();
  assert.equal(live.messages.length, 0, 'do not start the followup voice session without diarization');
  soniox.open();
  const config = JSON.parse(live.messages[0]).session;
  assert.equal(config.delegation.type, 'client');
  assert.equal(config.model, 'gpt-live-1.1');
  assert.equal(config.audio.output.voice, 'cedar');
  event(live, 'session.started');
  assert.equal(config.input.at(-1).role, 'developer');
  assert.match(config.input.at(-1).content[0].text, /미확정/);
  send({ type: 'skip', timeMs: 76 });
  await nextTick();
  assert.equal(app.providers.length, 3);
  const afterSkip = app.providers[2].ws;
  afterSkip.open();
  event(afterSkip, 'session.started');
  assert.equal(questionConfig(afterSkip).audio.output.voice, 'cedar');
  const next = questionConfig(afterSkip).input.at(-1);
  assert.equal(next.role, 'developer');
  assert.match(next.content[0].text, /건너/);
  event(afterSkip, 'error', { error: { message: 'sensitive mock-openai', code: 'model_not_found' } });
  await nextTick();
  const error = messages.find((event) => event.type === 'error');
  assert.equal(error.scope, 'live');
  assert.equal(error.fatal, false);
  assert.equal(soniox.readyState, 1);
  assert.match(error.message, /모델/);
  assert.doesNotMatch(JSON.stringify(messages), /sensitive|mock-openai/);
});

test('text handling limits invalid input, preserves structured summaries, strips invented citations and never stores payloads', async (t) => {
  const calls = [];
  const text = async (url, options) => {
    calls.push({url, ...options, body: JSON.parse(options.body)});
    const output = calls.length === 1 ? JSON.stringify({ markdown: '## 결정\n' + ref + ' [record:fake#fake]', questions: ['담당자는?'] }) : '5월 10일 ' + ref + ' [record:fake#fake]';
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: output }] }] }));
  };
  const { request } = await setup(t, { transport: text });
  assert.equal((await request('/summary', { kind: 'fake', context })).status, 400);
  assert.equal((await request('/summary', { kind: 'personal', context: ' '.repeat(45001) })).status, 400);
  assert.equal((await request('/answer', { question: '', context })).status, 400);
  const summary = await request('/summary', { kind: 'meeting', context });
  assert.deepEqual(await summary.json(), { markdown: '## 결정\n' + ref, questions: ['담당자는?'] });
  const answer = await request('/answer', { question: '언제?', context, history: '납기 관련' });
  assert.deepEqual(await answer.json(), { answer: '5월 10일 ' + ref });
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => !call.body.store), true);
  assert.equal(calls[0].body.text.format.type, 'json_schema');
  assert.match(calls[0].body.instructions, /참고 데이터/);
  assert.match(calls[0].body.instructions, /출처1.*목록/);
  assert.equal(calls[0].body.model, 'gpt-5.4-mini');
});

test('missing configuration and interrupted provider are explicit', async (t) => {
  const app = await setup(t, { config: { openaiKey: '', sonioxKey: '' } });
  const { messages, send } = await connect(t, app);
  send({ type: 'audio', audio: 'not valid!' });
  send({ type: 'start', mode: 'meeting', timeMs: 0 });
  await nextTick();
  assert.equal(messages.find((event) => event.type === 'error' && event.scope === 'meeting').fatal, true);
  assert.equal(app.providers.length, 0);
  const response = await app.request('/answer', { question: '언제?', context: '' });
  assert.equal(response.status, 503);
});

test('personal recording requires Soniox and does not connect OpenAI without invitation', async (t) => {
  const app = await setup(t,{config:{sonioxKey:''}});
  const { messages, send } = await connect(t, app);
  send({ type:'start', mode:'personal', timeMs:30 });
  await nextTick();
  assert.equal(app.providers.length, 0);
  assert.match(messages.find(item=>item.type==='error').message, /Soniox.*키/);
});

test('invalid requests are bounded and upstream failures surface user-safe errors', async (t) => {
  assert.throws(() => createApp({ accessToken: 'short' }), /32자/);
  const app = await setup(t, { transport: async () => new Response('secret rejected', { status: 429 }) });
  const oversized = await app.request('/summary', { kind: 'meeting', context: 'x'.repeat(200_001) });
  assert.equal(oversized.status, 400);
  const textFailure = await app.request('/summary', { kind: 'meeting', context });
  assert.equal(textFailure.status, 502);
  assert.doesNotMatch(JSON.stringify(await textFailure.json()), /secret/);
  const { messages, send } = await connect(t, app);
  send({ type: 'start', mode: 'meeting', timeMs: 0 });
  await nextTick();
  const upstream = app.providers[0].ws;
  upstream.open();
  send({ type: 'audio', audio: '!' });
  await nextTick();
  assert.match(messages.at(-1).message, /오디오 형식/);
  upstream.emit('message', 'not-json');
  await nextTick();
  assert.equal(messages.at(-1).fatal, true);
  assert.match(messages.at(-1).message, /응답 형식/);
  send({ type: 'finish' });
  await nextTick();
  assert.deepEqual(messages.find((event) => event.type === 'finished'), { type: 'finished', flushed: false });
});

test('ordinary AI uses GPT-Live with only silence; Soniox receives the actual microphone PCM', async (t) => {
  const app = await setup(t);
  const { messages, send } = await connect(t, app);
  send({ type: 'start', mode: 'meeting', timeMs: 0, voice:'noeul' });
  await nextTick();
  const soniox = app.providers[0].ws;
  soniox.open();
  send({ type: 'audio', audio });
  send({ type: 'ask', timeMs: 500 });
  await nextTick();
  send({type:'audio',audio});
  await nextTick();
  assert.equal(app.providers.length, 1, 'inviting AI does not start a provider connection');
  speech(soniox,'실제 질문',50,80);
  endpoint(soniox);
  await nextTick();
  const search = messages.find(item => item.type === 'search');
  send({type:'search_result', id:search.id, context:''});
  await nextTick();
  const upstream = app.providers[1].ws;
  upstream.open();
  assert.equal(questionConfig(upstream).audio.output.voice, 'noeul');
  event(upstream, 'session.started');
  send({type:'audio',audio});
  await nextTick();
  const liveAudio = jsonMessages(upstream, 'session.input_audio.append');
  assert.ok(liveAudio.length > 0, 'silent startup drives Live playback');
  assert.ok(liveAudio.every(({audio}) => Buffer.from(audio,'base64').every(byte => byte === 0)));
  assert.deepEqual(soniox.messages.filter(Buffer.isBuffer), Array(3).fill(Buffer.from(audio,'base64')));
});

test('rejects an unsupported recording voice before connecting to any provider', async (t) => {
  const app = await setup(t);
  const {send,messages} = await connect(t,app);
  send({type:'start',mode:'meeting',timeMs:0,voice:'other-model-voice'});
  await nextTick();
  assert.equal(app.providers.length,0);
  assert.equal(messages.find(item => item.type === 'error').fatal,true);
  assert.equal(messages.find(item => item.type === 'finished').flushed,false);
});

test('GPT-Live upgrade rejection reports safe diagnostics and leaves meeting transcription running', async (t) => {
  const app = await setup(t);
  const { messages, send } = await connect(t, app);
  send({type:'start', mode:'meeting', timeMs:0});
  await nextTick();
  const son = app.providers[0].ws;
  son.open();
  send({type:'ask', timeMs:10});
  await nextTick();
  speech(son, '현장은 어디인가요?', 20, 60);
  endpoint(son);
  await nextTick();
  const search = messages.find(item => item.type === 'search');
  send({type:'search_result', id:search.id, context:''});
  await nextTick();
  const live = app.providers[1].ws;
  live.emit('unexpected-response', {}, {statusCode:429, resume() {}});
  send({type:'audio', audio});
  await nextTick();
  assert.equal(messages.find((message) => message.type === 'error' && message.scope === 'live').fatal, false);
  assert.match(messages.find((message) => message.type === 'error' && message.scope === 'live').message, /한도/);
  assert.equal(son.readyState, 1);
  assert.deepEqual(son.messages.at(-1), Buffer.from(audio, 'base64'));
});


test('followup uses Soniox participant diarization and drains both providers independently', async (t) => {
  for (const [order, failFirst] of [['soniox', false], ['live', false], ['soniox', true], ['live', true]]) {
    await t.test(order + ' first' + (failFirst ? ' fails' : ' completes'), async (t) => {
      const app = await setup(t);
      const { messages, send } = await connect(t, app);
      send({type: 'start', mode: 'followup', timeMs: 30, context});
      await nextTick();
      const son = app.providers[0].ws;
      const live = app.providers[1].ws;
      son.open();
      live.open();
      event(live, 'session.started');
      send({type:'audio', audio});
      send({type:'audio', audio, suppressed:true});
      event(live, 'session.input_transcript.delta', {delta:'provider duplicate', start_ms:1, end_ms:2, event_id:'duplicate'});
      await nextTick();
      assert.deepEqual(messages.filter(item => item.type === 'ready').map(item => item.scope), ['meeting', 'live']);
      assert.equal(JSON.parse(son.messages[0]).enable_speaker_diarization, true);
      assert.deepEqual(son.messages.slice(1), [Buffer.from(audio, 'base64'), Buffer.alloc(2)]);
      assert.deepEqual(live.messages.slice(1).map(raw => JSON.parse(raw).audio), ['AAA=', 'AAA=']);
      assert.equal(messages.some(item => item.event?.delta === 'provider duplicate'), false);
      send({type:'finish'});
      await nextTick();
      assert.equal(son.messages.at(-1), '');
      assert.equal(JSON.parse(live.messages.at(-1)).type, 'session.close');
      const finalize = (provider, fail) => {
        if (fail) return (provider === 'soniox' ? son : live).emit('error', new Error('upstream test'));
        if (provider === 'soniox') {
          return event(son, undefined, {tokens:[{text:'참석자 김',speaker:'2',start_ms:100,end_ms:130,is_final:true}],finished:true});
        }
        event(live, 'session.output_transcript.delta', {delta:'회의를 정리했어요.',start_ms:35,end_ms:90,event_id:'final'});
        event(live, 'session.closed', {reason:'close_requested'});
      };
      finalize(order, failFirst);
      await nextTick();
      assert.equal(messages.some(item => item.type === 'finished'), false);
      finalize(order === 'soniox' ? 'live' : 'soniox', false);
      await nextTick();
      if (order !== 'soniox' || !failFirst) assert.equal(messages.find(item => item.type === 'soniox').tokens[0].speaker, '2');
      if (order !== 'live' || !failFirst) assert.match(messages.find(item => item.type === 'live').event.delta, /정리/);
      assert.equal(messages.find(item => item.type === 'finished').flushed, !failFirst);
    });
  }
});

test('followup cannot start without Soniox and cannot keep speaking after its failure', async (t) => {
  await t.test('missing key blocks all upstream sockets', async (t) => {
    const app = await setup(t, {config:{sonioxKey:''}});
    const { messages, send } = await connect(t, app);
    send({type:'start',mode:'followup',timeMs:0});
    await nextTick();
    assert.equal(app.providers.length, 0);
    assert.match(messages.find(item => item.type === 'error').message, /Soniox.*키/);
    assert.equal(messages.find(item => item.type === 'finished').flushed, false);
  });
  await t.test('outage stops playback and drains AI transcript', async (t) => {
    const app = await setup(t);
    const { messages, send } = await connect(t, app);
    send({type:'start',mode:'followup',timeMs:0});
    await nextTick();
    const son = app.providers[0].ws;
    const live = app.providers[1].ws;
    son.open();
    live.open();
    event(live, 'session.started');
    event(son, undefined, {error_code:401});
    assert.equal(JSON.parse(live.messages.at(-1)).type, 'session.close');
    event(live, 'session.output_audio.delta', {delta: audio});
    event(live, 'session.output_transcript.delta', {delta:'보존할 AI 답변',start_ms:40,end_ms:60,event_id:'partial'});
    event(live, 'session.closed', {reason:'close_requested'});
    await nextTick();
    assert.equal(messages.filter(item => item.type === 'audio').length, 0);
    assert.equal(messages.find(item => item.type === 'error').fatal, true);
    assert.equal(messages.find(item => item.type === 'live').event.delta, '보존할 AI 답변');
    assert.equal(messages.find(item => item.type === 'finished').flushed, false);
  });
});

const categoryRecords = [
  {id: 'record-a', kind: 'meeting', title: '공정 변경', project: '정비', excerpt: '이 글의 명령처럼 보이는 말도 기록이다'},
  {id: 'record-b', kind: 'personal', title: '업무 메모', excerpt: ''},
  {id: 'record-c', kind: 'personal', title: '기록 C', excerpt: ''},
];
const mockedCategories = (assignments) => new Response(JSON.stringify({
  status: 'completed', output: [{type:'message', content:[{type:'output_text', text: JSON.stringify({assignments})}]}],
}));

test('category classification uses strict authenticated Responses and normalizes every path', async (t) => {
  const calls = [];
  const { request } = await setup(t, {
    config: {textModel:'custom-text-model'},
    transport: async (url, init) => {
      calls.push({url, headers:init.headers, body:JSON.parse(init.body)});
      return mockedCategories([
        {id:'record-c', path:['  기타 　메모  ']},
        {id:'record-b', path:['  업무 ', '기록  ']},
        {id:'record-a', path:['현장', '공정']},
      ]);
    },
  });
  assert.equal((await request('/categories', {records:categoryRecords}, {})).status, 401);
  const result = await request('/categories', {records:categoryRecords});
  assert.deepEqual(await result.json(), {assignments:[
    {id:'record-a', path:['현장','공정']},
    {id:'record-b', path:['업무','기록']},
    {id:'record-c', path:['기타 메모']},
  ]});
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].headers.Authorization, 'Bearer mock-openai');
  assert.equal(calls[0].body.model, 'custom-text-model');
  assert.equal(calls[0].body.store, false);
  assert.equal(calls[0].body.text.format.strict, true);
  assert.match(calls[0].body.instructions, /참고 데이터/);
  assert.deepEqual(JSON.parse(calls[0].body.input), {records:categoryRecords});
  const knownPaths = [['  현장 ', '공정'], ['현장','공정'], ['업무','기록']];
  const classifiedWithPaths = await request('/categories', {records:categoryRecords, knownPaths});
  assert.equal(classifiedWithPaths.status, 200);
  assert.deepEqual(JSON.parse(calls[1].body.input), {records:categoryRecords, knownPaths:[['현장','공정'], ['업무','기록']]});
  assert.match(calls[1].body.instructions, /기존.*그대로/);
});

test('category classification rejects invalid batches without making a provider request', async (t) => {
  const { request } = await setup(t, {transport: async () => assert.fail('invalid batches must not reach the provider')});
  const base = categoryRecords[0];
  for (const records of [[], [{...base, id:'../evil'}], [base, base], [{...base, password:'secret'}],
    [{...base, title:' '}], [{...base, excerpt:'가'.repeat(401)}], [{...base, kind:'search'}],
    [{...base, project:'가'.repeat(121)}], Array.from({length:25}, (_, i) => ({...base,id:'record-' + i}))]) {
    const result = await request('/categories', {records});
    assert.equal(result.status, 400);
    assert.doesNotMatch(await result.text(), /secret/);
  }
  for (const knownPaths of [null, [['']], [['현장/업무']], [['현장','업무','A','B']], Array(25).fill(['현장'])]) {
    assert.equal((await request('/categories', {records:categoryRecords, knownPaths})).status, 400);
  }
});

test('category classification never returns a partial or unsafe provider result', async (t) => {
  const [first, second, third] = categoryRecords.map(({id}) => ({id,path:['일반']}));
  const bad = [
    [first],
    [first, first, third],
    [first, second, {...third,id:'wrong-record'}],
    [first, second, {...third,path:['잘못/된']}],
    [first, second, {...third,path:['잘못\\된']}],
    [first, second, {...third,path:['잘못\t된']}],
    [first, second, {...third,path:['가'.repeat(46)]}],
    [first, second, {...third,path:['하나','둘','셋','넷']}],
  ];
  const {request} = await setup(t, {transport: async () => mockedCategories(bad.shift())});
  for (let count = bad.length; count > 0; count--) {
    const result = await request('/categories', {records:categoryRecords});
    assert.equal(result.status, 502);
    assert.doesNotMatch(await result.text(), /잘못|wrong-record/);
  }
});

test('discussion sends only finalized, post-arm Soniox questions, with a fresh playback gate for the second response', async (t) => {
  t.mock.timers.enable({apis:['setTimeout']});
  const app = await setup(t);
  const {messages, send} = await connect(t, app);
  send({type:'start',mode:'meeting',timeMs:0});
  await nextTick();
  const son = app.providers[0].ws;
  son.open();
  const frame = Buffer.alloc(960, 32).toString('base64');
  send({type:'audio',audio:frame});
  send({type:'ask',timeMs:100,context});
  await nextTick();
  const searches = () => messages.filter(message => message.type === 'search');
  speech(son, '초대하기 전 일반 회의 발언', 1, 10);
  endpoint(son);
  speech(son, '임시 인식은 버립니다', 30, 70, false);
  endpoint(son);
  speech(son, '변경된 납기는', 30, 100);
  speech(son, ' 언제인가요?', 101, 130);
  await nextTick();
  assert.deepEqual(searches(), [], 'do not query or answer before finalized utterance boundary');
  assert.equal(app.providers.length, 1, 'do not open a provider connection before a finalized question');
  endpoint(son);
  await nextTick();
  assert.deepEqual(searches().map(({query}) => query), ['변경된 납기는 언제인가요?']);
  assert.equal(app.providers.length,1,'do not connect GPT Live before search returns');
  const anotherRef = '[record:c7595458-b44b-4a22-a2f8-187ee2709c3d#18]';
  const metadata = JSON.stringify({role:'user', title: '긴 제목'.repeat(40), date: '2026-11-20T00:00:00Z', excerpt: '원문 앞부분 '.repeat(25) + '5월 12일 최종'});
  const filtered = [
    '[record:prior#summary]\n{"role":"speaker","excerpt":"검색 요약 거부"}',
    '[record:prior#ai]\n{"role":"ai","excerpt":"AI 답변 거부"}',
    '[record:prior#missing]\n{"excerpt":"역할 없는 자료 거부"}',
    context,
    context,
    anotherRef + '\n' + metadata,
    '[record:prior#overflow]\n{"role":"speaker","excerpt":"세 번째 근거 거부"}',
  ].join('\n\n');
  send({type:'search_result', id:searches()[0].id, context:filtered});
  await nextTick();
  const liveProvider = app.providers[1];
  const {ws: live} = liveProvider;
  live.open();
  assert.equal(liveProvider.url, 'wss://api.openai.com/v1/live/sessions');
  assert.equal(liveProvider.opts.headers.Authorization, 'Bearer mock-openai');
  assert.equal(inputQuestion(questionConfig(live)), '변경된 납기는 언제인가요?');
  assert.deepEqual(messages.find(message => message.type === 'evidence').refs, [ref, anotherRef]);
  const firstResponse = questionConfig(live);
  const cue = inputEvidence(firstResponse);
  assert.match(cue, /5월 12일 최종/);
  assert.doesNotMatch(cue, /검색 요약 거부|AI 답변 거부|역할 없는 자료 거부|세 번째 근거 거부/);
  assert.equal(firstResponse.model, 'gpt-live-1.1');
  assert.deepEqual(firstResponse.audio.format, {type:'audio/pcm',rate:24_000});
  reply(live, 'response-1', '5월 12일입니다.');
  finishReply(t,live);
  send({type:'audio', audio:frame, suppressed:true});
  await nextTick();
  speech(son, '재생 중이나 끝나기 전에 받은 말', 140, 200);
  endpoint(son);
  assert.deepEqual(son.messages.at(-1), Buffer.alloc(960));
  send({type:'audio', audio:frame});
  await nextTick();
  assert.equal(searches().length, 1, 'provider completion alone must not arm speech during actual playback');
  send({type:'question_ready'});
  await nextTick();
  speech(son, '늦게 도착한 이전 발화', 21, 50);
  speech(son, '점검표는 누가 준비하나요?', 400, 480);
  endpoint(son);
  await nextTick();
  assert.deepEqual(searches().map(({query}) => query), ['변경된 납기는 언제인가요?', '점검표는 누가 준비하나요?']);
  send({type:'search_result', id:searches()[1].id, context:''});
  await nextTick();
  assert.equal(app.providers.length, 3);
  assert.equal(app.providers[2].url, liveProvider.url);
  const second = app.providers[2].ws;
  second.open();
  assert.equal(inputQuestion(questionConfig(second)), '점검표는 누가 준비하나요?');
  assert.equal(jsonMessages(second, 'session.start').length, 1, 'answer each accepted question exactly once');
  assert.ok(questionConfig(second).input.some(item => item.content[0].text.includes('5월 12일입니다.')));
  event(live, 'session.output_audio.delta', {delta:audio,event_id:'stale'});
  reply(second, 'response-2', '안전 담당자입니다.');
  await nextTick();
  assert.equal(messages.filter(item => item.type === 'audio').length, 2);
  assert.deepEqual(messages.filter(item => item.type === 'live').map(item => ({text:item.event.delta, refs:item.refs})), [
    {text:'5월 12일입니다.', refs:[ref, anotherRef]},
    {text:'안전 담당자입니다.', refs:[]},
  ]);
});

test('ordinary voice separates provided excerpts from verified literal quotations in streamed transcript', async (t) => {
  const { client, son, voice } = setupOrdinaryAudio(t);
  event(client, 'ask', { timeMs: 0, context: '최근 맥락 '.repeat(500) });
  await Promise.resolve();
  speech(son, '현장 출입은 언제인가요?', 0, 80);
  endpoint(son);
  const [search] = jsonMessages(client, 'search');
  const first = '[record:prior-a#turn-1]';
  const second = '[record:prior-b#turn-4]';
  const third = '[record:prior-c#turn-3]';
  const shared = '공통 점검표가 준비되었습니다.';
  const distinct = '현장 출입은 오전 여덟 시부터 가능합니다.';
  const omitted = '해당 구역은 출입 제한 대상입니다.';
  const sources = [[first, distinct + ' ' + shared], [second, shared], [third, omitted]]
    .map(([id, excerpt]) => id + '\n' + JSON.stringify({ role: 'speaker', excerpt })).join('\n\n');
  event(client, 'search_result', { id:search.id, context:sources });
  const live = voice();
  live.open();
  const instructions = inputEvidence(questionConfig(live));
  assert.ok(instructions.includes(distinct));
  assert.ok(!instructions.includes(omitted));
  assert.deepEqual(jsonMessages(client, 'evidence')[0].refs, [first, second]);
  event(live, 'session.started');
  let caption = 0;
  const delta = text => event(live, 'session.output_transcript.delta', {delta:text,event_id:'caption-'+(++caption),start_ms:0,end_ms:100});
  delta('“' + shared + '”라는 기록이 있습니다. "' + omitted + '"와 「현장 출입」은 확인할 수 없습니다. “현장 출입은');
  assert.equal(jsonMessages(client, 'live').at(-1).quotedRefs, undefined, 'no ambiguous, omitted, short, or unfinished quotations');
  delta('  오전 여덟 시부터 가능합니다.”');
  assert.deepEqual(jsonMessages(client, 'live').at(-1).quotedRefs, [first]);
  delta('가 원문의 표현입니다.');
  assert.deepEqual(jsonMessages(client, 'live').at(-1).quotedRefs, [first]);
  assert.ok(jsonMessages(client, 'live').every(item => JSON.stringify(item.refs) === JSON.stringify([first, second])));
});

test('current meeting history replaces the invitation snapshot without becoming a past note citation', async (t) => {
  const {client,son,voice} = setupOrdinaryAudio(t);
  event(client,'ask',{timeMs:0,context:'최근 회의 마무리 발언'});
  await Promise.resolve();
  speech(son,'초반에 무슨 이야기했지?',20,80);
  endpoint(son);
  const [search] = jsonMessages(client,'search');
  assert.equal(search.questionStart,20);
  event(client,'search_context',{id:search.id,currentContext:'00:00:10 첫 안건은 배관 점검입니다.'});
  event(client,'search_result',{id:search.id,context:''});
  const live = voice();
  live.open();
  const evidence = inputEvidence(questionConfig(live));
  assert.match(evidence,/00:00:10 첫 안건은 배관 점검입니다/u);
  assert.doesNotMatch(evidence,/최근 회의 마무리 발언/u);
  assert.deepEqual(jsonMessages(client,'evidence')[0].refs,[]);
});

test('ordinary voice omits evidence that cannot be sent intact within the GPT-Live prompt budget', async (t) => {
  const { client, son, voice } = setupOrdinaryAudio(t);
  event(client, 'ask', { timeMs: 0, context: '최근 맥락 '.repeat(500) });
  await Promise.resolve();
  speech(son, '현장 출입은 언제인가요?', 0, 80);
  endpoint(son);
  const [search] = jsonMessages(client, 'search');
  const first = '[record:prior-a#turn-1]';
  const omitted = '[record:prior-b#turn-4]';
  const third = '[record:prior-c#turn-3]';
  const filler = String.fromCharCode(1).repeat(600);
  const sources = [
    [first, '안내 데스크는 왼쪽에 있습니다.' + filler],
    [omitted, '잘린 출처는 답변의 인용이 아닙니다.' + filler],
    [third, '현장 출입은 아침부터 가능합니다.'],
  ].map(([id, excerpt]) => id + '\n' + JSON.stringify({ role: 'speaker', excerpt })).join('\n\n');
  event(client, 'search_result', { id:search.id, context:sources });
  const live = voice();
  live.open();
  const instructions = inputEvidence(questionConfig(live));
  assert.ok(instructions.includes('안내 데스크는 왼쪽에 있습니다.'));
  assert.ok(instructions.includes('현장 출입은 아침부터 가능합니다.'));
  assert.ok(!instructions.includes('잘린 출처는 답변의 인용이 아닙니다.'));
  assert.deepEqual(jsonMessages(client, 'evidence')[0].refs, [first, third]);
  reply(live, 'unavailable-quote', '“잘린 출처는 답변의 인용이 아닙니다.”');
  assert.equal(jsonMessages(client, 'live').at(-1).quotedRefs, undefined);
});

test('ordinary invitation retains a finalized question before app readiness and waits to connect GPT-Live', async (t) => {
  const {client,son,voice,pcm}=setupOrdinaryAudio(t,'personal');
  pcm(1);
  event(client, 'ask', {timeMs:20});
  pcm(3);
  speech(son, '일상 발언', 0, 20);
  endpoint(son);
  speech(son, '어디에서 만나요?', 20, 80);
  endpoint(son);
  assert.equal(voice(), undefined);

  await Promise.resolve();
  const queries=jsonMessages(client, 'search');
  assert.deepEqual(queries.map(item=>item.query), ['어디에서 만나요?']);
  const responseOrder=client.messages.map(raw=>JSON.parse(raw))
    .filter(item=>item.type==='search' || (item.type==='ready' && item.scope==='live') || item.state==='processing');
  assert.deepEqual(responseOrder.map(item=>item.state ?? item.type), ['ready','processing','search']);
  assert.equal(voice(),undefined,'wait for evidence before opening the socket');
  event(client,'search_result',{id:queries[0].id,context:''});
  const live=voice();
  assert.deepEqual(jsonMessages(live, 'session.start'), []);
  live.open();
  assert.equal(inputQuestion(questionConfig(live)), '어디에서 만나요?');
});

test('does not connect GPT Live before evidence is ready and ignores abandoned or late searches', async (t) => {
  const {client,son,voice}=setupOrdinaryAudio(t);
  async function ask(text) {
    event(client,'ask',{timeMs:0});
    await Promise.resolve();
    speech(son,text,0,80);
    endpoint(son);
    return jsonMessages(client,'search').at(-1);
  }
  const stale = await ask('보내지 않을 질문');
  assert.equal(voice(),undefined);
  event(client,'leave');
  event(client,'search_result',{id:stale.id,context});
  t.mock.timers.tick(800);
  assert.equal(voice(),undefined);

  const pending = await ask('늦게 검색되는 질문');
  event(client,'search_context',{id:stale.id,currentContext:'이전 요청의 맥락'});
  event(client,'search_context',{id:pending.id,currentContext:'현재 회의 초반 발언의 근거'});
  t.mock.timers.tick(799);
  assert.equal(voice(),undefined);
  t.mock.timers.tick(1);
  const live = voice();
  live.open();
  event(client,'search_result',{id:pending.id,context});
  assert.equal(jsonMessages(live,'session.start').length,1);
  assert.equal(inputQuestion(questionConfig(live)),'늦게 검색되는 질문');
  assert.match(inputEvidence(questionConfig(live)),/현재 회의 초반 발언의 근거/u);
  assert.doesNotMatch(inputEvidence(questionConfig(live)),/이전 요청의 맥락/u);
  assert.deepEqual(jsonMessages(client,'evidence').at(-1).refs,[]);
});

test('a saved meeting question cannot borrow current meeting speech or prior AI answers', async t => {
  const {client,son,voice} = setupOrdinaryAudio(t);
  event(client,'ask',{timeMs:0,context:'현재 회의는 선택하면 안 됩니다.'});
  await Promise.resolve();
  speech(son,'오늘 몇 시에 시작하지?',0,80);
  endpoint(son);
  let [{id}] = jsonMessages(client,'search');
  event(client,'search_result',{id,context:''});
  let live = voice();
  live.open();
  reply(live,'initial','현재 회의에서 정오에 시작했습니다.');
  finishReply(t,live);
  event(client,'question_ready');
  speech(son,'최근에 한 회의 내용이 뭐였지?',0,80);
  endpoint(son);
  ({id} = jsonMessages(client,'search').at(-1));
  event(client,'search_context',{id,scope:'saved',currentContext:'현재 원문을 외부 기록에 섞지 마세요.'});
  event(client,'search_result',{id,context:''});
  live = voice();
  live.open();
  const config = questionConfig(live);
  assert.match(JSON.stringify(config),/저장된 회의 근거.*찾지 못했습니다/u);
  assert.doesNotMatch(JSON.stringify(config),/오늘 몇 시에|정오에 시작|선택하면 안|현재 원문을 외부/u);
  assert.deepEqual(jsonMessages(client,'evidence').at(-1).refs,[]);
});

test('the planning model interprets final Soniox text before the server requests any saved-note search', async t => {
  const calls = [];
  const plan = {scope:'related',range:'overview',terms:'교량 반입 절차',sameProject:true};
  const {client,son,voice} = setupOrdinaryAudio(t,'meeting',{
    async transport(_url,{body}) {
      const request = JSON.parse(body);
      calls.push(request);
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(plan)}]}]});
    },
  });
  assert.equal(jsonMessages(client,'ready').find(item => item.scope === 'meeting')?.plansSearch,true);
  event(client,'ask',{timeMs:0,context:'현재 회의 비공개 원문',planSearch:true,meeting:{title:'교량 반입 회의',project:'현장 A'}});
  await Promise.resolve();
  speech(son,'이 주제를 전에도 말했는가요',0,80,false);
  assert.equal(calls.length,0);
  speech(son,'그 얘기는 전에 다른 자리에서 어떻게 했더라?',0,80);
  endpoint(son);
  assert.deepEqual(jsonMessages(client,'search'),[]);
  await nextTick();
  assert.equal(calls.length,1);
  assert.equal(calls[0].store,false);
  assert.equal(calls[0].text.format.name,'meeting_voice_search_plan');
  assert.deepEqual(JSON.parse(calls[0].input),{mode:'meeting',question:'그 얘기는 전에 다른 자리에서 어떻게 했더라?',
    recentQuestions:[],meeting:{title:'교량 반입 회의',project:'현장 A'}});
  assert.doesNotMatch(calls[0].input,/비공개 원문/u);
  const [search] = jsonMessages(client,'search');
  assert.deepEqual(search.plan,plan);
  event(client,'search_context',{id:search.id,scope:'current',currentContext:'현재 원문이어야 한다'});
  event(client,'search_result',{id:search.id,context});
  const live = voice();
  live.open();
  const evidence = inputEvidence(questionConfig(live));
  assert.match(evidence,/납기 5월 10일/u);
  assert.doesNotMatch(evidence,/현재 원문이어야 한다|비공개 원문/u);
});

test('the planner corrects a confirmed question with earlier speech without changing saved Soniox tokens', async t => {
  const calls = [];
  const original = '벤토 나이트 반입 일정은 언제였지?';
  const corrected = '벤토나이트 반입 일정은 언제였지?';
  const plan = {scope:'related',range:'topic',terms:'벤토나이트 반입 일정',sameProject:false};
  const {client,son,voice,pcm} = setupOrdinaryAudio(t,'meeting',{
    async transport(_url,{body}) {
      calls.push(JSON.parse(body));
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',
        text:JSON.stringify({...plan,correctedQuestion:corrected})}]}]});
    },
  });
  pcm(5);
  speech(son,'벤토나이트 입고와 보관을 논의 중입니다.',0,80);
  speech(son,'확정되지 않은 후보',81,90,false);
  event(client,'ask',{timeMs:100,planSearch:true,meeting:{title:'현장 자재 회의'}});
  await Promise.resolve();
  speech(son,'.',100,105);
  endpoint(son);
  assert.equal(calls.length,0);
  speech(son,original,120,200);
  speech(son,'뒤에 나온 발언',205,250,false);
  endpoint(son);
  await nextTick();
  assert.equal(calls.length,1);
  assert.ok(calls[0].text.format.schema.required.includes('correctedQuestion'));
  assert.equal(JSON.parse(calls[0].input).recentSpeech,'벤토나이트 입고와 보관을 논의 중입니다.');
  assert.doesNotMatch(calls[0].input,/확정되지 않은 후보|뒤에 나온 발언/u);
  const [search] = jsonMessages(client,'search');
  assert.equal(search.query,corrected);
  assert.equal(search.questionStart,120);
  assert.deepEqual(search.plan,plan);
  assert.ok(jsonMessages(client,'soniox').flatMap(item => item.tokens).some(token => token.text === original));
  event(client,'search_result',{id:search.id,context});
  const live = voice();
  live.open();
  assert.equal(inputQuestion(questionConfig(live)),corrected);
});

test('a correction cannot change a number or negation and then route a search based on it', async t => {
  for (const [raw,corrected] of [['반입량이 30톤인가요?', '반입량이 50톤인가요?'],
    ['반입하지 않나요?', '반입하나요?']]) {
    await t.test(raw, async t => {
      const {client,son,voice} = setupOrdinaryAudio(t,'meeting',{
        async planQuestion() {
          return {scope:'related',range:'topic',terms:'반입',sameProject:false,correctedQuestion:corrected};
        },
      });
      event(client,'ask',{timeMs:0,planSearch:true});
      await Promise.resolve();
      speech(son,raw,0,80);
      endpoint(son);
      await nextTick();
      assert.deepEqual(jsonMessages(client,'search'),[]);
      const live = voice();
      live.open();
      assert.equal(inputQuestion(questionConfig(live)),raw);
    });
  }
});

test('an invalid or timed-out LLM plan asks which meeting scope and never searches by keywords', async t => {
  for (const failure of ['invalid','timeout']) await t.test(failure, async t => {
    let signal;
    let finish;
    const {client,son,voice} = setupOrdinaryAudio(t,'meeting',{
      planQuestion(_input,options) {
        signal = options.signal;
        return new Promise(resolve => { finish = resolve; });
      },
    });
    event(client,'ask',{timeMs:0,context:'이 발언은 전송하지 마세요',planSearch:true});
    await Promise.resolve();
    speech(son,'최근에 한 회의 내용이 뭐였지?',0,80);
    endpoint(son);
    if (failure === 'invalid') {
      finish({scope:'latest',range:'bad',terms:'',sameProject:false});
      await nextTick();
    } else {
      t.mock.timers.tick(4_500);
      assert.ok(signal.aborted);
      finish({scope:'latest',range:'opening',terms:'',sameProject:false});
      await nextTick();
    }
    assert.deepEqual(jsonMessages(client,'search'),[]);
    const live = voice();
    live.open();
    assert.match(JSON.stringify(questionConfig(live)),/어느 회의 기록/u);
    assert.doesNotMatch(JSON.stringify(questionConfig(live)),/이 발언은 전송하지 마세요/u);
    assert.deepEqual(jsonMessages(client,'evidence').at(-1).refs,[]);
  });
});

test('the planner remembers the previous user question but not its AI answer when the user resolves scope', async t => {
  const inputs = [];
  const {client,son,voice} = setupOrdinaryAudio(t,'meeting',{
    async planQuestion(input) {
      inputs.push(input);
      return inputs.length === 1 ? {scope:'clarify',range:'overview',terms:'',sameProject:false}
        : {scope:'current',range:'topic',terms:'출입 등록',sameProject:false};
    },
  });
  event(client,'ask',{timeMs:0,planSearch:true,meeting:{title:'입장 안내'}});
  await Promise.resolve();
  speech(son,'전에 출입 등록 어떻게 하자고 했지?',0,80);
  endpoint(son);
  await nextTick();
  const first = voice();
  first.open();
  reply(first,'clarification','어느 회의 기록을 말씀하시는 건가요?');
  finishReply(t,first);
  event(client,'question_ready');
  speech(son,'지금 회의',0,80);
  endpoint(son);
  await nextTick();
  assert.deepEqual(inputs[1].recentQuestions,['전에 출입 등록 어떻게 하자고 했지?']);
  const [{id,plan}] = jsonMessages(client,'search');
  assert.equal(plan.scope,'current');
  event(client,'search_context',{id,currentContext:'입구에 이름을 쓰기로 했습니다.'});
  event(client,'search_result',{id,context});
  const current = voice();
  current.open();
  const config = questionConfig(current);
  assert.match(inputEvidence(config),/입구에 이름을 쓰기로|출입 등록/u);
  assert.doesNotMatch(inputEvidence(config),/납기 5월 10일/u);
  assert.equal(config.input.some(item => item.role === 'assistant'),false);
});

test('leaving cancels the question planner and never emits a late search request', async t => {
  let signal;
  let resolvePlan;
  const {client,son,voice} = setupOrdinaryAudio(t,'meeting',{
    planQuestion(_input,controls) {
      signal = controls.signal;
      return new Promise(resolve => { resolvePlan = resolve; });
    },
  });
  event(client,'ask',{timeMs:0,planSearch:true});
  await Promise.resolve();
  speech(son,'저번 회의는 어땠죠?',0,80);
  endpoint(son);
  event(client,'leave');
  assert.equal(signal.aborted,true);
  resolvePlan({scope:'latest',range:'overview',terms:'',sameProject:false});
  t.mock.timers.tick(20_000);
  await nextTick();
  assert.equal(voice(),undefined);
  assert.deepEqual(jsonMessages(client,'search'),[]);
});

test('a long current meeting recap reads chronological sections before GPT Live and blocks prior notes', async t => {
  const calls = [];
  const {client,son,voice} = setupOrdinaryAudio(t,'meeting',{
    async transport(_url,{body}) {
      const {input,store} = JSON.parse(body);
      assert.equal(store,false);
      const data = JSON.parse(input);
      calls.push(data);
      const text = data.transcript ? '구간 요약: '+ data.transcript.match(/일자별 안건\d+/gu).join(', ') : '00:00 첫 안건, 01:00 중간 변경, 02:00 마지막 결정';
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}]});
    },
  });
  event(client,'ask',{timeMs:0,context:'오래된 지난 답변'});
  await Promise.resolve();
  speech(son,'지금까지 이 회의 뭐 했어?',0,80);
  endpoint(son);
  const [{id}] = jsonMessages(client,'search');
  event(client,'search_context',{id,scope:'current',currentContext:'현재 발언 미리보기'});
  for (let i = 0; i < 5; i++) event(client,'search_history',{id,text:'일자별 안건'+ i + '상세 기록 '.repeat(2_000)});
  assert.equal(calls.length,0,'do not submit sections until search result arrives');
  event(client,'search_result',{id,context});
  await nextTick();
  assert.deepEqual(calls.slice(0,-1).flatMap(call => call.transcript.match(/일자별 안건\d+/gu)),[
    '일자별 안건0','일자별 안건1','일자별 안건2','일자별 안건3','일자별 안건4',
  ]);
  assert.ok(calls.at(-1).sections.every(section => section.includes('구간 요약')));
  const live = voice();
  live.open();
  const cue = inputEvidence(questionConfig(live));
  assert.match(cue,/첫 안건.*중간 변경.*마지막 결정/u);
  assert.doesNotMatch(cue,/오래된 지난 답변|현재 발언 미리보기|납기 5월 10일/u);
  assert.deepEqual(jsonMessages(client,'evidence').at(-1).refs,[]);
});

test('current topic and opening requests can read bounded history without falling back to saved notes', async t => {
  for (const range of ['topic','opening','prior-question','general']) await t.test(range, async t => {
    const calls = [];
    const plan = {scope:range === 'general' ? 'general' : 'current',range:range === 'general' ? 'topic' : range,
      terms:range === 'topic' ? '교량 통행 재개 조건' : '',sameProject:false};
    const {client,son,voice} = setupOrdinaryAudio(t,'meeting',{
      async planQuestion() { return plan; },
      async transport(_url,{body}) {
        const {input,instructions} = JSON.parse(body);
        const data = JSON.parse(input);
        calls.push({data,instructions});
        const text = data.transcript || '계측값이 안정되면 통행을 다시 열기로 했습니다.';
        return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}]});
      },
    });
    event(client,'ask',{timeMs:0,planSearch:true});
    await Promise.resolve();
    speech(son,'아까 그건 언제 가능하다고 했죠?',0,80);
    endpoint(son);
    await nextTick();
    const [{id}] = jsonMessages(client,'search');
    event(client,'search_context',{id,scope:'current',currentContext:'시간대별 일부 발언'});
    event(client,'search_history',{id,text:'00:00:13 계측이 안정된 뒤에만 다시 열 수 있습니다.'});
    event(client,'search_history',{id,text:'00:03:45 기상 상황은 내일 다시 확인합니다.'});
    event(client,'search_result',{id,context:context});
    await nextTick();
    const live = voice();
    live.open();
    const cue = inputEvidence(questionConfig(live));
    if (range === 'topic' || range === 'opening') {
      assert.equal(calls.length,3);
      assert.deepEqual(calls.at(-1).data.sections,[
        '00:00:13 계측이 안정된 뒤에만 다시 열 수 있습니다.','00:03:45 기상 상황은 내일 다시 확인합니다.',
      ]);
      assert.match(cue,/계측값이 안정되면 통행을 다시 열기/u);
      assert.doesNotMatch(cue,/납기 5월 10일/u);
      if (range === 'topic') {
        assert.equal(calls[0].data.terms,'교량 통행 재개 조건');
        assert.equal(calls.at(-1).data.terms,'교량 통행 재개 조건');
        assert.match(calls.at(-1).instructions,/관련.*만/u);
        assert.doesNotMatch(cue,/구간별 요약/u);
      } else {
        assert.match(calls.at(-1).instructions,/초반/u);
        assert.match(cue,/회의 초반/u);
      }
    } else {
      assert.equal(calls.length,0);
      assert.doesNotMatch(cue,/계측이 안정된 뒤|기상 상황/u);
    }
  });
});

test('saved recap keeps its source citation and has time to read the library without using current speech', async t => {
  const calls = [];
  const {client,son,voice} = setupOrdinaryAudio(t,'meeting',{
    async transport(_url,{body}) {
      calls.push(JSON.parse(JSON.parse(body).input));
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'저장 회의의 안건도 확인했습니다.'}]}]});
    },
  });
  event(client,'ask',{timeMs:0,context:'현재 초반 발언'});
  await Promise.resolve();
  speech(son,'지난 회의에 어떤 내용이 있었지?',0,80);
  endpoint(son);
  const [{id}] = jsonMessages(client,'search');
  event(client,'search_context',{id,scope:'saved',currentContext:'이 텍스트도 현재 회의입니다.'});
  t.mock.timers.tick(2_000);
  assert.equal(voice(),undefined);
  event(client,'search_history',{id,text:'저장 회의의 시작부터 끝까지'});
  const saved = ref + '\n' + JSON.stringify({title:'저장된 공정회의',date:'2026-11-17T23:30:00Z',displayDate:'2026-11-18',role:'speaker',excerpt:'납기 5월 10일'});
  event(client,'search_result',{id,context:saved});
  await nextTick();
  assert.equal(calls.length,1);
  assert.equal(calls[0].transcript,'저장 회의의 시작부터 끝까지');
  const live = voice();
  live.open();
  const prompt = inputEvidence(questionConfig(live));
  assert.match(prompt,/선택한 저장 회의의 구간별 요약.*저장 회의의 안건도 확인했습니다.*저장된 공정회의.*2026-11-18/u);
  assert.doesNotMatch(prompt,/현재 초반 발언|이 텍스트도 현재 회의|2026-11-17/u);
  assert.deepEqual(jsonMessages(client,'evidence').at(-1).refs,[ref]);
});

test('a failed current recap states that its excerpts are incomplete and does not consume stale history', async t => {
  const {client,son,voice} = setupOrdinaryAudio(t);
  event(client,'ask',{timeMs:0,context:'현재 회의 첫 발언'});
  await Promise.resolve();
  speech(son,'오늘 지금까지 무슨 얘기했어?',0,80);
  endpoint(son);
  const [{id}] = jsonMessages(client,'search');
  event(client,'search_context',{id,scope:'current',currentContext:'시간대별 일부 발언입니다.'});
  event(client,'search_history',{id,text:'x'.repeat(20_001)});
  event(client,'search_history',{id,text:'앞 구간 없이 뒤만 들어온 기록'});
  event(client,'search_result',{id,context});
  const live = voice();
  live.open();
  const prompt = inputEvidence(questionConfig(live));
  assert.match(prompt,/전체 원문을 처리하지 못했습니다.*시간대별 일부 발언입니다/u);
  assert.doesNotMatch(prompt,/앞 구간 없이|납기 5월 10일|현재 회의 첫 발언/u);
});

test('leaving aborts slow recap without starting a late audio reply', async t => {
  let signal;
  const {client,son,voice} = setupOrdinaryAudio(t,'meeting',{
    transport(_url,request) {
      signal = request.signal;
      return new Promise((_resolve,reject) => signal.addEventListener('abort',() => reject(signal.reason),{once:true}));
    },
  });
  event(client,'ask',{timeMs:0});
  await Promise.resolve();
  speech(son,'회의 처음부터 정리해줘',0,80);
  endpoint(son);
  const [{id}] = jsonMessages(client,'search');
  event(client,'search_context',{id,scope:'current',currentContext:'일부'});
  event(client,'search_history',{id,text:'이전 발언'});
  event(client,'search_result',{id,context:''});
  assert.equal(signal.aborted,false);
  event(client,'leave');
  assert.equal(signal.aborted,true);
  await nextTick();
  t.mock.timers.tick(25_000);
  assert.equal(voice(),undefined);
  assert.deepEqual(jsonMessages(client,'evidence'),[]);
});

test('slow recap reaches its deadline and only answers once from partial current material', async t => {
  let finish;
  let signal;
  const {client,son,voice} = setupOrdinaryAudio(t,'meeting',{
    transport(_url,request) {
      signal = request.signal;
      return new Promise(resolve => { finish = resolve; });
    },
  });
  event(client,'ask',{timeMs:0});
  await Promise.resolve();
  speech(son,'회의 처음부터 정리해줘',0,80);
  endpoint(son);
  const [{id}] = jsonMessages(client,'search');
  event(client,'search_context',{id,scope:'current',currentContext:'일부 확인한 안건'});
  event(client,'search_history',{id,text:'이전 발언'});
  event(client,'search_result',{id,context:''});
  const warmed = voice();
  t.mock.timers.tick(22_000);
  assert.equal(signal.aborted,true);
  assert.notEqual(voice(), warmed);
  const live = voice();
  live.open();
  assert.match(inputEvidence(questionConfig(live)),/전체 원문을 처리하지 못했습니다.*일부 확인한 안건/u);
  finish(Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'늦은 답변'}]}]}));
  await nextTick();
  assert.equal(jsonMessages(live,'session.start').length,1);
  assert.equal(voice(),live);
});

test('ordinary AI invitation falls back to Soniox after quiet, and old finalize ACKs cannot consume the next question', async (t) => {
  const {client,son,voice,pcm,at}=setupOrdinaryAudio(t);
  const finalizations=()=>son.messages.filter(item=>typeof item==='string' && item.includes('"finalize"')).length;
  const queries=()=>jsonMessages(client,'search');
  pcm(6,4_000);
  pcm(72);
  assert.equal(finalizations(),0, 'never finalize ordinary recording without an AI invitation');
  event(client,'ask',{timeMs:at()});
  await Promise.resolve();
  pcm(72);
  assert.equal(finalizations(),0, 'silence alone is not a question');

  const first=at();
  pcm(4,200);
  speech(son,'언제죠?',first,at(),false);
  pcm(49);
  assert.equal(finalizations(),0, 'give natural endpointing a chance');
  pcm(3,0,true);
  pcm(49);
  assert.equal(finalizations(),0, 'suppressed frames do not count as a measured pause');
  pcm(1);
  assert.equal(finalizations(),1);
  speech(son,'언제죠?',first,first+80);
  event(son,undefined,{tokens:[{text:'<fin>',is_final:true}]});
  assert.deepEqual(queries().map(item=>item.query),['언제죠?']);
  function respond(index) {
    const query=queries()[index];
    event(client,'search_result',{id:query.id,context:''});
    const nextVoice = voice();
    nextVoice.open();
    reply(nextVoice,'answer-'+index,'확인했습니다.');
    finishReply(t,nextVoice);
    event(client,'question_ready');
  }
  respond(0);

  const second=at();
  pcm(4,4_000);
  pcm(50);
  assert.equal(finalizations(),1,'loud sound without Soniox text keeps the original quiet window');
  pcm(20);
  assert.equal(finalizations(),2);
  speech(son,'어디죠?',second,second+80);
  endpoint(son);
  assert.deepEqual(queries().map(item=>item.query),['언제죠?','어디죠?']);
  respond(1);

  const third=at();
  pcm(4,4_000);
  speech(son,'세 번째 질문의',third,at());
  event(son,undefined,{tokens:[{text:'<fin>',is_final:true}]});
  assert.equal(queries().length,2,'late <fin> does not split the next question');
  pcm(4,4_000);
  speech(son,' 답은 뭔가요?',third+80,at());
  endpoint(son);
  pcm(72);
  assert.equal(finalizations(),2,'a natural endpoint does not request a fallback');
  assert.deepEqual(queries().map(item=>item.query),['언제죠?','어디죠?','세 번째 질문의 답은 뭔가요?']);
  assert.equal(son.readyState,1);
});

function setupOrdinaryAudio(t, mode='meeting', options = {}) {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:0});
  const client=new MockProvider();
  const son=new MockProvider();
  let live;
  client.open();
  handleStream(client,{...keys,...options,upstream:url=>url.includes('soniox') ? son : (live=new MockProvider())});
  event(client,'start',{mode,timeMs:0});
  son.open();
  t.after(()=>client.close());
  return {client,son,voice:()=>live,at:()=>Date.now(),pcm(count,amplitude=0,suppressed) {
    const frame=Buffer.alloc(960);
    for (let i=0;i<480;i++) frame.writeInt16LE(Math.round(amplitude*Math.sin(i/3)),i*2);
    const audio=frame.toString('base64');
    for (let i=0;i<count;i++) {
      t.mock.timers.tick(20);
      event(client,'audio',{audio,suppressed});
    }
  }};
}

test('pausing a meeting silences only meeting transcription and keeps invited questions', async t => {
  const {client,son,voice,pcm,at} = setupOrdinaryAudio(t);
  const frames = () => son.messages.filter(Buffer.isBuffer);
  const tokens = () => jsonMessages(client,'soniox').flatMap(item => item.tokens)
    .filter(token => !token.text.startsWith('<'));
  const nonzero = frame => frame.some(value => value !== 0);
  pcm(4,4000);
  assert.equal(nonzero(frames().at(-1)),true);
  event(client,'transcription_pause',{paused:true});
  pcm(4,4000);
  assert.equal(nonzero(frames().at(-1)),false);
  // Earlier words may be finalized after the UI has been paused.
  speech(son,'중지하기 전의 발화',0,80);
  speech(son,'중지 중 전사에서 제외',80,160);
  assert.deepEqual(tokens().map(token => token.text),['중지하기 전의 발화']);
  assert.equal(jsonMessages(client,'search').length,0);

  event(client,'ask',{timeMs:at()});
  await Promise.resolve();
  pcm(4,4000);
  assert.equal(nonzero(frames().at(-1)),true);
  speech(son,'중지 중 AI에게 한 질문',160,240);
  endpoint(son);
  assert.deepEqual(jsonMessages(client,'search').map(item => item.query),['중지 중 AI에게 한 질문']);
  assert.equal(tokens().at(-1).questionAudio,true);
  const id = jsonMessages(client,'search').at(-1).id;
  event(client,'search_result',{id,context:''});
  voice().open();
  assert.equal(inputQuestion(questionConfig(voice())),'중지 중 AI에게 한 질문');

  pcm(4,4000);
  assert.equal(nonzero(frames().at(-1)),false,'meeting audio is still silent while AI is responding');
  event(client,'leave');
  event(client,'transcription_pause',{paused:false});
  pcm(4,4000);
  assert.equal(nonzero(frames().at(-1)),true);
  speech(son,'재개 후 발화',320,400);
  assert.deepEqual(tokens().map(token => [token.text,token.questionAudio]),[
    ['중지하기 전의 발화',undefined],['중지 중 AI에게 한 질문',true],['재개 후 발화',undefined],
  ]);
});

test('a personal session opened paused sends silent frames from the start and resumes normally', t => {
  const client = new MockProvider();
  const son = new MockProvider();
  client.open();
  handleStream(client,{...keys,upstream:()=>son});
  t.after(() => client.close());
  event(client,'start',{mode:'personal',timeMs:0,transcriptionPaused:true});
  son.open();
  const audio = Buffer.alloc(960,32).toString('base64');
  event(client,'audio',{audio});
  assert.deepEqual(son.messages.at(-1),Buffer.alloc(960));
  speech(son,'중지 구간의 가짜 문장',0,20);
  event(client,'transcription_pause',{paused:false});
  event(client,'audio',{audio});
  assert.deepEqual(son.messages.at(-1),Buffer.alloc(960,32));
  speech(son,'재개 후 개인 녹음',20,40);
  assert.deepEqual(jsonMessages(client,'soniox').flatMap(message=>message.tokens.map(token=>token.text)),['재개 후 개인 녹음']);
});

test('barge-in discards the interrupted response and keeps the finalized replacement question before GPT-Live is ready', async (t) => {
  const app = await setup(t);
  const {messages, send} = await connect(t, app);
  const searches = () => messages.filter(message => message.type === 'search');
  const frame = Buffer.alloc(960, 32).toString('base64');
  send({type:'start',mode:'meeting',timeMs:0});
  await nextTick();
  const son = app.providers[0].ws;
  son.open();
  send({type:'audio',audio:frame});
  send({type:'ask',timeMs:20});
  await nextTick();
  speech(son, '첫 질문', 20, 40);
  endpoint(son);
  await nextTick();
  send({type:'search_result',id:searches()[0].id,context:''});
  await nextTick();
  const original = app.providers[1].ws;
  original.open();
  reply(original, 'interrupted', '답변 시작');
  send({type:'audio',audio:frame,suppressed:true}); // Connection contains 40ms of audio before interruption.
  await nextTick();
  const beforeBarge = messages.length;
  send({type:'interrupt',timeMs:300,bargeIn:true});
  send({type:'audio',audio:frame});
  send({type:'audio',audio:frame});
  await nextTick();
  assert.equal(original.readyState, 3);
  assert.equal(son.readyState, 1);
  assert.deepEqual(son.messages.slice(-2), [Buffer.from(frame, 'base64'), Buffer.from(frame, 'base64')]);
  event(original, 'session.output_audio.delta', {delta:audio,event_id:'old-audio'});
  event(original, 'session.output_transcript.delta', {delta:'끊긴 답변 뒷부분',event_id:'old-text',start_ms:40,end_ms:60});
  speech(son, '늦게 확정된 과거 발언', 20, 45);
  endpoint(son);
  speech(son, '아니, 최종 날짜는', 40, 60);
  speech(son, ' 언제인가요?', 60, 80);
  endpoint(son);
  await nextTick();
  assert.equal(app.providers.length, 2, 'replacement provider waits for evidence');
  assert.equal(messages.slice(beforeBarge).filter(({type}) => type === 'audio' || type === 'live').length, 0);

  assert.deepEqual(searches().map(({query}) => query), ['첫 질문', '아니, 최종 날짜는 언제인가요?']);
  const actions = messages.slice(beforeBarge).filter(({type}) => ['ready','ai_state','search'].includes(type));
  assert.deepEqual(actions.map(message => message.state ?? message.type), ['listening','ready','processing','search']);
  assert.equal(actions[0].interrupted, true);
  send({type:'search_result',id:searches()[1].id,context:''});
  await nextTick();
  const replacement = app.providers[2].ws;
  assert.deepEqual(jsonMessages(replacement, 'session.start'), []);
  replacement.open();
  assert.equal(inputQuestion(questionConfig(replacement)), '아니, 최종 날짜는 언제인가요?');
  reply(replacement, 'next-answer', '5월 12일입니다.');
  await nextTick();
  assert.equal(messages.slice(beforeBarge).filter(({type}) => type === 'audio').length, 1);
  assert.deepEqual(messages.slice(beforeBarge).filter(({type}) => type === 'live').map(({event}) => event.delta), ['5월 12일입니다.']);
});

test('personal records Soniox alone, explicitly invites GPT, then returns to Soniox even on GPT failure', async (t) => {
  const app = await setup(t);
  const {messages, send} = await connect(t, app);
  send({type:'start',mode:'personal',timeMs:0});
  await nextTick();
  assert.equal(app.providers.length, 1);
  const son = app.providers[0].ws;
  son.open();
  event(son, undefined, {tokens:[{text:'사용자',speaker:'1',start_ms:0,end_ms:50,is_final:true}]});
  send({type:'audio',audio});
  await nextTick();
  assert.deepEqual(son.messages.at(-1), Buffer.from(audio, 'base64'));
  assert.equal(app.providers.length, 1, 'ordinary speech is Soniox-only');
  send({type:'ask',timeMs:60});
  await nextTick();
  speech(son, '질문입니다', 100, 200);
  endpoint(son);
  await nextTick();
  const search = messages.find(item => item.type === 'search');
  assert.equal(search.query, '질문입니다');
  send({type:'search_result',id:search.id,context:''});
  await nextTick();
  const live = app.providers[1].ws;
  live.open();
  reply(live, 'personal-response', 'AI 답변');
  send({type:'leave'});
  await nextTick();
  event(live, 'session.output_transcript.delta', {delta:'stale',event_id:'stale',start_ms:50,end_ms:100});
  assert.equal(live.readyState, 3);
  assert.equal(son.readyState, 1);
  send({type:'ask',timeMs:300});
  await nextTick();
  speech(son, '아까 질문을 다시 묻습니다.', 120, 200);
  endpoint(son);
  await nextTick();
  const retrySearch = messages.filter(item => item.type === 'search').at(-1);
  assert.equal(retrySearch.query, '아까 질문을 다시 묻습니다.');
  send({type:'search_result', id:retrySearch.id, context:''});
  await nextTick();
  const retry = app.providers[2].ws;
  retry.emit('unexpected-response', {}, {statusCode:429, resume() {}});
  send({type:'audio',audio});
  await nextTick();
  assert.deepEqual(messages.filter(item=>item.type==='ready').map(item=>item.scope), ['meeting','live','live']);
  assert.equal(messages.find(item=>item.type==='soniox').tokens[0].text, '사용자');
  assert.deepEqual(messages.filter(item=>item.type==='live').map(item=>item.event.delta), ['AI 답변']);
  assert.equal(messages.find(item=>item.type==='error').fatal, false);
  send({type:'finish'});
  await nextTick();
  assert.equal(son.messages.at(-1), '');
  event(son, undefined, {finished:true});
  await nextTick();
  assert.equal(messages.find(item=>item.type==='finished').flushed, true);
});

test('voice consent is browser-cookie only, exposes no captions and relies on finalized endpoint', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sitenote-test-consent-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  await writeFile(join(root, 'index.html'), '<title>Sitenote</title>');
  const app = await setup(t, {config:{webRoot:root}});
  const native = await connect(t, app);
  native.send({type:'start', mode:'consent', timeMs:0});
  await nextTick();
  assert.equal(app.providers.length, 0, 'access token alone cannot enable browser-only consent');
  assert.deepEqual(native.messages.find(item=>item.type==='finished'), {type:'finished',flushed:false});
  const page = await app.request('/', undefined, {});
  const Cookie = page.headers.get('set-cookie').split(';')[0];
  const browser = await connect(t, app, {Cookie, Origin:app.base});
  browser.send({type:'start',mode:'consent',timeMs:0});
  await nextTick();
  const son = app.providers[0].ws;
  son.open();
  assert.equal(JSON.parse(son.messages[0]).enable_speaker_diarization, false);
  assert.equal(JSON.parse(son.messages[0]).max_endpoint_delay_ms, 1_000);
  assert.equal(JSON.parse(son.messages[0]).language_hints_strict, true);
  event(son, undefined, {tokens:[{text:'네.',is_final:true},{text:'<end>',is_final:true}]});
  await nextTick();
  assert.equal(browser.messages.some(item => item.type === 'consent'), false, 'warmup without participant audio never opts in');
  browser.send({type:'audio',audio});
  await nextTick();
  event(son, undefined, {tokens:[{text:'네',is_final:false},{text:'<end>',is_final:true}]});
  event(son, undefined, {tokens:[{text:'네, 회의록 이야기입니다.',is_final:true},{text:'<end>',is_final:true}]});
  event(son, undefined, {tokens:[{text:'네',is_final:true}]});
  await nextTick();
  assert.equal(browser.messages.some(item => item.type === 'consent'), false, 'final token without utterance boundary does not opt in');
  assert.equal(browser.messages.some(item => item.type === 'soniox'), false);
  event(son, undefined, {tokens:[{text:'<end>',is_final:true}]});
  await nextTick();
  assert.deepEqual(browser.messages.find(item=>item.type==='consent'), {type:'consent',accepted:true});
  assert.deepEqual(browser.messages.find(item=>item.type==='finished'), {type:'finished',flushed:true});
  assert.equal(app.providers.length, 1);
  assert.equal(browser.messages.some(item => item.type === 'soniox'), false);
});

test('voice consent drains final Soniox words when an endpoint did not arrive', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sitenote-test-consent-drain-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  await writeFile(join(root, 'index.html'), '<title>Sitenote</title>');
  const app = await setup(t, {config:{webRoot:root}});
  const page = await app.request('/', undefined, {});
  const Cookie = page.headers.get('set-cookie').split(';')[0];
  for (const [text, accepted] of [['네.', true], ['아니요!', false], ['네?', undefined]]) {
    const browser = await connect(t, app, {Cookie, Origin:app.base});
    browser.send({type:'start',mode:'consent',timeMs:0});
    await nextTick();
    const son = app.providers.at(-1).ws;
    son.open();
    browser.send({type:'audio',audio});
    speech(son, '네', 0, 100, false);
    browser.send({type:'finish'});
    await nextTick();
    assert.equal(son.messages.at(-1), '', 'ask Soniox to finalize before closing');
    assert.equal(browser.messages.some(item => item.type === 'consent' || item.type === 'finished'), false);
    event(son, undefined, {tokens:[{text,is_final:true}], finished:true});
    await nextTick();
    assert.deepEqual(browser.messages.find(item => item.type === 'consent'), accepted === undefined ? undefined : {type:'consent',accepted});
    assert.deepEqual(browser.messages.find(item => item.type === 'finished'), {type:'finished',flushed:accepted !== undefined});
    assert.equal(browser.messages.some(item => item.type === 'soniox'), false);
  }
});

test('a short spoken choice followed by silence can finish without automatic endpoint detection', () => {
  for (const [choice, accepted] of [['예.',true], ['아니오.',false], ['네, 아니요',undefined]]) {
    const client = new MockProvider(), son = new MockProvider();
    client.open();
    handleStream(client, {...keys, upstream:() => son}, true);
    try {
      event(client, 'start', {mode:'consent',timeMs:0});
      son.open();
      const frame = pcm => event(client, 'audio', {audio:pcm.toString('base64')});
      frame(Buffer.alloc(960, 32));
      speech(son, '예', 0, 20, false);
      for (let i=0; i<45; i++) frame(Buffer.alloc(960));
      assert.equal(son.messages.filter(value => value === '{"type":"finalize"}').length, 1);
      assert.deepEqual(jsonMessages(client, 'consent'), [], 'partial guesses do not decide');
      event(son, undefined, {tokens:[{text:choice,is_final:true},{text:'<fin>',is_final:true}]});
      assert.deepEqual(jsonMessages(client,'consent'), accepted === undefined ? [] : [{type:'consent',accepted}]);
    } finally { client.close(); }
  }
});

test('voice consent starts its 12-second listening clock on the first eligible PCM, with a separate warmup limit', (t) => {
  t.mock.timers.enable({apis:['setTimeout']});
  const makeSession = () => {
    const client = new MockProvider();
    const son = new MockProvider();
    client.open();
    handleStream(client, {...keys, upstream:() => son}, true);
    event(client, 'start', {mode:'consent',timeMs:0});
    son.open();
    t.after(() => client.close());
    return {client,son};
  };
  const warm = makeSession();
  t.mock.timers.tick(15_000);
  assert.deepEqual(jsonMessages(warm.client, 'finished'), []);
  event(warm.client, 'audio', {audio,suppressed:true});
  assert.equal(warm.son.messages.length, 1, 'no muted audio is sent while preparing consent');
  event(warm.client, 'audio', {audio});
  t.mock.timers.tick(11_999);
  assert.deepEqual(warm.son.messages.at(-1), Buffer.from(audio,'base64'));
  t.mock.timers.tick(1);
  assert.equal(warm.son.messages.at(-1), '');
  assert.deepEqual(jsonMessages(warm.client, 'finished'), []);
  t.mock.timers.tick(2_000);
  assert.deepEqual(jsonMessages(warm.client, 'finished'), [{type:'finished',flushed:false}]);

  const noAudio = makeSession();
  t.mock.timers.tick(20_000);
  assert.deepEqual(jsonMessages(noAudio.client, 'finished'), [{type:'finished',flushed:false}]);
  assert.equal(noAudio.son.messages.length, 1);
});

test('followup sends participant text to the app and judges the final answer even when GPT question text comes after speech', async (t) => {
  t.mock.timers.enable({apis:['setTimeout']});
  const requests = [];
  const app = await setup(t, {transport:async (_url, request) => {
    requests.push(JSON.parse(JSON.parse(request.body).input));
    return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"verdict":"wait"}'}]}]});
  }});
  const {messages, send} = await connect(t, app);
  send({type:'start',mode:'followup',timeMs:0});
  await nextTick();
  const [son, live] = app.providers.map(({ws}) => ws);
  son.open();
  live.open();
  event(live, 'session.started');
  event(live, 'session.output_audio.delta', {delta:audio});
  send({type:'playback',active:true});
  const microphone = Buffer.alloc(960, 22);
  send({type:'audio',audio:microphone.toString('base64'),suppressed:true});
  await nextTick();
  speech(son, '재생 중 발언', 1, 20);
  endpoint(son);
  send({type:'playback',active:false});
  send({type:'audio',audio:microphone.toString('base64')});
  await nextTick();
  speech(son, '금요일입니다.', 18, 40); // The token straddles the 20ms playback cutoff.
  endpoint(son);
  await nextTick();
  assert.deepEqual(son.messages.at(-1), microphone);
  assert.deepEqual(jsonMessages(live, 'session.input_audio.append').at(-1), {type:'session.input_audio.append',audio:Buffer.alloc(960).toString('base64')});
  assert.equal(messages.some(item => item.type === 'soniox' && item.tokens[0].text === '금요일입니다.'), true);
  assert.equal(requests.length, 0, 'do not judge before the actual question is available');
  event(live, 'session.output_transcript.delta', {delta:'언제 마치나요?',start_ms:0,end_ms:10,event_id:'late-question'});
  t.mock.timers.tick(1_200);
  await nextTick();
  assert.deepEqual(requests.map(({question,answer}) => ({question,answer})), [{question:'언제 마치나요?',answer:'금요일입니다.'}]);
});

test('followup forwards each finalized caption but will not judge between chunks of its spoken question', (t) => {
  t.mock.timers.enable({apis:['setTimeout']});
  const {client,son,live,requests} = setupFollowupAudio(t);
  const localDrain = () => {
    event(client, 'playback', {active:true});
    event(client, 'playback', {active:false});
  };
  localDrain();
  speech(son, '질문이 이어지기 전 잠깐 답변했습니다.', 20, 180);
  endpoint(son);
  assert.equal(jsonMessages(client, 'soniox').flatMap(({tokens}) => tokens).some(token => token.is_final && token.text.startsWith('질문이 이어지기 전')), true);
  t.mock.timers.tick(1_199);
  assert.deepEqual(requests, [], 'local playback can drain before the provider finishes sending audio');

  event(live, 'session.output_audio.delta', {delta:audio});
  localDrain();
  assert.equal(jsonMessages(client, 'audio').length, 2, 'the question keeps playing');
  speech(son, '질문이 끝난 뒤 금요일이라고 답했습니다.', 200, 360);
  endpoint(son);
  t.mock.timers.tick(1_199);
  assert.deepEqual(requests, []);
  t.mock.timers.tick(1);
  assert.deepEqual(requests.map(({answer}) => answer), ['질문이 끝난 뒤 금요일이라고 답했습니다.']);
  assert.equal(jsonMessages(client, 'soniox').length, 4, 'both captions still reach the recorder');
});

test('followup finalizes short participant answers after real quiet when automatic endpointing misses them', async (t) => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:0});
  const {client,son,live,requests} = setupFollowupAudio(t);
  const loud = Buffer.alloc(960);
  const soft = Buffer.alloc(960);
  for (let i = 0; i < 480; i++) {
    loud.writeInt16LE(Math.round(4_000 * Math.sin(i / 3)), i * 2);
    soft.writeInt16LE(Math.round(200 * Math.sin(i / 3)), i * 2);
  }
  const silence = Buffer.alloc(960);
  const frames = (count, pcm, suppressed) => {
    for (let i = 0; i < count; i++) {
      t.mock.timers.tick(20);
      event(client, 'audio', {audio:pcm.toString('base64'), suppressed});
    }
  };
  const finalizations = () => son.messages.filter(value => typeof value === 'string' && value.includes('"finalize"'));
  event(client, 'playback', {active:true});
  frames(5, loud, true);
  frames(72, silence, true);
  assert.deepEqual(finalizations(), [], 'no finalize during playback');
  event(client, 'playback', {active:false});
  frames(72, silence);
  assert.deepEqual(finalizations(), [], 'silence alone is not an answer');

  frames(4, soft); // An official partial can identify speech too quiet for the fallback's level detector.
  const firstAt = Date.now() - 80;
  speech(son, '네', firstAt, firstAt + 80, false);
  frames(69, silence);
  assert.deepEqual(finalizations(), [], 'normal pauses allow time for automatic endpoint detection');
  frames(3, silence, true);
  frames(69, silence);
  assert.deepEqual(finalizations(), [], 'echo-muted PCM does not establish continuous genuine quiet');
  frames(1, silence);
  assert.equal(finalizations().length, 1);
  frames(10, silence);
  assert.equal(finalizations().length, 1, 'do not repeat an outstanding finalize');
  speech(son, '네.', firstAt, firstAt + 80);
  event(son, undefined, {tokens:[{text:'<fin>',is_final:true}]});
  assert.deepEqual(requests.map(({answer}) => answer), ['네.']);
  assert.deepEqual(jsonMessages(client, 'soniox').flatMap(({tokens}) => tokens).filter(token => token.text === '네.'), [
    {text:'네.',is_final:true,start_ms:firstAt,end_ms:firstAt + 80,speaker:'1'},
  ]);

  // A later loud answer gets its natural endpoint. The quiet period following it must not send another finalize.
  await nextTick();
  frames(4, loud);
  const secondAt = Date.now() - 80;
  speech(son, '금요일입니다.', secondAt, secondAt + 80);
  endpoint(son);
  frames(72, silence);
  assert.deepEqual(requests.map(({answer}) => answer), ['네.', '네. 금요일입니다.']);
  assert.equal(finalizations().length, 1);

  // An automatic endpoint can win the race after a finalize command. Its late <fin> must not consume the next answer.
  await nextTick();
  frames(4, loud);
  const thirdAt = Date.now() - 80;
  frames(70, silence);
  assert.equal(finalizations().length, 2);
  speech(son, '오전입니다.', thirdAt, thirdAt + 80);
  endpoint(son);
  await nextTick();
  frames(4, soft);
  const fourthAt = Date.now() - 80;
  speech(son, '아홉 시', fourthAt, fourthAt + 80, false);
  frames(70, silence);
  assert.equal(finalizations().length, 2, 'the pending command holds a second finalize, not its speech or pause state');
  event(son, undefined, {tokens:[{text:'<fin>',is_final:true}]});
  assert.equal(requests.length, 3, 'a late finalize acknowledgment does not split the next utterance');
  frames(1, silence);
  assert.equal(finalizations().length, 3, 'quiet and weak speech detected before the ACK are retained');
  speech(son, '아홉 시입니다.', fourthAt, fourthAt + 80);
  event(son, undefined, {tokens:[{text:'<fin>',is_final:true}]});
  assert.equal(requests.length, 4);
  assert.equal(requests[3].answer, '네. 금요일입니다. 오전입니다. 아홉 시입니다.');
  assert.equal(live.readyState, 1);
});

function setupFollowupAudio(t) {
  const client = new MockProvider();
  const son = new MockProvider();
  const live = new MockProvider();
  const requests = [];
  client.open();
  handleStream(client, {...keys, upstream:url => url.includes('soniox') ? son : live,
    transport:async (_url, {body}) => {
      requests.push(JSON.parse(JSON.parse(body).input));
      return Response.json({status:'completed', output:[{type:'message',content:[{type:'output_text',text:'{"verdict":"wait"}'}]}]});
    },
  });
  event(client, 'start', {mode:'followup',timeMs:0});
  son.open();
  live.open();
  event(live, 'session.started');
  event(live, 'session.output_audio.delta', {delta:audio});
  event(live, 'session.output_transcript.delta', {delta:'언제 마치나요?',start_ms:0,end_ms:10,event_id:'followup-question'});
  t.after(() => client.close());
  return {client,son,live,requests};
}

test('semantic followup waits for drained audio, aborts stale results on partial speech and completes without closing the recording', async (t) => {
  t.mock.timers.enable({apis:['setTimeout']});
  const requests = [];
  const app = await setup(t, {transport: async (_url, request) => {
    let respond;
    const pending = new Promise(resolve => {respond = verdict => resolve(Response.json({
      status:'completed', output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({verdict})}]}],
    }));});
    requests.push({ body:JSON.parse(JSON.parse(request.body).input), signal:request.signal, respond });
    return pending;
  }});
  const {messages, send} = await connect(t, app);
  const q1 = '점검 담당자는 누구인가요?';
  const q2 = '완료 기한은 언제인가요?';
  send({type:'start',mode:'followup',timeMs:0,context:'요약 초안과 확인 사항 (참고 데이터):\n' + JSON.stringify({questions:[q1,q2]})});
  await nextTick();
  const son = app.providers[0].ws;
  const live = app.providers[1].ws;
  son.open();
  live.open();
  const speak = (ws, question, index) => {
    event(ws, 'session.started');
    event(ws, 'session.output_audio.delta', {delta:audio});
    event(ws, 'session.output_transcript.delta', {delta:question,start_ms:0,end_ms:10,event_id:'ai'+index});
  };
  speak(live, q1, 1);
  const words = (text, ms, final = true) => event(son, undefined, {tokens:[{text,start_ms:ms,end_ms:ms+20,is_final:final,speaker:'2'},
    ...(final ? [{text:'<end>',is_final:true}] : [])]});
  words('AI 마이크 에코 검증', 20);
  send({type:'playback',active:true});
  await nextTick();
  words('재생 중 발언', 40);
  assert.equal(requests.length, 0);
  send({type:'playback',active:false});
  await nextTick();
  t.mock.timers.tick(1_200);
  words('김 대리', 100);
  await nextTick();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.answer, '김 대리');
  assert.equal(requests[0].body.question, q1);
  words('추가 발언',120,false);
  assert.equal(requests[0].signal.aborted, true);
  requests[0].respond('advance');
  await nextTick();
  assert.equal(app.providers.length, 2, 'new partial speech invalidates prior verdict before next end');
  words('김 대리가 담당합니다.', 160);
  await nextTick();
  assert.equal(requests[1].body.answer, '김 대리 김 대리가 담당합니다.');
  requests[1].respond('advance');
  await nextTick();
  assert.equal(app.providers.length, 3);
  assert.equal(son.readyState, 1, 'rotate GPT audio session only');
  const next = app.providers[2].ws;
  next.open();
  assert.match(JSON.parse(next.messages[0]).session.input.at(-1).content[0].text, new RegExp(q2.slice(0,-1)));
  speak(next, q2, 2);
  send({type:'playback',active:true});
  send({type:'playback',active:false});
  await nextTick();
  t.mock.timers.tick(1_200);
  words('이번 주 금요일입니다.', 500);
  await nextTick();
  assert.equal(requests[2].body.hasNext, false);
  requests[2].respond('advance');
  await nextTick();
  assert.equal(messages.filter(item=>item.type==='followup_state').at(-1)?.state, 'complete');
  assert.equal(messages.some(item=>item.type==='finished'), false);
  assert.equal(son.readyState, 1);
  send({type:'finish'});
  await nextTick();
  event(next, 'session.closed', {reason:'close_requested'});
  event(son, undefined, {finished:true});
  await nextTick();
  assert.equal(messages.find(item=>item.type==='finished').flushed, true);
});

test('without a summary plan, repeated advance/clarify decisions never generate a third question', async t => {
  for (const verdict of ['advance','clarify']) await t.test(verdict, async t => {
    t.mock.timers.enable({apis:['setTimeout']});
    const providers = [];
    const client = new MockProvider();
    client.open();
    handleStream(client, {...keys, upstream() {
      const ws = new MockProvider();
      providers.push(ws);
      return ws;
    }, transport:async () => Response.json({status:'completed',output:[{type:'message',content:[
      {type:'output_text',text:JSON.stringify({verdict})},
    ]}]})});
    t.after(() => client.close());
    event(client, 'start', {mode:'followup',timeMs:0,context});
    providers[0].open();
    for (const question of ['담당자는 누구인가요?', '언제 마치나요?']) {
      const ws = providers.at(-1);
      ws.open();
      event(ws, 'session.started');
      event(ws, 'session.output_audio.delta', {delta:audio});
      event(ws, 'session.output_transcript.delta', {delta:question,start_ms:0,end_ms:10,event_id:'question'});
      event(client, 'playback', {active:true});
      event(client, 'playback', {active:false});
      speech(providers[0], '담당자가 금요일에 마칩니다.', 20, 60);
      endpoint(providers[0]);
      t.mock.timers.tick(1_200);
      await nextTick();
    }
    assert.equal(providers.length, 3);
    assert.equal(jsonMessages(client, 'followup_state').at(-1).state, 'complete');
    assert.equal(providers[0].readyState, 1);
  });
});
