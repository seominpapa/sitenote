import { fork } from 'node:child_process';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sampleRate = 16000;
const largestClip = 44 + 6 * 24000 * 2;
const largestEncodedClip = Math.ceil(largestClip / 3) * 4;
const maxCandidates = 8;
export const speakerRequestBytes = (1 + maxCandidates) * largestEncodedClip + 1024;

function decodeWav(clip) {
  if (typeof clip !== 'string' || clip.length > largestEncodedClip || (clip.length & 3) ||
      !/^[a-z0-9+/]+={0,2}$/i.test(clip)) return;
  const bytes = Buffer.from(clip, 'base64');
  if (bytes.length < 44 || bytes.toString('ascii',0,4) !== 'RIFF' ||
      bytes.toString('ascii',8,16) !== 'WAVEfmt ' || bytes.readUInt32LE(4) !== bytes.length - 8 ||
      bytes.readUInt32LE(16) !== 16 || bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== 1 ||
      bytes.readUInt16LE(32) !== 2 || bytes.readUInt16LE(34) !== 16 ||
      bytes.toString('ascii',36,40) !== 'data' || bytes.readUInt32LE(40) !== bytes.length - 44) return;
  const rate = bytes.readUInt32LE(24);
  if ((rate !== sampleRate && rate !== 24000) || bytes.readUInt32LE(28) !== rate * 2) return;
  const count = (bytes.length - 44) / 2;
  if (!Number.isInteger(count) || count < rate * 2 || count > rate * 6) return;
  return {bytes, count, rate};
}

export function parseSpeakerRequest(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 2 ||
      !Array.isArray(data.candidates) || !data.candidates.length || data.candidates.length > maxCandidates) return;
  const clips = [data.reference, ...data.candidates].map(decodeWav);
  return clips.every(Boolean) ? clips : undefined;
}

function samplesAt16k({bytes, count, rate}) {
  const output = new Float32Array(Math.floor(count * sampleRate / rate));
  const at = (i) => bytes.readInt16LE(44 + Math.min(count - 1, Math.max(0, i)) * 2);
  for (let i = 0; i < output.length; i++) {
    if (rate === sampleRate) {
      output[i] = at(i) / 32768;
    } else {
      const pos = i * 1.5;
      const index = Math.floor(pos);
      const filtered = (j) => (at(j - 1) + 2 * at(j) + at(j + 1)) / 4;
      output[i] = (filtered(index) * (1 - (pos - index)) + filtered(index + 1) * (pos - index)) / 32768;
    }
  }
  return output;
}

function enoughSignal(samples) {
  let frames = 0;
  for (let offset = 0; offset + 320 <= samples.length; offset += 320) {
    let energy = 0;
    for (let i = offset; i < offset + 320; i++) energy += samples[i] * samples[i];
    if (energy > 320 * 0.003 ** 2) frames++;
  }
  return frames >= 25;
}

function cosine(a, b) {
  if (!a?.length || a.length !== b?.length || a.length > 4096) return null;
  let x = 0, y = 0, product = 0;
  for (let i = 0; i < a.length; i++) {
    x += a[i] * a[i];
    y += b[i] * b[i];
    product += a[i] * b[i];
  }
  const score = product / Math.sqrt(x * y);
  return Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : null;
}

function resolveRuntime(env) {
  const folder = join(homedir(), '.sitenote', 'speaker');
  const model = env.SITENOTE_SPEAKER_MODEL || join(folder, 'model.onnx');
  const suppliedRuntime = env.SITENOTE_SPEAKER_RUNTIME;
  const defaultRuntime = join(folder, 'node_modules', 'sherpa-onnx-node');
  if (!isAbsolute(model) || (suppliedRuntime && !isAbsolute(suppliedRuntime))) return;
  try {
    const file = statSync(model);
    if (!file.isFile() || file.size === 0 || file.size > 150_000_000) return;
    const runtime = suppliedRuntime ? require.resolve(suppliedRuntime) :
      (() => { try { return require.resolve('sherpa-onnx-node'); }
        catch { return require.resolve(defaultRuntime); } })();
    return {runtime, model};
  } catch { return undefined; }
}

const workerPath = fileURLToPath(new URL('./speaker-worker.mjs', import.meta.url));

function workerEmbeddings(setup, waves, signal) {
  return new Promise((resolve, reject) => {
    // Isolate the native add-on from the app and do not pass provider credentials.
    const env = Object.fromEntries(['PATH','SystemRoot','WINDIR','TMP','TEMP','TMPDIR','USERPROFILE','HOME']
      .flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    const child = fork(workerPath, [], { env, execArgv:[], serialization:'advanced',
      windowsHide:true, stdio:['ignore','ignore','ignore','ipc'] });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      child.kill();
      if (Array.isArray(value) && value.length === waves.length) resolve(value);
      else reject(new Error('Local speaker inference unavailable'));
    };
    const cancel = () => done();
    const timer = setTimeout(cancel, 25_000);
    child.once('error', cancel);
    child.once('exit', cancel);
    child.once('message', done);
    signal.addEventListener('abort', cancel, {once:true});
    if (signal.aborted) { cancel(); return; }
    child.send({ ...setup, waves }, error => { if(error) cancel(); });
  });
}

export function makeSpeakerMatcher(env, embed) {
  const setup = embed ? undefined : resolveRuntime(env);
  if (!setup && !embed) return;
  return async (clips, signal) => {
    const waves = clips.map(samplesAt16k).map(samples => enoughSignal(samples) ? samples : null);
    if (!waves[0]) return {scores:waves.slice(1).map(() => null)};
    let embeddings;
    if (embed) {
      embeddings = [];
      for (const samples of waves) {
        signal.throwIfAborted();
        embeddings.push(samples && await embed(samples));
      }
    } else {
      embeddings = await workerEmbeddings(setup, waves, signal);
    }
    return {scores:embeddings.slice(1).map(candidate => cosine(embeddings[0], candidate))};
  };
}
