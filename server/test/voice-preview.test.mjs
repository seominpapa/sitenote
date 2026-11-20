import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createApp } from '../app.mjs';

const token = randomBytes(32).toString('hex');
const sample = Buffer.from([10, 20, 30, 40]);

async function setup(t, openaiKey = 'mock-openai') {
  const providers = [];
  const app = createApp({ accessToken: token, openaiKey, upstream(url, options) {
    const provider = new EventEmitter();
    provider.readyState = 0;
    provider.bufferedAmount = 0;
    const events = [];
    provider.send = value => events.push(JSON.parse(value));
    provider.close = provider.terminate = () => { provider.readyState = 3; provider.emit('close'); };
    providers.push({ provider, url, options, events });
    return provider;
  } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise(resolve => {
    app.close(resolve);
    app.closeAllConnections();
  }));
  const request = (data, authorized = true, signal) => fetch(`http://127.0.0.1:${app.address().port}/v1/voice-preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized && { Authorization: 'Bearer ' + token }) },
    body: JSON.stringify(data), signal,
  });
  return { request, providers };
}

async function waitFor(find) {
  for (let i = 0; i < 200; i++) {
    const result = find();
    if (result) return result;
    await delay(5);
  }
  assert.fail('Expected provider event was not received');
}

test('voice preview authorizes and validates before opening an OpenAI connection', async t => {
  const { request, providers } = await setup(t);
  assert.equal((await request({ voice: 'marin' }, false)).status, 401);
  assert.equal((await request({ voice: 'unknown' })).status, 400);
  assert.equal((await request({ voice: 'marin', transcript: 'private' })).status, 400);
  assert.equal(providers.length, 0);
});

test('voice preview without a configured OpenAI key makes no provider request', async t => {
  const { request, providers } = await setup(t, '');
  assert.equal((await request({ voice: 'marin' })).status, 503);
  assert.equal(providers.length, 0);
});

test('voice preview renders a fixed phrase with the selected GPT-Live-1.1 voice as a PCM WAV', async t => {
  const { request, providers } = await setup(t);
  const abort = new AbortController();
  const pending = request({ voice: 'noeul' }, true, abort.signal);
  pending.catch(() => {});
  t.after(() => abort.abort());
  const { provider, url, events } = await waitFor(() => providers[0]);
  assert.equal(url, 'wss://api.openai.com/v1/live/sessions');
  assert.equal((await request({ voice: 'marin' })).status, 429);
  provider.readyState = 1;
  provider.emit('open');
  const start = await waitFor(() => events.find(event => event.type === 'session.start'));
  assert.equal(start.session.model, 'gpt-live-1.1');
  assert.equal(start.session.audio.output.voice, 'noeul');
  assert.equal(start.session.store, false);
  assert.match(JSON.stringify(start.session.input), /사이트노트/);
  const message = (type, data = {}) => provider.emit('message', JSON.stringify({ type, ...data }));
  message('session.started');
  message('session.output_audio.delta', { event_id: 'sample-audio', delta: sample.toString('base64') });
  message('session.output_transcript.delta', { event_id: 'sample-text', delta: '안녕하세요.', start_ms: 0, end_ms: 25 });
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const wav = Buffer.from(await response.arrayBuffer());
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.deepEqual(wav.subarray(44), sample);
  assert.equal(provider.readyState, 3);
});

test('voice preview cancels on client disconnect and allows another request', async t => {
  const { request, providers } = await setup(t);
  const controller = new AbortController();
  const aborted = request({ voice: 'marin' }, true, controller.signal);
  aborted.catch(() => {});
  const first = await waitFor(() => providers[0]);
  controller.abort();
  await assert.rejects(aborted, { name: 'AbortError' });
  await waitFor(() => first.provider.readyState === 3);

  const pending = request({ voice: 'cedar' });
  pending.catch(() => {});
  const second = await waitFor(() => providers[1]);
  second.provider.close();
  assert.equal((await pending).status, 502);
});

test('voice preview stops at eight seconds even if the provider keeps talking', async t => {
  const { request, providers } = await setup(t);
  const pending = request({ voice: 'marin' });
  pending.catch(() => {});
  const { provider } = await waitFor(() => providers[0]);
  provider.readyState = 1;
  provider.emit('open');
  provider.emit('message', JSON.stringify({ type: 'session.started' }));
  const delta = Buffer.alloc(130_000, 1).toString('base64');
  for (let i = 0; i < 3; i++) provider.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta }));
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal((await response.arrayBuffer()).byteLength, 44 + 8 * 24_000 * 2);
  assert.equal(provider.readyState, 3);
});
