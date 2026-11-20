import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { openQuestionVoice } from '../question-voice.mjs';

const pcm = Buffer.from([1, 32, 11, 45]).toString('base64');
const endpoint = 'wss://api.openai.com/v1/live/sessions';
function setup(t, voiceName = 'noeul') {
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const sockets = [];
  const events = [];
  const voice = openQuestionVoice({
    openaiKey:'private-key', safetyId:'a'.repeat(64), upstream(url, init) {
      const socket = Object.assign(new EventEmitter(), {
        url, init, readyState:0, bufferedAmount:0, sent:[],
        send(data) { this.sent.push(JSON.parse(data)); },
        receive(type, data = {}) { this.emit('message', JSON.stringify({type,...data})); },
        open() { this.readyState = 1; this.emit('open'); },
        close() { this.readyState = 3; this.emit('close'); },
        terminate() { this.close(); },
      });
      sockets.push(socket);
      return socket;
    },
  }, {
    ready:() => events.push(['ready']),
    audio:data => events.push(['audio',data]),
    transcript:data => events.push(['transcript',data]),
    done:() => events.push(['done']),
    fail:message => events.push(['fail',message]),
  }, voiceName);
  t.after(() => voice.close());
  return {voice, sockets, events};
}

test('confirmed questions start GPT-Live with the selected voice and retain completed turns', async t => {
  const {voice,sockets,events} = setup(t);
  await Promise.resolve();
  assert.deepEqual(sockets,[]);
  assert.equal(voice.answer('담당자는 누구인가요?', '회의 근거를 참조하세요'), true);
  assert.equal(voice.answer('중복 질문', ''), false);
  const [first] = sockets;
  assert.equal(first.url, endpoint);
  assert.equal(first.init.headers.Authorization, 'Bearer private-key');
  first.open();
  const {type,session} = first.sent[0];
  assert.equal(type,'session.start');
  assert.equal(session.model,'gpt-live-1.1');
  assert.equal(session.store,false);
  assert.deepEqual(session.audio, {format:{type:'audio/pcm',rate:24_000},output:{voice:'noeul'}});
  assert.equal(session.safety_identifier,'a'.repeat(64));
  assert.match(JSON.stringify(session.input),/회의 근거/);
  assert.equal(session.input.find(item => item.content[0].text.includes('회의 근거'))?.role,'user');
  assert.ok(session.input.some(item => item.role === 'user' && item.content[0].text === '담당자는 누구인가요?'));
  assert.equal(session.input.at(-1).role, 'developer');

  first.receive('session.started');
  assert.ok(first.sent.some(item => item.type === 'session.input_audio.append' && Buffer.from(item.audio,'base64').every(byte => byte === 0)));
  first.receive('session.output_audio.delta',{event_id:'audio',delta:pcm});
  first.receive('session.output_audio.delta',{event_id:'audio',delta:pcm});
  first.receive('session.output_transcript.delta',{event_id:'caption',delta:'김 대리입니다.'});
  t.mock.timers.tick(1_250);
  assert.equal(first.sent.at(-1).type,'session.close');
  first.receive('session.closed',{reason:'close_requested'});
  assert.equal(first.readyState,3);
  assert.deepEqual(events,[['ready'],['audio',pcm],['transcript','김 대리입니다.'],['done']]);

  assert.equal(voice.answer('그 사람의 납기는요?', ''), true);
  const second = sockets[1];
  second.open();
  assert.deepEqual(second.sent[0].session.input.find(item => item.role === 'assistant')?.content,
    [{type:'output_text',text:'김 대리입니다.'}]);
  assert.ok(second.sent[0].session.input.some(item => item.role === 'user' && item.content[0].text === '그 사람의 납기는요?'));
});

test('preview has no user data, ignores malformed audio, and does not succeed without speech', async t => {
  const {voice,sockets,events} = setup(t,'cedar');
  await Promise.resolve();
  assert.equal(voice.speak('안녕하세요.'), true);
  const [socket] = sockets;
  socket.open();
  assert.equal(socket.sent[0].session.audio.output.voice,'cedar');
  assert.deepEqual(socket.sent[0].session.input.map(item => item.role),['developer']);
  socket.receive('session.started');
  socket.receive('session.output_audio.delta',{delta:'not valid pcm'});
  socket.receive('session.output_transcript.delta',{event_id:'caption',delta:'안녕하세요.'});
  t.mock.timers.tick(30_001);
  assert.equal(events.some(([kind]) => kind === 'audio' || kind === 'done'),false);
  assert.equal(events.at(-1)[0],'fail');
});

test('closing while answering drops late output', async t => {
  const first = setup(t);
  await Promise.resolve();
  first.voice.answer('납기는?', '');
  const [socket] = first.sockets;
  socket.open();
  socket.receive('session.started');
  first.voice.close();
  socket.receive('session.output_audio.delta',{event_id:'audio',delta:pcm});
  assert.deepEqual(first.events,[['ready']]);
});

test('permission failures are scrubbed before being forwarded', async t => {
  const {voice,sockets,events} = setup(t);
  await Promise.resolve();
  voice.answer('납기는?', '');
  sockets[0].emit('unexpected-response',null,{statusCode:403,resume(){}});
  assert.equal(events.at(-1)[0],'fail');
  assert.match(events.at(-1)[1],/GPT-Live-1.1/);
  assert.doesNotMatch(events.at(-1)[1],/private-key/);
});
