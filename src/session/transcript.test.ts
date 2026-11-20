import assert from 'node:assert/strict';
import test from 'node:test';
import { sonioxTranscript, liveTranscript } from './transcript.ts';

const token = (text: string, start_ms: number, end_ms: number, speaker = '1', is_final = true) =>
  ({ text, start_ms, end_ms, speaker, is_final });

test('Soniox tails replace partial previews, persist finalized speech once, and preserve speaker IDs and timing', () => {
  const transcript = sonioxTranscript();
  const section = (time: number) => time >= 2_000 ? 'meeting-ai' : 'meeting';
  const first = transcript.receive('meeting-1', 1_000, [token('안녕', 0, 400, '1', false)], section);
  assert.deepEqual(first.turns, []);
  assert.equal(first.partials[0].text, '안녕');
  const updated = transcript.receive('meeting-1', 1_000, [token('안녕하세요', 0, 500), token(' 반', 500, 750, '1', false)], section);
  assert.equal(updated.turns[0].text, '안녕하세요');
  assert.equal(updated.partials[0].text, ' 반');
  assert.equal(updated.turns[0].speakerId, 'meeting:meeting-1:1');
  assert.equal(updated.turns[0].timeMs, 1_000);
  assert.deepEqual(transcript.receive('meeting-1', 1_000, [token('안녕하세요', 0, 500)], section).turns, []);
  const correction = transcript.receive('meeting-1', 1_000, [token('안녕하십니까', 0, 520), token(' 반갑습니다', 500, 850)], section);
  assert.equal(correction.turns[0].id, updated.turns[0].id);
  assert.equal(correction.turns[0].text, '안녕하십니까 반갑습니다');
  const next = transcript.receive('meeting-1', 1_000, [{text:'<end>',is_final:true}, token(' 납기는?', 1000, 1800, '2')], section);
  assert.equal(next.turns[0].section, 'meeting-ai');
  assert.equal(next.turns[0].speakerId, 'meeting:meeting-1:2');
  assert.notEqual(next.turns[0].id, updated.turns[0].id);
  const reconnect = transcript.receive('meeting-2', 5_000, [token(' 다시 시작', 0, 800)], section);
  assert.notEqual(reconnect.turns[0].id, updated.turns[0].id);
  assert.equal(reconnect.turns[0].speakerId, 'meeting:meeting-2:1');
  assert.equal(reconnect.turns[0].timeMs, 5_000);
});

test('GPT Live persists documented deltas once, and ignores duplicate provider input during meeting Q&A', () => {
  const transcript = liveTranscript('meeting-ai');
  assert.deepEqual(transcript.receive('live-1', 2_000, {type:'session.input_transcript.delta', event_id:'ignored', delta:'질문', start_ms:60}).turns, []);
  const first = transcript.receive('live-1', 2_000, {type:'session.output_transcript.delta', event_id:'first', delta:'기록', start_ms:90, end_ms:200}).turns[0];
  const next = transcript.receive('live-1', 2_000, {type:'session.output_transcript.delta', event_id:'next', delta:'을 찾았어요.', start_ms:200,end_ms:800}).turns[0];
  assert.equal(first.timeMs, 2_090);
  assert.equal(next.id, first.id);
  assert.equal(next.text, '기록을 찾았어요.');
  assert.equal(next.role, 'ai');
  assert.deepEqual(transcript.receive('live-1', 2_000, {type:'session.output_transcript.delta', event_id:'next', delta:'을 찾았어요.'}).turns, []);
  assert.equal(transcript.interrupt().turns[0].interrupted, true);
  assert.deepEqual(transcript.interrupt().turns, []);
  const restarted = transcript.receive('live-2', 4_000, {type:'session.output_transcript.delta', event_id:'first', delta:'다시 시작', start_ms:0}).turns[0];
  assert.notEqual(restarted.id, first.id);
  assert.equal(restarted.timeMs, 4_000);
});

test('an ordinary response keeps one turn and accumulates verified quotes across a long delta pause', () => {
  const transcript = liveTranscript('meeting-ai');
  const first = '[record:a#first]';
  const second = '[record:b#second]';
  const src = [first,second];
  const event = (event_id: string, delta: string, start_ms: number) => ({
    type:'session.output_transcript.delta',event_id,delta,start_ms,end_ms:start_ms+200,
  });
  const opening = transcript.receive('response-1', 1_000, event('one','첫 인용',0), 1_000, src, [first]).turns[0];
  transcript.outputDrained(); // Playback can drain locally during a provider pause.
  const late = transcript.receive('response-1', 1_000, event('two',' 및 두 번째 인용',3_000), 1_000, src, [second]).turns[0];
  assert.deepEqual([late.id,late.text,late.quotedRefs], [opening.id,'첫 인용 및 두 번째 인용',src]);
  assert.equal(transcript.interrupt().turns[0]?.id, opening.id);
  const next = transcript.receive('response-2',1_000,event('one','별도 답변',4_000),1_000,src,[first]).turns[0];
  assert.notEqual(next.id, opening.id);
  assert.deepEqual(next.quotedRefs,[first]);
});

test('personal user turns persist, while followup participant speech is owned by Soniox', () => {
  for (const section of ['personal','followup'] as const) {
    const transcript = liveTranscript(section);
    const user = transcript.receive('live-2', 2_000, {type:'session.input_transcript.delta', event_id:'a', delta:'사용자 발언'}, 2_100).turns[0];
    assert.equal(user?.role, section === 'personal' ? 'user' : undefined);
    assert.equal(user?.section, section === 'personal' ? section : undefined);
    transcript.receive('live-2', 2_000, {type:'session.output_transcript.delta', event_id:'b', delta:'중간에 멈춘 답변'}, 2_500);
    const interrupted = transcript.interrupt().turns[0];
    assert.equal(interrupted.timeMs, 2_500);
    assert.equal(interrupted.interrupted, true);
    assert.equal(interrupted.section, section);
    assert.deepEqual(transcript.interrupt().turns, []);
    const second = transcript.receive('live-2', 2_000, {type:'session.input_transcript.delta', event_id:'c', delta:'후속 질문', start_ms:700}).turns[0];
    if (section === 'personal') assert.notEqual(user.id, second.id);
    else assert.equal(second, undefined);
    transcript.receive('live-2', 2_000, {type:'session.output_transcript.delta', event_id:'d', delta:'재생 완료'}, 2_900);
    transcript.outputDrained();
    assert.deepEqual(transcript.interrupt().turns, []);
  }
});
