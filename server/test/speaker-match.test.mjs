import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../app.mjs';

const accessToken = 'speaker-match-test-token-32-characters';

function wav({rate = 24000, seconds = 2, direction = 1} = {}) {
  const dataLength = rate * seconds * 2;
  const data = Buffer.alloc(44 + dataLength);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + dataLength, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(dataLength, 40);
  for (let pos = 44; pos < data.length; pos += 2) data.writeInt16LE(direction * 8192, pos);
  return data;
}

async function fixture(t, embed) {
  const webRoot = await mkdtemp(join(tmpdir(), 'speaker-match-web-'));
  t.after(() => rm(webRoot, {recursive:true, force:true}));
  await writeFile(join(webRoot, 'index.html'), 'Sitenote');
  const server = createApp({accessToken, webRoot, speakerEmbedder:embed,
    transport:() => assert.fail('local speaker matching must never call a remote provider')});
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const home = await fetch(origin + '/');
  const cookie = home.headers.get('set-cookie').split(';')[0];
  const browser = {cookie, origin};
  const post = (body, headers = browser) => fetch(origin + '/speaker-match', {
    method:'POST', headers:{'Content-Type':'application/json', ...headers}, body:JSON.stringify(body),
  });
  return {post, home, origin, cookie, health:() => fetch(origin + '/health', {headers:browser})};
}

test('local matching authenticates loopback callers and only returns bounded cosine scores', async (t) => {
  const observed = [];
  const {post, health, home, cookie} = await fixture(t, async (samples) => {
    observed.push(samples.length);
    return [samples[500], samples[500]];
  });
  const reference = wav().toString('base64');
  const negative = wav({rate:16000, direction:-1}).toString('base64');
  const silent = wav({direction:0}).toString('base64');
  const body = {reference, candidates:[reference, negative, silent]};
  assert.equal((await health()).status, 200);
  assert.equal((await (await health()).json()).speakerMatch, true);
  assert.match(home.headers.get('content-security-policy'), /media-src 'self' blob:/);
  assert.equal((await post(body, {})).status, 401);
  assert.equal((await post(body, {cookie, origin:'https://other.invalid'})).status, 403);
  const response = await post(body);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {scores:[1, -1, null]});
  assert.deepEqual(observed, [32000, 32000, 32000]);
});

test('rejects invalid audio, oversized batches, and providers on non-local servers', async (t) => {
  const clip = wav().toString('base64');
  const {post} = await fixture(t, () => assert.fail('invalid audio was passed to the model'));
  const corrupt = wav();
  corrupt.writeUInt32LE(0, 40);
  for (const data of [
    {reference:clip, candidates:[]},
    {reference:clip, candidates:Array(9).fill(clip)},
    {reference:clip, candidates:[wav({seconds:1}).toString('base64')]},
    {reference:clip, candidates:[corrupt.toString('base64')]},
    {reference:clip, candidates:['data:audio/wav;base64,' + clip]},
    {reference:clip, candidates:[clip], path:'local-model.exe'},
  ]) assert.equal((await post(data)).status, 400);
  const disabled = await fixture(t);
  assert.equal((await disabled.post({reference:clip, candidates:[clip]})).status, 503);
  const server = createApp({accessToken, speakerEmbedder:() => assert.fail('remote server reached matcher')});
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/speaker-match', {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer ' + accessToken},
    body:JSON.stringify({reference:clip, candidates:[clip]}),
  });
  assert.equal(response.status, 404);
});

test('serializes model jobs and hides errors from the local runtime', async (t) => {
  let entered;
  let finish;
  const pending = new Promise(resolve => { entered = resolve; });
  const gate = new Promise((_, reject) => { finish = reject; });
  const {post} = await fixture(t, async () => { entered(); return gate; });
  const clip = wav().toString('base64');
  const body = {reference:clip, candidates:[clip]};
  const first = post(body);
  await Promise.race([pending, first.then(() => assert.fail('model was not called'))]);
  assert.equal((await post(body)).status, 429);
  finish(new Error('secret-local-file'));
  const failed = await first;
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /secret-local-file/);
});

test('runs the configured add-on in a bounded worker without provider credentials', async (t) => {
  const { makeSpeakerMatcher, parseSpeakerRequest } = await import('../speaker-matcher.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'speaker-worker-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const runtime = join(dir, 'runtime.cjs');
  const model = join(dir, 'model.onnx');
  await writeFile(model, 'test-model');
  await writeFile(runtime, `exports.SpeakerEmbeddingExtractor = class {
    constructor(config) {
      if (config.provider !== 'cpu' || process.env.OPENAI_API_KEY || process.env.SONIOX_API_KEY) throw new Error('unsafe worker');
    }
    createStream() { return {
      acceptWaveform({samples, sampleRate}) { if (sampleRate !== 16000) throw new Error('wrong rate'); this.samples = samples; },
      inputFinished() {}
    }; }
    isReady(stream) { return stream.samples.length === 32000; }
    compute(stream) { return new Float32Array([stream.samples[500], stream.samples[500]]); }
  };`);
  const install = {SITENOTE_SPEAKER_MODEL:model, SITENOTE_SPEAKER_RUNTIME:runtime};
  assert.equal(makeSpeakerMatcher({...install, SITENOTE_SPEAKER_RUNTIME:'relative.cjs'}), undefined);
  assert.equal(makeSpeakerMatcher({...install, SITENOTE_SPEAKER_MODEL:model+'-missing'}), undefined);
  const matcher = makeSpeakerMatcher(install);
  const reference = wav().toString('base64');
  const positive = parseSpeakerRequest({reference, candidates:[reference]});
  assert.deepEqual(await matcher(positive, AbortSignal.timeout(2000)), {scores:[1]});
  await assert.rejects(matcher(positive, AbortSignal.abort()));
  const silent = wav({direction:0}).toString('base64');
  assert.deepEqual(await matcher(parseSpeakerRequest({reference:silent, candidates:[reference]}), AbortSignal.timeout(1000)), {scores:[null]});
  await writeFile(runtime, 'throw Error("private local model location");');
  await assert.rejects(matcher(positive, AbortSignal.timeout(2000)), /^Error: Local speaker inference unavailable$/);
});
