import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoiceSession, type AudioEvents } from './session.ts';
import type { AiVoice } from '../../server/voices.mjs';
import type { Turn } from '../records/core.ts';

function setup(mode: 'meeting' | 'personal' | 'followup', overrides: {
  failSave?: boolean; rejectSearch?: boolean; startDelay?: Promise<void>; stopDelay?: Promise<void>; searchDelay?: Promise<string>;
  playReply?: (value: string) => Promise<void>;
  voice?: AiVoice;
  planSearch?: boolean;
} = {}) {
  const sockets: Array<ReturnType<typeof fakeSocket>> = [];
  const written = new Map<string, Turn>();
  const listeners: Record<string, (event: never) => void> = {};
  const native = { started: 0, stopped: 0, played: [] as string[], cutoff: 0 };
  const scriptedMute: boolean[] = [];
  let failure = !!overrides.failSave;
  let now = 10_000;
  const audio = {
    async startCapture() { native.started++; await overrides.startDelay; },
    async stopCapture() { native.stopped++; await overrides.stopDelay; },
    setMicMuted(muted: boolean) { scriptedMute.push(muted); },
    async play(value: string) { native.played.push(value); await overrides.playReply?.(value); },
    async stopPlayback() { native.cutoff++; },
    addListener<K extends keyof AudioEvents>(name: K, callback: (event: AudioEvents[K]) => void) {
      listeners[name] = callback as (event: never) => void;
      return { remove() { delete listeners[name]; } };
    },
  };
  const session = createVoiceSession({
    baseUrl:'https://sitenote.local', token:'user-token', mode, audio, timeMs:() => now, voice:overrides.voice,
    getContext:() => '최근 원문',
    ...(overrides.planSearch && {getQuestionMeeting:() => ({title:'현장 일정'})}),
    connect(url, token) {
      assert.equal(url, 'wss://sitenote.local/stream');
      assert.equal(token, 'user-token');
      const socket = fakeSocket();
      sockets.push(socket);
      return socket.io;
    },
    async search(query) {
      if (overrides.rejectSearch) throw Error('검색 실패');
      return overrides.searchDelay ?? '검색 근거: ' + query;
    },
    async persist(turn) { if (failure) throw Error('no space');
      written.set(turn.id, turn);
    },
    finishTimeoutMs: 30,
  });
  return {
    session, written, sockets, native, scriptedMute,
    setTime(value: number) { now = value; },
    recoverStorage() { failure = false; },
    mic(payload: AudioEvents['onAudio']) { listeners.onAudio?.(payload as never); },
    playback(active: boolean) { listeners.onPlayback?.({ active } as never); },
    error(payload: AudioEvents['onError']) { listeners.onError?.(payload as never); },
  };
}

