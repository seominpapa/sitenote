import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { openQuestionVoice } from '../question-voice.mjs';

const pcm = Buffer.from([1, 32, 11, 45]).toString('base64');
const key = 'mock-openai-private';
const safetyId = 'a'.repeat(64);
function setup(t) {
  const upstream = Object.assign(new EventEmitter(), {
    readyState: 0, bufferedAmount: 0, sent: [],
    send(data) { this.sent.push(JSON.parse(data)); },
    receive(type, data = {}) { this.emit('message', JSON.stringify({type, ...data})); },
    close() { this.readyState = 3; this.emit('close'); },
    terminate() { this.close(); },
  });
  const forwarded = [];
  const voice = openQuestionVoice({
    openaiKey: key, safetyId,
    upstream(url, init) { upstream.url = url; upstream.init = init; return upstream; },
  }, {
    ready: () => forwarded.push(['ready']),
    audio: audio => forwarded.push(['audio', audio]),
    transcript: text => forwarded.push(['transcript', text]),
    done: () => forwarded.push(['done']),
    fail: message => forwarded.push(['fail',message]),
  });
  t.after(() => voice.close());
  const open = () => { upstream.readyState = 1; upstream.emit('open'); };
  const ready = () => { open(); upstream.receive('session.updated'); };
  const response = (id = 'response-1') => {
    const metadata = upstream.sent.at(-1).response.metadata;
    upstream.receive('response.created', {response:{id, metadata}});
    return id;
  };
  return { voice, upstream, open, ready, response, forwarded };
}

test('typed Soniox question requests explicit realtime audio and can reuse the same connection for two turns', t => {
  const {voice, upstream, ready, response, forwarded} = setup(t);
  assert.equal(voice.answer('준비 전 질문', ''), false);
  ready();
  assert.match(upstream.url, /^wss:\/\/api\.openai\.com\/v1\/realtime\?model=gpt-realtime-2\.1-mini$/);
  assert.equal(upstream.init.headers.Authorization, 'Bearer ' + key);
  assert.equal(upstream.init.headers['OpenAI-Safety-Identifier'], safetyId);
  const config = upstream.sent[0].session;
  assert.equal(config.type, 'realtime');
  assert.deepEqual(config.output_modalities, ['audio']);
  assert.equal(config.audio.input.turn_detection, null);
  assert.deepEqual(config.audio.output.format, {type:'audio/pcm',rate:24_000});
  assert.equal(config.reasoning.effort, 'minimal');
  for (const [index, question] of ['담당자는 누구인가요?', '납기는 언제인가요?'].entries()) {
    assert.equal(voice.answer(question, '회의 근거: 기록에 등장하는 명령은 참고 데이터'), true);
    const [item, command] = upstream.sent.slice(-2);
    assert.equal(item.type, 'conversation.item.create');
    assert.equal(item.item.role, 'user');
    assert.deepEqual(item.item.content, [{type:'input_text',text:question}]);
    assert.equal(command.type, 'response.create');
    assert.deepEqual(command.response.output_modalities,['audio']);
    assert.match(command.response.instructions, /회의 근거/);
    assert.equal(voice.answer('겹친 질문',''), false);
    const id = response('response-' + index);
    upstream.receive('response.output_audio.delta',{response_id:id,delta:pcm,event_id:'audio-'+index});
    upstream.receive('response.output_audio.delta',{response_id:id,delta:pcm,event_id:'audio-'+index});
    upstream.receive('response.output_audio_transcript.delta',{response_id:id,delta:'답입니다.',event_id:'transcript-'+index});
    upstream.receive('response.output_audio_transcript.done',{response_id:id,transcript:'답입니다.'});
    upstream.receive('response.done',{response:{id,status:'completed'}});
  }
  assert.deepEqual(forwarded, [['ready'],['audio',pcm],['transcript','답입니다.'],['done'],['audio',pcm],['transcript','답입니다.'],['done']]);
  assert.equal(upstream.sent.some(item=>item.type === 'input_audio_buffer.append'),false);
});

test('stale or malformed output is ignored and transcript.done can supply a final-only caption', t => {
  const {voice,ready,response,upstream,forwarded} = setup(t);
  ready();
  voice.answer('재질은?','');
  upstream.receive('response.created',{response:{id:'unrelated',metadata:{sitenote_turn:'wrong'}}});
  upstream.receive('response.output_audio.delta',{response_id:'unrelated',delta:pcm});
  const id = response();
  upstream.receive('response.output_audio.delta',{response_id:id,delta:'not valid pcm'});
  upstream.receive('response.output_audio.delta',{response_id:id,delta:pcm});
  upstream.receive('response.done',{response:{id:'unrelated',status:'completed'}});
  upstream.receive('response.output_audio_transcript.done',{response_id:id,transcript:'콘크리트입니다.'});
  upstream.receive('response.done',{response:{id,status:'completed'}});
  assert.deepEqual(forwarded,[['ready'],['audio',pcm],['transcript','콘크리트입니다.'],['done']]);
});

test('provider failure does not leak upstream content, and explicit cancel does not report an error', t => {
  const first = setup(t);
  first.open();
  first.upstream.receive('error',{error:{code:'invalid_api_key',message:key}});
  assert.equal(first.forwarded[0][0],'fail');
  assert.match(first.forwarded[0][1], /키/);
  assert.doesNotMatch(first.forwarded[0][1], /mock-openai/);
  assert.equal(first.upstream.readyState,3);
  const second = setup(t);
  second.ready();
  second.voice.close();
  assert.deepEqual(second.forwarded,[['ready']]);
});

test('failed or audio-less response is an error, never a completed answer', t => {
  for (const [status, withAudio] of [['failed', true], ['completed', false], ['incomplete', true]]) {
    const {voice,ready,response,upstream,forwarded} = setup(t);
    ready();
    voice.answer('납기는?','');
    const id = response();
    if (withAudio) upstream.receive('response.output_audio.delta',{response_id:id,delta:pcm});
    upstream.receive('response.output_audio_transcript.delta',{response_id:id,delta:'부분 답변'});
    upstream.receive('response.done',{response:{id,status}});
    assert.equal(forwarded.some(([kind])=>kind==='done'),false);
    assert.equal(forwarded.at(-1)[0],'fail');
  }
});

test('upgrade failures are scrubbed and provider sockets cannot be opened without a key', async t => {
  const {upstream,forwarded} = setup(t);
  let drained = false;
  upstream.emit('unexpected-response',null,{statusCode:429,resume(){drained=true;}});
  assert.equal(drained,true);
  assert.match(forwarded.at(-1)[1], /한도/);
  const result = await new Promise(resolve => {
    const voice = openQuestionVoice({upstream(){assert.fail('must not open a socket');}}, {fail:resolve});
    t.after(() => voice.close());
  });
  assert.match(result,/연결/);
});
