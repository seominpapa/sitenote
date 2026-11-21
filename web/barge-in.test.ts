import assert from 'node:assert/strict';
import test from 'node:test';
import { createBargeInDetector, type MicFrame } from './barge-in.ts';
import { FRAME_SAMPLES, PCM_RATE } from './pcm.ts';

const time = (samples: number) => samples / PCM_RATE;
const origin = 56_937;
const acousticDelay = 1939;
const tone = (frequency: number, sample: number) => Math.sin(2 * Math.PI * frequency * time(sample));
const echoSource = (sample: number) => sample < 0 ? 0 :
  (0.25 * tone(687, sample) + 0.18 * tone(341, sample) + 0.13 * tone(1537, sample)) * (0.8 + 0.18 * tone(11, sample));

function frame(at: number, signal: (i: number) => number): MicFrame {
  const pcm = new ArrayBuffer(FRAME_SAMPLES * 2);
  const buffer = new DataView(pcm);
  for (let i = 0; i < FRAME_SAMPLES; i++) buffer.setInt16(i * 2, Math.round(signal(at + i) * 32_768), true);
  return { pcm, end: time(at + FRAME_SAMPLES) };
}

function setup() {
  const detector = createBargeInDetector();
  for (const [start, length] of [[0, 3157], [3157, 12943]]) {
    detector.addOutput(time(origin + start), Float32Array.from({length}, (_, sample) => echoSource(sample + start)));
  }
  return detector;
}

test('loud delayed speaker echo alone stays suppressed across differently sized output chunks', () => {
  const detector = setup();
  for (let chunk = 0; chunk < 16; chunk++) {
    const input = frame(origin + chunk * FRAME_SAMPLES, i => 1.3 * echoSource(i - origin - acousticDelay));
    assert.deepEqual(detector.read(input, true), [{pcm:input.pcm, suppressed:true}]);
  }
});

test('speaker echoes at two delays do not cut off playback', () => {
  let seed = 47;
  const noise = Float32Array.from({length:4_500}, (_, index) => {
    if (!(index % 8)) seed = (seed * 16807) % 2147483647;
    return seed / 2147483647 * 0.4 - 0.2;
  });
  const detector = createBargeInDetector();
  detector.addOutput(time(origin), noise);
  for (let j = 5; j < 11; j++) {
    const input = frame(origin + j * FRAME_SAMPLES, i =>
      (noise[i - origin - 1231] ?? 0) + (noise[i - origin - 2109] ?? 0));
    assert.deepEqual(detector.read(input, true), [{pcm:input.pcm, suppressed:true}]);
  }
});

test('an impulse or short noise burst does not cut the answer or leak a candidate', () => {
  const detector = setup();
  const quiet = frame(origin, () => 0);
  const impulse = frame(origin + FRAME_SAMPLES, i => i % FRAME_SAMPLES === 71 ? 0.9 : 0);
  assert.deepEqual(detector.read(impulse, true), [{pcm:impulse.pcm, suppressed:true}]);
  const burst = Array.from({length:6}, (_, j) => frame(origin + (j + 2) * FRAME_SAMPLES, i => 0.21 * tone(1010, i)));
  for (const input of burst) assert.deepEqual(detector.read(input, true), []);
  assert.deepEqual(detector.read(quiet, true), [...burst, quiet].map(({pcm}) => ({pcm, suppressed:true})));
});

test('continuous low background sound does not stop AI playback', () => {
  const detector = setup();
  for (let j = 2; j < 17; j++) {
    const input = frame(origin + j * FRAME_SAMPLES, i => 0.027 * tone(997, i));
    assert.deepEqual(detector.read(input, true), [{pcm:input.pcm, suppressed:true}]);
  }
});

test('sustained independent voice over echo preserves onset before sending later frames', () => {
  const detector = setup();
  const speech = Array.from({length:9}, (_, j) => frame(origin + (j + 6) * FRAME_SAMPLES,
    i => 0.28 * tone(881, i) + 0.41 * echoSource(i - origin - acousticDelay)));
  for (const input of speech.slice(0, 7)) assert.deepEqual(detector.read(input, true), []);
  assert.deepEqual(detector.read(speech[7], true), [
    {pcm:speech[0].pcm, bargeIn:true}, ...speech.slice(1, 8).map(({pcm}) => ({pcm})),
  ]);
  detector.stopOutput(speech[7].end);
  assert.deepEqual(detector.read(speech[8], true), [{pcm:speech[8].pcm}]);
  const echo = frame(origin + 15 * FRAME_SAMPLES, i => echoSource(i - origin - acousticDelay));
  assert.deepEqual(detector.read(echo, true), [{pcm:echo.pcm, suppressed:true}]);
});

test('unconfirmed samples become silence when normal capture resumes without duplicating clock', () => {
  const detector = setup();
  const pending = frame(origin, i => 0.2 * tone(740, i));
  const next = frame(origin + FRAME_SAMPLES, i => 0.1 * tone(750, i));
  assert.deepEqual(detector.read(pending, true), []);
  assert.deepEqual(detector.read(next, false), [{pcm:pending.pcm, suppressed:true}, {pcm:next.pcm}]);
});

test('stopping mic capture discards unfinished candidates instead of injecting them on restart', () => {
  const detector = setup();
  const first = frame(origin, i => 0.2 * tone(740, i));
  assert.deepEqual(detector.read(first, true), []);
  detector.resetCapture();
  const next = frame(origin + FRAME_SAMPLES, () => 0);
  assert.deepEqual(detector.read(next, false), [{pcm:next.pcm}]);
});

test('tail recovery preserves an answer opening without sending an interrupt', () => {
  const detector = setup();
  const endOfPlayback = origin + 8 * FRAME_SAMPLES;
  detector.stopOutput(time(endOfPlayback));
  const speech = Array.from({length:7}, (_, j) => frame(endOfPlayback + j * FRAME_SAMPLES,
    i => 0.28 * tone(881, i) + 0.35 * (i - acousticDelay < endOfPlayback ? echoSource(i - origin - acousticDelay) : 0)));
  for (const input of speech.slice(0, 6)) assert.deepEqual(detector.read(input, 'tail'), [{pcm:input.pcm}]);
  assert.deepEqual(detector.read(speech[6], false), [{pcm:speech[6].pcm}]);
});

test('delayed playback alone remains muted after the speaker stops', () => {
  const detector = setup();
  const endOfPlayback = origin + 8 * FRAME_SAMPLES;
  detector.stopOutput(time(endOfPlayback));
  for (let j = 0; j < 7; j++) {
    const input = frame(endOfPlayback + j * FRAME_SAMPLES,
      i => i - acousticDelay < endOfPlayback ? 1.3 * echoSource(i - origin - acousticDelay) : 0);
    assert.deepEqual(detector.read(input, 'tail'), [{pcm:input.pcm, suppressed:true}]);
  }
});

test('a short, quiet answer immediately after playback reaches transcription from its first frame', () => {
  const detector = setup();
  const at = origin + 8 * FRAME_SAMPLES;
  detector.stopOutput(time(at));
  const opening = frame(at, i => 0.007 * tone(881, i));
  assert.deepEqual(detector.read(opening, 'tail'), [{pcm:opening.pcm}]);
  const underNextPlayback = frame(at + FRAME_SAMPLES, i => 0.28 * tone(881, i));
  assert.deepEqual(detector.read(underNextPlayback, 'mute'), [{pcm:underNextPlayback.pcm, suppressed:true}]);
});
