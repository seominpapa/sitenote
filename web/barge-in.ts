import { FRAME_SAMPLES, PCM_RATE } from './pcm.ts';

export type MicFrame = { pcm: ArrayBuffer; end: number };
type RoutedFrame = { pcm: ArrayBuffer; suppressed?: true; bargeIn?: true };
type CaptureMode = boolean | 'mute' | 'tail';
type Output = { start: number; end: number; samples: Float32Array };

const stride = 6;
const points = FRAME_SAMPLES / stride;
const maxEchoDelay = PCM_RATE / 4;
const holdFrames = 8; // Eight 20 ms frames; brief clicks and bumps must not stop an answer.
const quietRms = 0.012;
const playbackVoiceRms = 0.026;
const echoCorrelation = 0.78 ** 2;
const toSample = (seconds: number) => Math.round(seconds * PCM_RATE);
const muted = ({pcm}: MicFrame): RoutedFrame => ({pcm, suppressed:true});

function micStats(pcm: ArrayBuffer, sketch: Float32Array) {
  const view = new DataView(pcm);
  let sum = 0;
  let energy = 0;
  for (let point = 0; point < points; point++) {
    let average = 0;
    for (let i = 0; i < stride; i++) average += view.getInt16(2 * (point * stride + i), true);
    average /= stride * 32_768;
    sketch[point] = average;
    sum += average;
    energy += average ** 2;
  }
  const mean = sum / points;
  const variance = Math.max(0, energy - sum * mean);
  let sustained = 0;
  for (let block = 0; block < 4; block++) {
    let power = 0;
    for (let i = block * points / 4; i < (block + 1) * points / 4; i++) {
      sketch[i] -= mean;
      power += sketch[i] ** 2;
    }
    if (power > quietRms ** 2 * points / 4) sustained++;
  }
  return {variance, rms: Math.sqrt(variance / points), sustained};
}

// Find the rendered segment that explains the most mic energy. Gain and DC
// offset don't affect the match. The early exit handles simple single echoes.
function bestEcho(speaker: Float32Array, mic: Float32Array, enough: number) {
  let best = {power:0, start:0, gain:0, mean:0};
  for (let start = maxEchoDelay; start >= 0; start--) {
    let dot = 0;
    let sum = 0;
    let squares = 0;
    for (let i = 0; i < points; i++) {
      const value = speaker[start + i * stride];
      sum += value;
      squares += value * value;
      dot += value * mic[i];
    }
    const speakerEnergy = squares - sum * sum / points;
    if (speakerEnergy <= 1e-7) continue;
    const power = dot * dot / speakerEnergy;
    if (power > best.power) {
      best = {power, start, gain:dot / speakerEnergy, mean:sum / points};
      if (power >= enough) break;
    }
  }
  return best;
}

function matchesEcho(speaker: Float32Array, mic: Float32Array, micEnergy: number): boolean {
  const primary = bestEcho(speaker, mic, micEnergy * echoCorrelation);
  if (primary.power >= micEnergy * echoCorrelation) return true;
  if (primary.power < micEnergy * 0.35) return false;

  // A strong reflection can have its own delay. Subtract the primary match
  // and check that the two copies explain most of the frame together.
  for (let i = 0; i < points; i++) mic[i] -= primary.gain * (speaker[primary.start + i * stride] - primary.mean);
  const needed = micEnergy * 0.72 - primary.power;
  return bestEcho(speaker, mic, needed).power >= needed;
}

export function createBargeInDetector() {
  const sketch = new Float32Array(points);
  const rawHistory = new Float32Array(maxEchoDelay + FRAME_SAMPLES);
  const averagedHistory = new Float32Array(rawHistory.length - stride + 1);
  let output: Output[] = [];
  let candidate: MicFrame[] = [];
  let confirmed = false;
  let ambient = quietRms / 2;

  function renderHistory(start: number, end: number): boolean {
    const from = start - maxEchoDelay;
    rawHistory.fill(0);
    let hasRender = false;
    for (const part of output) {
      if (part.start >= end) break;
      const low = Math.max(from, part.start);
      const high = Math.min(end, part.end);
      if (high <= low) continue;
      rawHistory.set(part.samples.subarray(low - part.start, high - part.start), low - from);
      hasRender = true;
    }
    if (!hasRender) return false;
    let sum = 0;
    for (let i = 0; i < stride; i++) sum += rawHistory[i];
    for (let i = 0; i < averagedHistory.length; i++) {
      averagedHistory[i] = sum / stride;
      sum += (rawHistory[i + stride] ?? 0) - rawHistory[i];
    }
    return true;
  }

  function read(frame: MicFrame, mode: CaptureMode): RoutedFrame[] {
    const end = toSample(frame.end);
    const before = end - FRAME_SAMPLES - maxEchoDelay;
    if (output[0]?.end <= before) output = output.filter(part => part.end > before);
    if (mode === 'mute') {
      confirmed = false;
      const result = [...candidate.map(muted), muted(frame)];
      candidate = [];
      return result;
    }
    const stats = micStats(frame.pcm, sketch);
    if (!mode) {
      // Learn low ambient noise while listening. Keep the level from following voices.
      if (stats.rms < ambient * 2.5) ambient = ambient * 0.98 + stats.rms * 0.02;
      confirmed = false;
      const result = [...candidate.map(muted), {pcm:frame.pcm}];
      candidate = [];
      return result;
    }

    if (mode === 'tail') {
      // Playback has ended: suppress only silence or a matching echo, not short/quiet replies.
      const echo = !stats.variance || (renderHistory(end - FRAME_SAMPLES, end)
        && matchesEcho(averagedHistory, sketch, stats.variance));
      return [echo ? muted(frame) : {pcm:frame.pcm}];
    }
    const voice = stats.rms > Math.max(playbackVoiceRms, 3 * ambient) && stats.sustained >= 3
      && (!renderHistory(end - FRAME_SAMPLES, end) || !matchesEcho(averagedHistory, sketch, stats.variance));
    if (!voice) {
      const result = [...candidate.map(muted), muted(frame)];
      candidate = [];
      return result;
    }
    if (confirmed) return [{pcm:frame.pcm}];
    candidate = [...candidate, frame];
    if (candidate.length < holdFrames) return [];
    const result: RoutedFrame[] = candidate.map(({pcm}, index) =>
      mode === true && index === 0 ? {pcm, bargeIn:true} : {pcm});
    candidate = [];
    confirmed = true;
    return result;
  }

  return {
    read,
    addOutput(startTime: number, samples: Float32Array) {
      const start = toSample(startTime);
      output = [...output, {start, end:start + samples.length, samples}];
    },
    stopOutput(time: number) {
      const stop = toSample(time);
      output = output.filter(part => part.start < stop && part.end > stop - maxEchoDelay - FRAME_SAMPLES)
        .map(part => ({...part, end:Math.min(part.end, stop)}));
    },
    resetCapture() {
      candidate = [];
      confirmed = false;
      ambient = quietRms / 2;
    },
  };
}