function fakeSocket() {
  const sent: Array<Record<string, unknown>> = [];
  const io = {
    readyState: 0,
    onopen: null as (() => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as (() => void) | null,
    onmessage: null as ((event: {data:unknown}) => void) | null,
    send(body: string) { sent.push(JSON.parse(body)); },
    close() { io.readyState = 3; io.onclose?.(); },
  };
  return {
    io, sent,
    open() { io.readyState = 1; io.onopen?.(); },
    receive(message: Record<string, unknown>) { io.onmessage?.({ data: JSON.stringify(message) }); },
  };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const live = (eventType: string, id: string, delta: string, start_ms = 0) => ({
  type: 'live', streamId:'live-0', offsetMs:10_000,
  event:{ type: 'session.' + eventType + '_transcript.delta', event_id:id, delta, start_ms, end_ms:start_ms + 200 },
});
const speaker = (start_ms: number, text: string, id = '2') => ({ type:'soniox', streamId:'meeting-0', offsetMs:10_000,
  tokens:[{ start_ms,end_ms:start_ms + 80,text,is_final:true,speaker:id }] });

test('voice question keeps recording on an old server and rejects search without a model plan', async t => {
  const {session,sockets,mic} = setup('meeting',{planSearch:true});
  t.after(() => session.dispose());
  session.start();
  const socket = sockets[0];
  socket.open();
  socket.receive({type:'ready',scope:'meeting'});
  session.ask();
  assert.match(session.getSnapshot().error ?? '',/서버를 최신 버전/);
  assert.equal(session.getSnapshot().phase,'recording');
  assert.ok(!socket.sent.some(message => message.type === 'ask'));
  mic({audio:'AQI='});
  assert.equal(socket.sent.at(-1)?.type,'audio');
  socket.receive({type:'ready',scope:'meeting',plansSearch:true});
  session.ask();
  assert.deepEqual(socket.sent.at(-1),{type:'ask',timeMs:10_000,planSearch:true,meeting:{title:'현장 일정'}});
  socket.receive({type:'ready',scope:'live'});
  socket.receive({type:'search',id:'stale',query:'지난번 얘기'});
  await tick();
  assert.ok(!socket.sent.some(message => message.id === 'stale'));
});

test('pausing meeting transcription preserves capture and keeps explicitly invited AI separate', async t => {
  const {session,sockets,native,scriptedMute,written,setTime,mic} = setup('meeting');
  t.after(() => session.dispose());
  session.start();
  const socket = sockets[0];
  socket.open();
  socket.receive({type:'ready',scope:'meeting'});
  await tick();
  mic({audio:'AQI='});
  session.setTranscriptionPaused(true);
  assert.equal(session.getSnapshot().transcriptionPaused,true);
  assert.equal(session.getSnapshot().paused,false);
  assert.deepEqual(scriptedMute,[false], 'meeting transcription pause does not silence the local archive');
  assert.deepEqual(socket.sent.at(-1),{type:'transcription_pause',paused:true});
  mic({audio:'AQI='});
  assert.deepEqual(socket.sent.at(-1),{type:'audio',audio:'AAA=',suppressed:true});

  setTime(11_000);
  session.ask();
  socket.receive({type:'ready',scope:'live'});
  mic({audio:'AQI='});
  assert.deepEqual(socket.sent.at(-1),{type:'audio',audio:'AQI='});
  // The question's media clock can lag wall time. Server-tagged AI audio remains a separate turn.
  const pauseQuestion = speaker(900,'AI에 질문');
  socket.receive({...pauseQuestion,tokens:pauseQuestion.tokens.map(token => ({...token,questionAudio:true}))});
  socket.receive(speaker(100,'중지 버튼을 누르기 전에 한 말'));
  session.leave();
  session.setTranscriptionPaused(false);
  mic({audio:'AQI='});
  socket.receive(speaker(2_000,'다시 녹취'));
  await tick();
  assert.equal(native.started,1);
  assert.equal(native.stopped,0);
  assert.deepEqual([...written.values()].map(({text,section}) => [text,section]), [
    ['AI에 질문','meeting-ai'],
    ['중지 버튼을 누르기 전에 한 말','meeting'],
    ['다시 녹취','meeting'],
  ]);
});

test('manual mic mute leaves AI audio playing and sends no speech or barge-in', async t => {
  const {session,sockets,native,scriptedMute,mic,playback} = setup('meeting');
  t.after(() => session.dispose());
  session.start();
  const socket = sockets[0];
  socket.open();
  socket.receive({type:'ready',scope:'meeting'});
  await tick();
  session.ask();
  socket.receive({type:'ready',scope:'live'});
  socket.receive({type:'audio',audio:'voice'});
  playback(true);
  const stopped = native.cutoff;

  session.setMicMuted(true);
  assert.equal(session.getSnapshot().transcriptionPaused,false);
  assert.deepEqual(scriptedMute,[false,true]);
  mic({audio:'AQI=',bargeIn:true});
  socket.receive({type:'audio',audio:'rest of voice'});
  await tick();
  assert.deepEqual(native.played,['voice','rest of voice']);
  assert.equal(native.cutoff,stopped);
  assert.equal(session.getSnapshot().playback,true);
  assert.equal(socket.sent.some(item => item.type === 'interrupt' || item.type === 'finish'),false);
  assert.deepEqual(socket.sent.at(-1),{type:'audio',audio:'AAA=',suppressed:true});

  session.setMicMuted(false);
  mic({audio:'AQI=',bargeIn:true});
  assert.equal(socket.sent.at(-2)?.type,'interrupt');
  assert.deepEqual(socket.sent.at(-1),{type:'audio',audio:'AQI='});
});

test('reconnecting a meeting keeps transcription paused until the user resumes it', async t => {
  const {session,sockets,mic} = setup('meeting');
  t.after(() => session.dispose());
  session.start();
  sockets[0].open();
  sockets[0].receive({type:'ready',scope:'meeting'});
  await tick();
  session.setTranscriptionPaused(true);
  sockets[0].io.close();
  await session.reconnect();
  sockets[1].open();
  assert.equal(sockets[1].sent[0].transcriptionPaused,true);
  assert.equal(session.getSnapshot().transcriptionPaused,true);
  sockets[1].receive({type:'ready',scope:'meeting'});
  mic({audio:'AQI='});
  assert.deepEqual(sockets[1].sent.at(-1),{type:'audio',audio:'AAA=',suppressed:true});
});

test('personal transcription can pause without muting the mic, and follow-up does not expose that pause', async t => {
  const personal = setup('personal');
  const followup = setup('followup');
  t.after(() => { personal.session.dispose(); followup.session.dispose(); });
  for (const {session,sockets} of [personal,followup]) {
    session.start();
    sockets[0].open();
    await tick();
    sockets[0].receive({type:'ready',scope:'meeting'});
    session.setTranscriptionPaused(true);
  }
  assert.equal(followup.session.getSnapshot().transcriptionPaused,false);
  assert.equal(followup.sockets[0].sent.some(message => message.type === 'transcription_pause'),false);
  assert.equal(personal.session.getSnapshot().transcriptionPaused,true);
  assert.equal(personal.session.getSnapshot().micMuted,false);
  personal.mic({audio:'AQI='});
  assert.deepEqual(personal.sockets[0].sent.at(-1),{type:'audio',audio:'AAA=',suppressed:true});

  personal.session.ask();
  personal.mic({audio:'AQI='});
  assert.deepEqual(personal.sockets[0].sent.at(-1),{type:'audio',audio:'AQI='});
  personal.session.leave();
  personal.session.setTranscriptionPaused(false);
  personal.mic({audio:'AQI='});
  assert.deepEqual(personal.sockets[0].sent.at(-1),{type:'audio',audio:'AQI='});
});

test('the microphone permission dialog does not pause a session that has not started capturing', async () => {
  let grant!: () => void;
  const {session, sockets, native} = setup('meeting', {startDelay: new Promise<void>(resolve => { grant = resolve; })});
  session.start();
  const socket = sockets[0];
  socket.open();
  socket.receive({type:'ready', scope:'meeting'});
  await session.backgrounded();
  assert.equal(session.getSnapshot().paused, false);
  assert.equal(session.getSnapshot().capturing, false);
  grant();
  await tick();
  assert.equal(session.getSnapshot().capturing, true);
  const pause = session.backgrounded();
  await tick();
  socket.receive({type:'finished', flushed:true});
  await pause;
  assert.equal(session.getSnapshot().paused, true);
  assert.equal(session.getSnapshot().capturing, false);
  assert.equal(native.stopped, 1);
  session.dispose();
});

test('finish settles while microphone permission is unresolved and cleans up a late grant', async () => {
  let grant!: () => void;
  const {session,sockets,native,mic} = setup('meeting', {startDelay:new Promise<void>(resolve => { grant = resolve; })});
  session.start();
  const socket = sockets[0];
  socket.open();
  socket.receive({type:'ready',scope:'meeting'});
  const closing = session.finish();
  try {
    await tick();
    assert.equal(socket.sent.at(-1)?.type,'finish');
    socket.receive({type:'finished',flushed:true});
    assert.deepEqual(await closing,{flushed:true,saved:true});
    assert.equal(native.stopped,0);
    grant();
    await tick();
    mic({audio:'late'});
    assert.equal(native.stopped,1);
    assert.deepEqual(socket.sent.map(message=>message.type),['start','finish']);
    assert.equal(session.getSnapshot().capturing,false);
  } finally { grant(); session.dispose(); }
});

test('meeting Q&A gates AI audio and keeps questions only in Soniox; finish waits for final tokens', async () => {
  const {session, sockets, written, native, setTime, mic} = setup('meeting');
  session.start();
  const socket = sockets[0];
  socket.open();
  socket.receive({ type:'ready', scope:'meeting' });
  await tick();
  assert.equal(native.started, 1);
  assert.equal(session.getSnapshot().phase, 'recording');
  socket.receive({ type:'audio', audio:'stale' });
  socket.receive(live('output','stray','말하면 안 됨'));
  assert.deepEqual(native.played, []);
  socket.receive(speaker(100, '보통 발언'));
  setTime(11_000);
  session.ask();
  assert.equal(session.getSnapshot().phase, 'question');
  assert.equal(session.getSnapshot().liveReady, false);
  assert.deepEqual(socket.sent.at(-1), {type:'ask',timeMs:11_000,context:'최근 원문'});
  mic({audio:'opening question'});
  assert.deepEqual(socket.sent.at(-1), {type:'audio',audio:'opening question'});
  socket.receive({type:'ready',scope:'live'});
  assert.equal(session.getSnapshot().liveReady, true);
  socket.receive({type:'ai_state',state:'responding'});
  socket.receive(speaker(1_200, 'AI에게 질문'));
  socket.receive(live('input','ignored','GPT에서 받은 중복', 1200));
  socket.receive(live('output','answer','답변', 1300));
  socket.receive({type:'audio',audio:'valid'});
  assert.deepEqual(native.played, ['valid']);
  mic({ audio:'silence', suppressed:true });
  assert.deepEqual(socket.sent.at(-1), {type:'audio',audio:'silence',suppressed:true});
  session.interrupt();
  assert.equal(socket.sent.at(-1)?.type, 'interrupt');
  assert.equal(session.getSnapshot().liveReady, false);
  socket.receive(live('output','late','중단 요청 뒤 늦게 도착'));
  socket.receive({type:'audio',audio:'late'});
  assert.deepEqual(native.played,['valid']);
  setTime(12_600);
  session.leave();
  assert.equal(session.getSnapshot().phase, 'recording');
  socket.receive({type:'audio',audio:'late'});
  socket.receive(speaker(1_800, ' 후반'));
  const closing = session.finish();
  socket.receive(speaker(2_700,' 마지막 발언'));
  await tick();
  assert.equal(socket.sent.at(-1)?.type,'finish');
  socket.receive({type:'finished',flushed:true});
  assert.deepEqual(await closing,{flushed:true,saved:true});
  assert.deepEqual(Array.from(written.values()).map(({text,role,section,interrupted}) => [text,role,section,interrupted]), [
    ['보통 발언','speaker','meeting',undefined],
    ['AI에게 질문 후반','speaker','meeting-ai',undefined],
    ['답변','ai','meeting-ai',true],
    [' 마지막 발언','speaker','meeting',undefined],
  ]);
  session.dispose();
});

test('personal session persists Soniox and invited AI deltas, reports storage failure and supports retry', async () => {
  const {session, sockets, written, recoverStorage} = setup('personal', {failSave:true, rejectSearch:true});
  session.start();
  const socket = sockets[0];
  socket.open();
  socket.receive({type:'ready',scope:'meeting'});
  session.ask();
  socket.receive({type:'ready',scope:'live'});
  socket.receive({type:'search',id:'search.1',query:'앞선 납기'});
  socket.receive(speaker(20,'앞선 회의'));
  socket.receive(live('output','ai','찾아볼게요.'));
  await tick();
  assert.ok(session.getSnapshot().saveError);
  assert.equal(socket.sent.at(-1)?.type,'search_result');
  assert.match(String(socket.sent.at(-1)?.context), /검색에 실패/);
  recoverStorage();
  assert.equal(await session.retrySave(),true);
  assert.deepEqual(Array.from(written.values()).map(({role})=>role),['user','ai']);
  assert.equal(session.getSnapshot().saveError,undefined);
  const done = session.finish();
  await tick();
  socket.receive({type:'finished',flushed:true});
  assert.deepEqual(await done,{flushed:true,saved:true});
  session.dispose();
});

test('personal recording starts with Soniox, uses Live only on request, and returns to Soniox after leaving or a Live error', async () => {
  const {session,sockets,mic,written,native} = setup('personal');
  session.start();
  const socket = sockets[0];
  socket.open();
  assert.deepEqual(socket.sent[0],{type:'start',mode:'personal',timeMs:10_000});
  socket.receive({type:'ready',scope:'meeting'});
  await tick();
  assert.equal(session.getSnapshot().phase,'recording');
  assert.equal(session.getSnapshot().sonioxReady,true);
  assert.equal(session.getSnapshot().liveReady,false);
  mic({audio:'first words'});
  assert.equal(socket.sent.at(-1)?.type,'audio');
  socket.receive(speaker(20,'처음부터 녹음돼요.'));
  socket.receive({type:'ready',scope:'live'});
  socket.receive({type:'audio',audio:'unsolicited'});
  assert.equal(session.getSnapshot().liveReady,false);
  assert.deepEqual(native.played,[]);
  session.ask();
  assert.deepEqual(socket.sent.at(-1),{type:'ask',timeMs:10_000,context:'최근 원문'});
  socket.receive({type:'ready',scope:'live'});
  socket.receive(live('input','duplicate','처음부터 녹음돼요.',20));
  socket.receive(live('output','reply','원문을 저장했습니다.',250));
  session.leave();
  assert.equal(session.getSnapshot().phase,'recording');
  assert.equal(socket.sent.at(-1)?.type,'leave');
  socket.receive({type:'audio',audio:'late'});
  session.ask();
  socket.receive({type:'error',scope:'live',fatal:false,message:'Live unavailable'});
  assert.equal(session.getSnapshot().phase,'recording');
  assert.equal(session.getSnapshot().liveReady,false);
  assert.equal(session.getSnapshot().sonioxReady,true);
  assert.deepEqual(native.played,[]);
  assert.equal(native.stopped,0);
  socket.receive(speaker(2_000,'이어서 말할게요.'));
  const done = session.finish();
  await tick();
  socket.receive({type:'finished',flushed:true});
  assert.deepEqual(await done,{flushed:true,saved:true});
  assert.deepEqual([...written.values()].map(({section,role,text,speakerId}) => [section,role,text,speakerId]), [
    ['personal','user','처음부터 녹음돼요.',undefined],
    ['personal','ai','원문을 저장했습니다.',undefined],
    ['personal','user','이어서 말할게요.',undefined],
  ]);
  session.dispose();
});

test('three questions work on one meeting invitation across playback drain and interruption', async () => {
  const {session,sockets,written,native,mic,playback} = setup('meeting');
  session.start();
  const socket = sockets[0];
  socket.open();
  socket.receive({type:'ready',scope:'meeting'});
  await tick();
  session.ask();
  socket.receive({type:'ready',scope:'live'});
  const answer = (id: string, text: string, time: number) => {
    socket.receive({type:'ai_state',state:'processing'});
    assert.equal(session.getSnapshot().phase,'processing');
    socket.receive({type:'ai_state',state:'responding'});
    socket.receive({...live('output',id,text,time),streamId:id});
    socket.receive({type:'audio',audio:id});
    playback(true);
    assert.equal(session.getSnapshot().phase,'responding');
  };
  mic({audio:'first question'});
  answer('first','첫 답변',100);
  await tick();
  const readyCount = socket.sent.filter(message => message.type === 'question_ready').length;
  mic({audio:'echo',suppressed:true});
  socket.receive({type:'ai_state',state:'listening'});
  assert.equal(session.getSnapshot().phase,'responding');
  playback(false);
  mic({audio:'echo tail',suppressed:true});
  assert.equal(session.getSnapshot().phase,'responding');
  assert.equal(socket.sent.filter(message => message.type === 'question_ready').length,readyCount);
  mic({audio:'second question'});
  assert.equal(session.getSnapshot().phase,'question');
  assert.deepEqual(socket.sent.at(-2),{type:'question_ready'});
  assert.equal(socket.sent.at(-1)?.audio,'second question');
  answer('second','두 번째 답변',600);

  // Provider interruption may arrive before the browser has drained previously scheduled playback.
  mic({audio:'old playback',suppressed:true});
  socket.receive({type:'ai_state',state:'listening',interrupted:true});
  assert.notEqual(session.getSnapshot().phase,'question');
  socket.receive({type:'audio',audio:'stale second'});
  socket.receive(live('output','stale-second','이어지면 안 됨',700));
  playback(false);
  mic({audio:'third question'});
  assert.equal(session.getSnapshot().phase,'question');
  answer('third','세 번째 답변',1000);
  playback(false);
  mic({audio:'quiet'});
  socket.receive({type:'ai_state',state:'listening'});
  await tick();
  assert.deepEqual(native.played,['first','second','third']);
  assert.equal(socket.sent.filter(message => message.type === 'ask').length,1);
  assert.deepEqual([...written.values()].map(({text,interrupted}) => [text,interrupted]),[
    ['첫 답변',undefined],['두 번째 답변',true],['세 번째 답변',undefined],
  ]);
  session.dispose();
});

test('provider completion cannot enable the next question before queued speaker audio starts and drains', async () => {
  let queued!: () => void;
  const {session,sockets,mic,playback} = setup('meeting', {playReply: () => new Promise<void>(resolve => { queued = resolve; })});
  session.start();
  const socket = sockets[0];
  socket.open();
  socket.receive({type:'ready',scope:'meeting'});
  session.ask();
  socket.receive({type:'ready',scope:'live'});
  socket.receive({type:'ai_state',state:'responding'});
  socket.receive({type:'audio',audio:'나중에 재생'});
  socket.receive({type:'ai_state',state:'listening'});
  assert.equal(session.getSnapshot().phase,'responding');
  assert.ok(!socket.sent.some(message => message.type === 'question_ready'));
  playback(true);
  queued();
  await tick();
  playback(false);
  mic({audio:'다음 질문'});
  assert.equal(session.getSnapshot().phase,'question');
  assert.deepEqual(socket.sent.at(-2),{type:'question_ready'});
  session.dispose();
});

for (const mode of ['meeting','personal'] as const) {
  test(`${mode} barge-in stops once before forwarding preserved speech, then accepts the next answer`, async () => {
    const {session,sockets,written,native,mic,playback,setTime} = setup(mode);
    session.start();
    const socket = sockets[0];
    socket.open();
    socket.receive({type:'ready',scope:'meeting'});
    mic({audio:'AQIDBA==',bargeIn:true});
    assert.deepEqual(socket.sent.at(-1),{type:'audio',audio:'AQIDBA==',suppressed:true});
    assert.equal(native.cutoff,0);
    session.ask();
    socket.receive({type:'ready',scope:'live'});
    socket.receive({type:'ai_state',state:'responding'});
    socket.receive(live('output','old','이전 답변'));
    socket.receive({type:'audio',audio:'old'});
    playback(true);
    await tick();
    socket.receive({type:'ai_state',state:'listening'});
    if (mode === 'personal') playback(false);
    setTime(12_345);
    const first = Buffer.from([1, 2, 3, 4]).toString('base64');
    const rest = Buffer.from([9, 8, 7, 6]).toString('base64');
    mic({audio:first,bargeIn:true});
    mic({audio:rest});
    assert.deepEqual(socket.sent.slice(-3),[
      {type:'interrupt',timeMs:12_345,bargeIn:true},
      {type:'audio',audio:first},
      {type:'audio',audio:rest},
    ]);
    assert.equal(native.cutoff,1);
    assert.equal(session.getSnapshot().liveReady,false);
    assert.equal(session.getSnapshot().sonioxReady,true);
    const sentCount = socket.sent.length;
    socket.receive({type:'ai_state',state:'listening',interrupted:true});
    socket.receive({type:'ai_state',state:'processing'});
    socket.receive({type:'ai_state',state:'responding'});
    socket.receive(live('output','late','이미 중단된 말'));
    socket.receive({type:'audio',audio:'late'});
    assert.deepEqual(native.played,['old']);
    assert.equal(native.cutoff,1);
    assert.equal(socket.sent.length,sentCount);
    socket.receive({type:'ready',scope:'live'});
    socket.receive({type:'ai_state',state:'processing'});
    socket.receive({...live('output','next','다음 답변'),streamId:'live-next'});
    socket.receive({type:'audio',audio:'next'});
    await tick();
    assert.deepEqual(native.played,['old','next']);
    assert.deepEqual([...written.values()].map(({text,interrupted}) => [text,interrupted]), [
      ['이전 답변',true],['다음 답변',undefined],
    ]);
    session.dispose();
  });
}

test('followup never barges in and does not acknowledge drain while another playback chunk is queued', async () => {
  let queued!: () => void;
  const {session,sockets,playback,mic,native} = setup('followup', {
    playReply: audio => audio === 'queued' ? new Promise<void>(resolve => { queued = resolve; }) : Promise.resolve(),
  });
  session.start();
  const socket = sockets[0];
  socket.open();
  await tick();
  socket.receive({type:'ready',scope:'meeting'});
  socket.receive({type:'ready',scope:'live'});
  socket.receive({type:'ai_state',state:'responding'});
  socket.receive({type:'audio',audio:'playing'});
  playback(true);
  mic({audio:'AQIDBA==',bargeIn:true});
  assert.deepEqual(socket.sent.at(-1),{type:'audio',audio:'AQIDBA==',suppressed:true});
  assert.equal(native.cutoff,0);
  await tick();
  socket.receive({type:'audio',audio:'queued'});
  socket.receive({type:'ai_state',state:'listening'});
  playback(false);
  mic({audio:'AQIDBA=='});
  assert.ok(!socket.sent.some(message => message.type === 'playback' && message.active === false));
  assert.ok(!socket.sent.some(message => message.type === 'interrupt'));
  playback(true);
  queued();
  await tick();
  playback(false);
  mic({audio:'AQIDBA=='});
  assert.deepEqual(socket.sent.at(-2),{type:'playback',active:false});
  session.dispose();
});

test('AI answers persist only valid source refs and verified quoted refs attached before an interruption', async () => {
  const {session,sockets,written} = setup('meeting');
  session.start();
  const socket = sockets[0];
  socket.open();
  socket.receive({type:'ready',scope:'meeting'});
  session.ask();
  socket.receive({type:'ready',scope:'live'});
  const accepted = '[record:past-note#actual-turn]';
  socket.receive({...live('output','a1','근거에 대한 답변'), refs:[accepted, accepted, '[record:past-note#summary]', 'https://invalid.test'],
    quotedRefs:[accepted,accepted,'[record:outside#ref]']});
  session.interrupt();
  socket.receive({...live('output','unplayed','중단 이후 인용'), refs:[accepted,'[record:outside#ref]'],quotedRefs:['[record:outside#ref]']});
  socket.receive({type:'ready',scope:'live'});
  socket.receive({...live('output','a2','근거 없는 다음 답변'), streamId:'live-next',refs:[]});
  await tick();
  assert.deepEqual([...written.values()].map(turn => turn.sourceRefs), [[accepted], undefined]);
  assert.deepEqual([...written.values()].map(turn => turn.quotedRefs), [[accepted], undefined]);
  assert.equal([...written.values()][0].interrupted, true);
  session.dispose();
});

test('pause settles the active stream; resume and reconnect create fresh streams without replay', async () => {
  const {session,sockets, setTime, mic, native} = setup('followup', {voice:'noeul'});
  session.start();
  sockets[0].open();
  await tick();
  sockets[0].receive({type:'ready',scope:'meeting'});
  sockets[0].receive({type:'ready',scope:'live'});
  await tick();
  mic({audio:'before pause'});
  assert.equal(sockets[0].sent.at(-1)?.type,'audio');
  const pausing = session.pause();
  await tick();
  assert.equal(sockets[0].sent.at(-1)?.type,'finish');
  sockets[0].receive({type:'finished',flushed:true});
  await pausing;
  mic({audio:'must not send'});
  assert.equal(session.getSnapshot().paused,true);
  assert.equal(session.getSnapshot().sonioxReady,false);
  assert.equal(native.stopped,1);
  setTime(20_000);
  await session.resume();
  sockets[1].open();
  await tick();
  assert.deepEqual(sockets[1].sent,[{type:'start',mode:'followup',timeMs:20_000,voice:'noeul',context:'최근 원문'}]);
  sockets[1].io.close();
  assert.equal(session.getSnapshot().phase,'disconnected');
  await session.reconnect();
  sockets[2].open();
  await tick();
  sockets[2].receive({type:'ready',scope:'meeting'});
  sockets[2].receive({type:'ready',scope:'live'});
  session.skip();
  assert.equal(sockets[2].sent.at(-1)?.type,'skip');
  assert.deepEqual(await session.finish(),{flushed:false,saved:true});
  session.dispose();
});

test('storage can be retried after finishing and never requires re-opening the microphone', async () => {
  const {session,sockets,written,recoverStorage,native} = setup('personal',{failSave:true});
  session.start();
  sockets[0].open();
  sockets[0].receive({type:'ready',scope:'meeting'});
  sockets[0].receive(speaker(20,'종료 전 발언'));
  const done = session.finish();
  await tick();
  sockets[0].receive({type:'finished',flushed:true});
  assert.deepEqual(await done,{flushed:true,saved:false});
  assert.ok(session.getSnapshot().saveError);
  recoverStorage();
  assert.equal(await session.retrySave(),true);
  assert.deepEqual(await session.finish(),{flushed:true,saved:true});
  assert.equal(written.size,1);
  assert.equal(native.started,1);
  session.dispose();
});

test('meeting retrieval responses cannot leak after leaving and a failed GPT Live segment leaves Soniox active', async () => {
  let resolveSearch!: (context:string) => void;
  const searchDelay = new Promise<string>(resolve => { resolveSearch = resolve; });
  const {session,sockets,native,error,playback} = setup('meeting', {searchDelay});
  session.start();
  const socket = sockets[0];
  socket.open();
  socket.receive({type:'ready',scope:'meeting'});
  session.ask();
  socket.receive({type:'ready',scope:'live'});
  socket.receive({type:'ai_state',state:'processing'});
  socket.receive({type:'evidence',refs:['[record:sample#turn]', null]});
  assert.deepEqual(session.getSnapshot().references,['[record:sample#turn]']);
  socket.receive({type:'search',id:'search.1',query:'조건'});
  socket.receive({type:'ai_state',state:'responding'});
  playback(true);
  assert.equal(session.getSnapshot().playback,true);
  error({scope:'archive',message:'archive failed'});
  assert.equal(session.getSnapshot().phase,'responding');
  error({scope:'playback',message:'playback failed'});
  assert.equal(session.getSnapshot().playback,false);
  socket.receive({type:'error',scope:'live',fatal:false,message:'GPT Live unavailable'});
  assert.equal(session.getSnapshot().phase,'recording');
  assert.equal(native.stopped,0);
  resolveSearch('늦게 도착한 검색 결과');
  await tick();
  assert.ok(!socket.sent.some(message => message.type === 'search_result'));
  session.dispose();
});

test('dispose waits for a microphone permission operation in flight and then stops capture', async () => {
  let grant!: () => void;
  const startDelay = new Promise<void>(resolve => { grant = resolve; });
  const {session,sockets,native,mic} = setup('meeting', {startDelay});
  session.start();
  sockets[0].open();
  sockets[0].receive({type:'ready',scope:'meeting'});
  session.dispose();
  grant();
  await tick();
  mic({audio:'must not send'});
  assert.equal(native.started,1);
  assert.equal(native.stopped,1);
  assert.deepEqual(sockets[0].sent.map(message => message.type),['start']);
});

test('followup does not ask its first question until native voice playback has a live audio engine', async () => {
  let grant!: () => void;
  const startDelay = new Promise<void>(resolve => { grant = resolve; });
  const {session,sockets,native} = setup('followup',{startDelay});
  session.start();
  const socket = sockets[0];
  socket.open();
  assert.equal(native.started,1);
  assert.equal(socket.sent.length,0);
  grant();
  await tick();
  assert.equal(socket.sent[0].type,'start');
  socket.receive({type:'ready',scope:'meeting'});
  socket.receive({type:'ready',scope:'live'});
  assert.equal(session.getSnapshot().liveReady,true);
  socket.receive({type:'ai_state',state:'responding'});
  socket.receive({type:'audio',audio:'첫 질문'});
  assert.deepEqual(native.played,['첫 질문']);
  session.skip();
  assert.equal(session.getSnapshot().liveReady,false);
  socket.receive({type:'audio',audio:'늦게 도착한 질문'});
  assert.deepEqual(native.played,['첫 질문']);
  socket.receive({type:'ready',scope:'live'});
  assert.equal(session.getSnapshot().liveReady,true);
  session.dispose();
});

test('followup microphone setup times out without sending a stale start and can reconnect after permission resolves', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let grant!: () => void;
  const {session,sockets,native,mic} = setup('followup', {
    startDelay:new Promise<void>(resolve => { grant = resolve; }),
  });
  t.after(() => session.dispose());
  session.start();
  const expired = sockets[0];
  expired.open();
  t.mock.timers.tick(20_000);
  assert.equal(session.getSnapshot().phase,'error');
  assert.match(session.getSnapshot().error ?? '',/마이크/);
  assert.equal(expired.io.readyState,3);
  assert.deepEqual(expired.sent,[]);

  grant();
  await tick();
  assert.equal(native.stopped,1);
  assert.deepEqual(expired.sent,[]);
  await session.reconnect();
  const fresh = sockets[1];
  fresh.open();
  await tick();
  fresh.receive({type:'ready',scope:'meeting'});
  mic({audio:'AQIDBA=='});
  assert.deepEqual(fresh.sent,[
    {type:'start',mode:'followup',timeMs:10_000,context:'최근 원문'},
    {type:'audio',audio:'AQIDBA=='},
  ]);
});

test('followup uses Soniox diarization for participant answers and saves the GPT questions separately', async () => {
  const {session,sockets,mic,written,native,playback,setTime} = setup('followup');
  session.start();
  const socket = sockets[0];
  socket.open();
  await tick();
  socket.receive({type:'ready',scope:'meeting'});
  assert.equal(session.getSnapshot().sonioxReady,true);
  assert.equal(session.getSnapshot().liveReady,false);
  mic({audio:'soniox-only frame'});
  assert.deepEqual(socket.sent.at(-1),{type:'audio',audio:'soniox-only frame'});
  socket.receive({type:'ready',scope:'live'});
  socket.receive(live('output','question','담당자는 누구인가요?'));
  socket.receive({type:'audio',audio:'spoken question'});
  assert.deepEqual(native.played,['spoken question']);
  playback(true);
  assert.deepEqual(socket.sent.at(-1),{type:'playback',active:true});
  await tick();
  setTime(10_300);
  playback(false);
  mic({audio:'echo suppression',suppressed:true});
  assert.deepEqual(socket.sent.at(-1),{type:'audio',audio:'echo suppression',suppressed:true});
  assert.equal(socket.sent.some(message => message.type === 'playback' && message.active === false),false);
  mic({audio:'participant heard the prompt'});
  assert.deepEqual(socket.sent.at(-2),{type:'playback',active:false});
  assert.deepEqual(socket.sent.at(-1),{type:'audio',audio:'participant heard the prompt'});
  socket.receive(live('input','redundant','제가 담당할게요.',200));
  socket.receive(speaker(200,'제가 담당할게요.'));
  socket.receive({type:'followup_state',state:'judging'});
  assert.equal(session.getSnapshot().followupState,'judging');
  socket.receive({type:'followup_state',state:'prompting'});
  assert.equal(session.getSnapshot().followupState,'prompting');
  socket.receive({type:'ready',scope:'live'});
  socket.receive({...live('output','second','기한은 언제인가요?',350),streamId:'live-1'});
  socket.receive({type:'audio',audio:'next question'});
  playback(true);
  await tick();
  setTime(10_600);
  playback(false);
  mic({audio:'second question drained'});
  assert.equal(session.getSnapshot().sonioxReady,true);
  assert.deepEqual(native.played,['spoken question','next question']);
  const done = session.finish();
  await tick();
  socket.receive(speaker(450,'검토는 제가 합니다.','5'));
  socket.receive({type:'finished',flushed:true});
  assert.deepEqual(await done,{flushed:true,saved:true});
  assert.deepEqual([...written.values()].map(({text,section,role,speakerId}) => [text,section,role,speakerId]), [
    ['담당자는 누구인가요?','followup','ai',undefined],
    ['제가 담당할게요.','followup','speaker','followup:meeting-0:2'],
    ['기한은 언제인가요?','followup','ai',undefined],
    ['검토는 제가 합니다.','followup','speaker','followup:meeting-0:5'],
  ]);
  session.dispose();
});

test('finishing preserves the heard part of a followup question without saving unplayed suffixes', async () => {
  const {session,sockets,setTime,written,playback} = setup('followup');
  session.start();
  const socket = sockets[0];
  socket.open();
  await tick();
  socket.receive({type:'ready',scope:'meeting'});
  socket.receive({type:'ready',scope:'live'});
  socket.receive(live('output','spoken','언제인가요?',500));
  socket.receive(live('output','queued',' 듣지 않은 부분',700));
  assert.equal(session.getSnapshot().partials.at(-1)?.text,'언제인가요? 듣지 않은 부분');
  socket.receive({type:'audio',audio:'question queued'});
  playback(true);
  setTime(10_250);
  const done = session.finish();
  await tick();
  socket.receive(live('output','late',' 너무 늦은 부분',900));
  socket.receive({type:'finished',flushed:true});
  assert.deepEqual(await done,{flushed:true,saved:true});
  assert.deepEqual([...written.values()].map(({text,interrupted})=>[text,interrupted]),[['언제인가요?',true]]);
  session.dispose();
});

test('finishing without any played followup audio does not save a queued caption', async () => {
  const {session,sockets,written} = setup('followup');
  session.start();
  const socket = sockets[0];
  socket.open();
  await tick();
  socket.receive({type:'ready',scope:'meeting'});
  socket.receive({type:'ready',scope:'live'});
  socket.receive(live('output','unplayed','실제로 듣지 않은 질문',500));
  socket.receive({type:'audio',audio:'question queued'});
  const done = session.finish();
  await tick();
  socket.receive({type:'finished',flushed:true});
  assert.deepEqual(await done,{flushed:true,saved:true});
  assert.equal(written.size,0);
  session.dispose();
});

test('followup continues Soniox diarization when GPT Live fails', async () => {
  const {session,sockets,mic,written,native} = setup('followup');
  session.start();
  const socket = sockets[0];
  socket.open();
  await tick();
  socket.receive({type:'error',scope:'live',fatal:false,message:'GPT unavailable'});
  socket.receive({type:'ready',scope:'meeting'});
  assert.equal(session.getSnapshot().phase,'recording');
  assert.equal(session.getSnapshot().liveReady,false);
  assert.equal(session.getSnapshot().sonioxReady,true);
  assert.equal(native.stopped,0);
  mic({audio:'continue transcribing'});
  assert.equal(socket.sent.at(-1)?.type,'audio');
  socket.receive({type:'audio',audio:'stale AI'});
  assert.deepEqual(native.played,[]);
  socket.receive(speaker(500,'이미 들은 설명'));
  const done = session.finish();
  await tick();
  socket.receive({type:'finished',flushed:false});
  assert.deepEqual(await done,{flushed:false,saved:true});
  assert.equal([...written.values()][0].text,'이미 들은 설명');
  session.dispose();
});

test('fatal followup transcription failure stops microphone, preserves received turns, and waits for provider teardown', async () => {
  let stop!: () => void;
  const stopDelay = new Promise<void>(resolve => { stop = resolve; });
  const {session,sockets,mic,written,native} = setup('followup',{stopDelay});
  session.start();
  const socket = sockets[0];
  socket.open();
  await tick();
  socket.receive({type:'ready',scope:'meeting'});
  socket.receive({type:'ready',scope:'live'});
  socket.receive(speaker(500,'이미 들은 설명'));
  socket.receive({type:'error',scope:'meeting',fatal:true,message:'Soniox unavailable'});
  assert.equal(session.getSnapshot().phase,'finishing');
  assert.equal(session.getSnapshot().sonioxReady,false);
  // The provider can settle before the asynchronous microphone shutdown completes.
  socket.receive({type:'finished',flushed:false});
  stop();
  await tick();
  assert.equal(native.stopped,1);
  assert.equal(session.getSnapshot().phase,'error');
  assert.equal(session.getSnapshot().error,'Soniox unavailable');
  mic({audio:'must not be sent'});
  assert.deepEqual(socket.sent.map(message => message.type),['start']);
  assert.deepEqual(await session.finish(),{flushed:false,saved:true});
  assert.equal([...written.values()][0].text,'이미 들은 설명');
  session.dispose();
});

test('a browser playback error from a closed invitation cannot mute a fresh AI reply', async () => {
  let oldReject!: (error:Error) => void;
  const oldReply = new Promise<void>((_, reject) => { oldReject = reject; });
  const {session,sockets,native} = setup('meeting',{
    playReply: async audio => { if (audio === 'old') await oldReply; },
  });
  session.start();
  const socket = sockets[0];
  socket.open();
  socket.receive({type:'ready',scope:'meeting'});
  await tick();
  session.ask();
  socket.receive({type:'ready',scope:'live'});
  socket.receive({type:'audio',audio:'old'});
  session.leave();
  session.ask();
  socket.receive({type:'ready',scope:'live'});
  oldReject(Error('closed invitation'));
  await tick();
  socket.receive({type:'audio',audio:'new'});
  assert.deepEqual(native.played,['old','new']);
  assert.equal(session.getSnapshot().error,undefined);
  session.dispose();
});
