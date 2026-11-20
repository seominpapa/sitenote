import { createBargeInDetector } from '../../web/barge-in.ts';
import { FRAME_SAMPLES, PCM_RATE } from '../../web/pcm.ts';

export type NativeInput = {audio: string; end?: number; suppressed?: boolean; candidate?: string};
type Output = {audio: string; suppressed?: boolean; bargeIn?: boolean};
const frameBytes = FRAME_SAMPLES * 2;
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const toBase64 = (bytes: Uint8Array) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const bits = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    text += alphabet[bits >>> 18] + alphabet[(bits >>> 12) & 63] +
      (i + 1 < bytes.length ? alphabet[(bits >>> 6) & 63] : '=') +
      (i + 2 < bytes.length ? alphabet[bits & 63] : '=');
  }
  return text;
};
const silence = (count: number) => 'A'.repeat(Math.ceil(count * 8 / 6)) + '='.repeat((3 - count % 3) % 3);

const lookup = new Uint8Array(128);
lookup.fill(255);
for (let i = 0; i < alphabet.length; ++i) lookup[alphabet.charCodeAt(i)] = i;
function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const size = text.length / 4 * 3 - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0);
  if (text.length % 4 || size % 2) throw Error('올바르지 않은 PCM 프레임입니다.');
  const bytes = new Uint8Array(size);
  let index = 0;
  for (let i = 0; i < text.length; i += 4) {
    const a = lookup[text.charCodeAt(i)] ?? 255, b = lookup[text.charCodeAt(i + 1)] ?? 255;
    const c = text[i + 2] === '=' && i + 4 === text.length ? 0 : lookup[text.charCodeAt(i + 2)] ?? 255;
    const d = text[i + 3] === '=' && i + 4 === text.length ? 0 : lookup[text.charCodeAt(i + 3)] ?? 255;
    if ((a | b | c | d) & 128) throw Error('올바르지 않은 PCM 프레임입니다.');
    bytes[index++] = (a << 2) | (b >> 4);
    if (index < size) bytes[index++] = (b << 4) | (c >> 2);
    if (index < size) bytes[index++] = (c << 6) | d;
  }
  return bytes;
}

export function createInputRouter(bargeIn: boolean) {
  const detector = createBargeInDetector();
  let remainder = new Uint8Array(0);
  let mode: false | true | 'mute' = false;
  let renderedUntil = -Infinity;
  let renderedFrom = Infinity;
  let renderedSoundUntil = -Infinity;
  let waiting = 0;

  function route(bytes: Uint8Array<ArrayBuffer>, end: number, guard: false | true | 'mute'): Output[] {
    const frames = detector.read({pcm:bytes.buffer,end},guard);
    waiting += Number(bytes.length !== 0) - frames.filter(frame => frame.pcm.byteLength > 0).length;
    return frames.filter(frame => frame.pcm.byteLength > 0).map(frame => {
      const raw = new Uint8Array(frame.pcm);
      return frame.suppressed ? {audio:silence(raw.length),suppressed:true}
        : {audio:toBase64(raw),...(frame.bargeIn ? {bargeIn:true} : {})};
    });
  }

  return {
    output(audio: string, start: number) {
      if (!bargeIn || !Number.isFinite(start)) return;
      try {
        const bytes = fromBase64(audio);
        const view = new DataView(bytes.buffer);
        const samples = Float32Array.from({length:bytes.length / 2},(_, i) => view.getInt16(i * 2,true) / 32768);
        if (!samples.length) return;
        if (start > renderedUntil + 0.035) {
          renderedFrom = start;
          renderedSoundUntil = -Infinity;
        }
        renderedUntil = Math.max(renderedUntil, start + samples.length / PCM_RATE);
        for (let i = samples.length - 1; i >= 0; i--) {
          if (Math.abs(samples[i]) < 0.012) continue;
          renderedSoundUntil = Math.max(renderedSoundUntil, start + (i + 1) / PCM_RATE);
          break;
        }
        detector.addOutput(start,samples);
      } catch { /* Invalid optional reference keeps the fallback gate. */ }
    },
    endOutput(endedAt: number) {
      if (!Number.isFinite(endedAt)) return;
      detector.stopOutput(endedAt);
      renderedUntil = Math.min(renderedUntil,endedAt);
      renderedSoundUntil = Math.min(renderedSoundUntil,endedAt);
    },
    input(event: NativeInput): Output[] {
      const {end, suppressed, audio} = event;
      if (!bargeIn || end === undefined || !Number.isFinite(end)) {
        const flushed = waiting || remainder.length ? route(remainder,0,'mute') : [];
        remainder = new Uint8Array(0);
        mode = false;
        return [...flushed,{audio,...(suppressed ? {suppressed:true} : {})}];
      }
      const reference = end >= renderedFrom + 0.25 && end <= renderedUntil + 0.06 && end <= renderedSoundUntil + 0.25;
      let current: false | true | 'mute' = suppressed ? event.candidate && reference ? true : 'mute' : false;
      let bytes: Uint8Array<ArrayBuffer>;
      try { bytes = fromBase64(current === true ? event.candidate! : audio); }
      catch {
        current = 'mute';
        try { bytes = fromBase64(audio); }
        catch { return []; }
      }
      if (remainder.length && mode !== current) {
        // A mixed frame cannot safely be used as evidence of speech over the speaker.
        mode = 'mute';
      } else if (!remainder.length) mode = current;
      let pcm = bytes;
      if (remainder.length) {
        pcm = new Uint8Array(remainder.length + bytes.length);
        pcm.set(remainder);
        pcm.set(bytes,remainder.length);
      }
      const routed: Output[] = [];
      while (pcm.length >= frameBytes) {
        const remaining = pcm.length - frameBytes;
        routed.push(...route(pcm.slice(0, frameBytes), end - remaining / (PCM_RATE * 2), mode));
        pcm = pcm.slice(frameBytes);
        mode = current;
      }
      remainder = pcm;
      return routed;
    },
  };
}
