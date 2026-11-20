import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApp } from '../server/app.mjs';
import { createVoiceSession } from '../src/session/session.ts';
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
  const server = createApp({
    accessToken: token, openaiKey: 'fixture-key', sonioxKey: 'fixture-key',
    upstream(url) {
      const socket = Object.assign(new EventEmitter(), {
        url, readyState: 1, bufferedAmount: 0, frames: [],
        send(data) {
          this.frames.push(data);
          if (data === '') queueMicrotask(() => this.event({finished: true}));
          if (typeof data === 'string' && data.startsWith('{"type":"session.update"'))
            queueMicrotask(() => this.event({type:'session.updated'}));
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
  let record = createRecord({id:'meeting-one',kind:'meeting'});
  await store.save(record);
  const audio = new EventEmitter();
  let played = 0;
  let ws;
  const session = createVoiceSession({
    baseUrl:'http://127.0.0.1:' + server.address().port, token, mode:'meeting',
    connect: (url, accessToken) => { ws = new WebSocket(url, {headers:{Authorization:'Bearer ' + accessToken}}); return ws; },
    timeMs: () => 0, getContext: () => '', search: async query => { searches.push(query); return ''; },
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
  await session.ask();
  await until(() => providers[1]?.frames.length > 0 && session.getSnapshot().phase === 'question' && session.getSnapshot().liveReady);
  audio.emit('onAudio', {audio: pcm});
  await until(() => providers[0].frames.some(Buffer.isBuffer));
  providers[0].event({tokens:[{text:'변경된 납기는?', start_ms:10, end_ms:50, speaker:'1', is_final:true}, {text:'<end>',is_final:true}]});
  const realtime = providers[1];
  const records = (type) => realtime.frames.map(raw => JSON.parse(raw)).filter(message=>message.type === type);
  await until(() => records('response.create').length === 1);
  assert.deepEqual(searches, ['변경된 납기는?']);
  assert.equal(records('conversation.item.create')[0].item.content[0].text, '변경된 납기는?');
  realtime.event({type:'response.created',response:{id:'voice-fixture'}});
  realtime.event({type:'response.output_audio.delta',response_id:'voice-fixture',delta:pcm,event_id:'audio-fixture'});
  realtime.event({type:'response.output_audio_transcript.delta',response_id:'voice-fixture',delta:'일정이 5월 20일로 바뀌었습니다.',event_id:'output-fixture'});
  realtime.event({type:'response.done',response:{id:'voice-fixture',status:'completed'}});
  await until(() => played === 1 && record.turns.length === 2);
  await session.leave();
  assert.deepEqual(await session.finish(), {flushed:true,saved:true});
  const reopened = await createRecordStore(adapter).load(record.id);
  assert.equal(reopened.turns.filter(turn => turn.text === '변경된 납기는?').length, 1);
  assert.deepEqual(reopened.turns.map(turn => turn.section), ['meeting-ai','meeting-ai']);
  const hits = searchRecords([reopened], '납기');
  assert.ok(hits.some(hit => hit.turnId === reopened.turns[0].id));
});
