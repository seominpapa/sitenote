import assert from 'node:assert/strict';
import test from 'node:test';
import { createPcmFramer, decodePcm, FRAME_SAMPLES } from './pcm.ts';

test('capture converts split input into fixed 20 ms 24 kHz signed little-endian frames', () => {
  const framer = createPcmFramer(48_000);
  const inputs = new Float32Array(960);
  inputs.fill(0.5, 0, 480);
  inputs.fill(-0.5, 480);
  const frames: ArrayBuffer[] = [];
  const collect = (frame: ArrayBuffer) => frames.push(frame);
  framer(inputs.subarray(0, 137), collect);
  framer(inputs.subarray(137, 959), collect);
  assert.equal(frames.length, 0);
  framer(inputs.subarray(959), collect);
  assert.equal(frames.length, 1);
  const result = new DataView(frames[0]);
  assert.equal(result.byteLength, 2 * FRAME_SAMPLES);
  assert.equal(result.getInt16(0, true), 16_384);
  assert.equal(result.getInt16(480, true), -16_384);
});

test('at 44.1 kHz frame boundaries and fractional source state survive render blocks', () => {
  const framer = createPcmFramer(44_100);
  const input = new Float32Array(44_100).fill(1.2);
  const ends: number[] = [];
  for (let start = 0; start < input.length; start += 128) {
    framer(input.subarray(start, start + 128), (frame, offset) => {
      assert.equal(new DataView(frame).getInt16(0, true), 32_767);
      ends.push(start + offset);
    });
  }
  assert.equal(ends.length, 50);
  assert.deepEqual(ends, Array.from({length:50}, (_, i) => 882 * (i + 1)));
});

test('speaker output decodes signed samples and rejects a truncated sample', () => {
  const audio = Buffer.from([0,128,0,0,255,127]).toString('base64');
  assert.deepEqual(Array.from(decodePcm(audio)), [-1, 0, 32767 / 32768]);
  assert.throws(() => decodePcm('AA=='));
  assert.throws(() => decodePcm(''));
});
