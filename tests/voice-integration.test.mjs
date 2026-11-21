import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApp } from '../server/app.mjs';
import { createVoiceSession } from '../src/session/session.ts';
import { meetingQuestionHistory } from '../src/meeting-history.ts';
import { applyTurn, createRecord, searchRecords } from '../src/records/core.ts';
import { createRecordStore } from '../src/records/store.ts';

const WebSocket = createRequire(new URL('../server/package.json', import.meta.url))('ws');
const token = randomBytes(32).toString('hex');
const pcm = Buffer.alloc(960).toString('base64');

async function until(check) {
  for (let retry = 0; retry < 150; retry++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail('Expected session event did not arrive');
}

test('voice controller, authenticated server and storage agree on meeting questions and saved sources', {timeout: 5000}, async t => {
  const providers = [];
  const searches = [];
  const requests = [];
  const server = createApp({
    accessToken: token, openaiKey: 'fixture-key', sonioxKey: 'fixture-key',
    async transport(_url, request) {
      const payload = JSON.parse(request.body);
      assert.equal(payload.text.format.name,'meeting_voice_search_plan');
      assert.equal(payload.text.format.strict,true);
      requests.push(JSON.parse(payload.input));
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',
        text:JSON.stringify({scope:'current',range:'topic',terms:'납기',sameProject:false})}]}]});
    },
    upstream(url) {
      const socket = Object.assign(new EventEmitter(), {
        url, readyState: 1, bufferedAmount: 0, frames: [],
        send(data) {
          this.frames.push(data);
          if (data === '') queueMicrotask(() => this.event({finished: true}));
          if (typeof data === 'string' && data.startsWith('{"type":"session.start"'))
            queueMicrotask(() => this.event({type:'session.started'}));
          if (typeof data === 'string' && data.startsWith('{"type":"session.close"'))
            queueMicrotask(() => this.event({type:'session.closed',reason:'close_requested'}));
        },
        event(data) { this.emit('message', JSON.stringify(data)); },
        close() { this.readyState = 3; this.emit('close'); },
        terminate() { this.close(); },
      });
      providers.push(socket);
      queueMicrotask(() => socket.emit('open'));
      return socket;
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const files = new Map();
  const adapter = {
    listIds: async () => ['meeting-one'],
    read: async (id, name) => files.get(id + '/' + name),
    write: async (id, name, body) => { files.set(id + '/' + name, body); },
    delete: async () => {},
  };
  const store = createRecordStore(adapter);
  let record = createRecord({id:'meeting-one',kind:'meeting',title:'납품 일정',project:'테스트 현장'});
  record = applyTurn(record,{id:'opening',section:'meeting',role:'speaker',timeMs:0,text:'납기가 5월 20일로 바뀌었습니다.'});
  await store.save(record);
  const audio = new EventEmitter();
  let played = 0;
  let ws;
  const session = createVoiceSession({
    baseUrl:'http://127.0.0.1:' + server.address().port, token, mode:'meeting', voice:'cedar',
    connect: (url, accessToken) => { ws = new WebSocket(url, {headers:{Authorization:'Bearer ' + accessToken}}); return ws; },
    timeMs: () => 0, getContext: () => '회의를 마무리합니다.',
    getQuestionMeeting: () => record,
    getQuestionHistory: (_query, before, pending, plan) => meetingQuestionHistory(record, before, pending, plan),
    search: async (query,_before,_pending,scope,plan) => { searches.push({query,scope,terms:plan?.terms}); return ''; },
    persist: async turn => { record = applyTurn(record, turn); await store.save(record); },
    audio: {
      addListener(event, handler) { audio.on(event, handler); return {remove: () => audio.off(event, handler)}; },
      startCapture: async () => {}, stopCapture: async () => {},
      play: async () => { played++; }, stopPlayback: async () => {},
    },
  });
  t.after(async () => { session.dispose(); ws?.terminate(); await new Promise(done => server.close(done)); });
  await session.start();
  await until(() => session.getSnapshot().phase === 'recording');
  assert.equal(providers.length, 1);
  assert.deepEqual(JSON.parse(providers[0].frames[0]).context,
    {general:[{key:'topic',value:'납품 일정'},{key:'project',value:'테스트 현장'}]});
  await session.ask();
  await until(() => session.getSnapshot().phase === 'question' && session.getSnapshot().liveReady);
  assert.equal(providers.length, 1, 'voice invitation stays local until a confirmed question');
  audio.emit('onAudio', {audio: pcm});
  await until(() => providers[0].frames.some(Buffer.isBuffer));
  providers[0].event({tokens:[{text:'변경된 납기는?', start_ms:10, end_ms:50, speaker:'1', is_final:true}, {text:'<end>',is_final:true}]});
  await until(() => providers.length === 2);
  const live = providers[1];
  const records = (type) => live.frames.map(raw => JSON.parse(raw)).filter(message=>message.type === type);
  await until(() => records('session.input_audio.append').length > 0);
  assert.deepEqual(requests, [{mode:'meeting',question:'변경된 납기는?',recentQuestions:[],
    meeting:{title:'납품 일정',project:'테스트 현장'}}]);
  assert.deepEqual(searches, [{query:'변경된 납기는?',scope:'current',terms:'납기'}]);
  assert.equal(live.url, 'wss://api.openai.com/v1/live/sessions');
  const config = records('session.start')[0].session;
  assert.equal(config.model, 'gpt-live-1.1');
  assert.equal(config.audio.output.voice, 'cedar');
  assert.equal(config.input.filter(item => item.role === 'user').at(-1).content[0].text, '변경된 납기는?');
  const reference = config.input.find(item => item.role === 'user').content[0].text;
  assert.match(reference,/납기가 5월 20일로 바뀌었습니다/u);
  assert.doesNotMatch(reference,/회의를 마무리합니다|변경된 납기는/u);
  live.event({type:'session.output_audio.delta',delta:pcm,event_id:'audio-fixture'});
  live.event({type:'session.output_transcript.delta',delta:'일정이 5월 20일로 바뀌었습니다.',event_id:'output-fixture',start_ms:10,end_ms:70});
  await until(() => played === 1 && record.turns.length === 3);
  await session.leave();
  assert.deepEqual(await session.finish(), {flushed:true,saved:true});
  const reopened = await createRecordStore(adapter).load(record.id);
  assert.equal(reopened.turns.filter(turn => turn.text === '변경된 납기는?').length, 1);
  assert.deepEqual(reopened.turns.map(turn => turn.section), ['meeting','meeting-ai','meeting-ai']);
  const hits = searchRecords([reopened], '납기');
  assert.ok(hits.some(hit => hit.turnId === reopened.turns[0].id));
});
