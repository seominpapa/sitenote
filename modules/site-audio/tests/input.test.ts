import assert from 'node:assert/strict';
import test from 'node:test';
import { createInputRouter } from '../input.ts';

const rate = 24_000;
const start = 2_503;
const point = (n: number, f: number) => Math.sin(n * f * 2 * Math.PI / rate);
const speaker = (n: number) => n < 0 ? 0 :
  (0.23 * point(n, 359) + 0.2 * point(n, 781) + 0.12 * point(n, 1567)) * (0.7 + 0.16 * point(n, 12));
function pcm(first: number, len: number, sample: (n: number) => number) {
  const bytes = new Uint8Array(len * 2);
  const view = new DataView(bytes.buffer);
  for (let j = 0; j < len; j++) view.setInt16(j * 2, Math.round(sample(first + j) * 32768), true);
  return Buffer.from(bytes).toString('base64');
}
const silence = (len: number) => pcm(0, len, () => 0);

test('native overlap must have a live hardware reference before looking for voice', () => {
  const path = createInputRouter(true);
  for (let n = 0; n < 6; n++) {
    const loud = pcm(n * 480, 480, i => 0.24 * point(i, 441));
    assert.deepEqual(path.input({audio:silence(480), candidate:loud, end:start + (n + 1) / 50, suppressed:true}),
      [{audio:silence(480),suppressed:true}]);
  }
});

test('native overlap mutes delayed reference echo, then sends sustained new speech from its onset', () => {
  const path = createInputRouter(true);
  path.output(pcm(-6_000, 18_000, speaker), start - 0.25);
  const route = (from: number, count: number, source: (n: number) => number) =>
    path.input({audio:silence(count),candidate:pcm(from,count,source),end:start + (from + count) / rate,suppressed:true});
  for (let n = 1; n <= 5; n++) {
    assert.deepEqual(route(n * 480, 480, i => 1.2 * speaker(i - 850)), [{audio:silence(480),suppressed:true}]);
  }
  const voice = (i: number) => 0.29 * point(i, 951) + 0.15 * speaker(i - 850);
  // iOS often delivers variable frame sizes which still must preserve byte order and media time.
  assert.deepEqual(route(2_880, 715, voice), []);
  assert.deepEqual(route(3_595, 685, voice), []);
  assert.deepEqual(route(4_280, 1_000, voice), Array.from({length:5}, (_, j) => ({
    audio:pcm(2_880 + j * 480, 480, voice), ...(j === 0 ? {bargeIn:true} : {}),
  })));
});

test('followup and missing echo-cancellation data remain hard-muted without sending raw audio', () => {
  const path = createInputRouter(false);
  const audio = pcm(0, 480, speaker);
  path.output(audio, start);
  assert.deepEqual(path.input({audio:silence(480),candidate:audio,end:start + 0.02,suppressed:true}),
    [{audio:silence(480),suppressed:true}]);
  const on = createInputRouter(true);
  on.output(audio, start);
  assert.deepEqual(on.input({audio:silence(480),end:start + 0.02,suppressed:true}), [{audio:silence(480),suppressed:true}]);
});
