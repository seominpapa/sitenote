import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readVoicePreview } from './voice-preview.ts';

const clip = (rate = 24_000) => {
  const data = new Uint8Array(46);
  data.set(new TextEncoder().encode('RIFF'), 0);
  data.set(new TextEncoder().encode('WAVEfmt '), 8);
  data.set(new TextEncoder().encode('data'), 36);
  const wave = new DataView(data.buffer);
  wave.setUint32(4, 38, true);
  wave.setUint32(16, 16, true);
  wave.setUint16(20, 1, true);
  wave.setUint16(22, 1, true);
  wave.setUint32(24, rate, true);
  wave.setUint32(28, rate * 2, true);
  wave.setUint16(32, 2, true);
  wave.setUint16(34, 16, true);
  wave.setUint32(40, 2, true);
  return data;
};

test('accepts the preview PCM WAV, rejects formats that can play beyond the size budget', async () => {
  const options = {headers:{'Content-Type':'audio/wav'}};
  const valid = clip();
  assert.deepEqual(new Uint8Array(await readVoicePreview(new Response(valid, options))), valid);
  await assert.rejects(readVoicePreview(new Response(clip(1), options)), /미리듣기 음성/);
  await assert.rejects(readVoicePreview(new Response(valid)), /미리듣기 음성/);
  await assert.rejects(readVoicePreview(new Response('', {headers:{'Content-Type':'audio/wav', 'Content-Length':'1000000'}})), /미리듣기 음성/);
  await assert.rejects(readVoicePreview(new Response(new Uint8Array(44), options)), /미리듣기 음성/);
});

test('surfaces the server preview error and handles non-JSON failure', async () => {
  const failure = Response.json({error:'OpenAI API 키를 확인하세요.'}, {status:503});
  await assert.rejects(readVoicePreview(failure), /OpenAI API 키/);
  await assert.rejects(readVoicePreview(new Response('', {status:503})), /미리듣기 음성/);
});
