export const PCM_RATE = 24_000;
export const FRAME_SAMPLES = PCM_RATE / 50;

export function createPcmFramer(inputRate: number) {
  let width = 0;
  let sum = 0;
  let samples = 0;
  let frame = new DataView(new ArrayBuffer(FRAME_SAMPLES * 2));
  return (input: Float32Array, send: (frame: ArrayBuffer, inputOffset: number) => void) => {
    for (let i = 0; i < input.length; i++) {
      let remaining = PCM_RATE;
      while (remaining > 0) {
        const portion = Math.min(inputRate - width, remaining);
        sum += input[i] * portion;
        width += portion;
        remaining -= portion;
        if (width !== inputRate) continue;
        const sample = Math.max(-32_768, Math.min(32_767, Math.round(sum / inputRate * 32_768)));
        frame.setInt16(samples++ * 2, sample, true);
        width = sum = 0;
        if (samples === FRAME_SAMPLES) {
          send(frame.buffer, i + 1 - remaining / PCM_RATE);
          samples = 0;
          frame = new DataView(new ArrayBuffer(FRAME_SAMPLES * 2));
        }
      }
    }
  };
}

export function decodePcm(base64: string): Float32Array<ArrayBuffer> {
  const bytes = atob(base64);
  if (!bytes.length || bytes.length % 2) throw Error('음성 데이터 형식을 읽을 수 없습니다.');
  const output = new Float32Array(bytes.length / 2);
  for (let i = 0; i < output.length; i++) {
    const sample = bytes.charCodeAt(i * 2) | (bytes.charCodeAt(i * 2 + 1) << 8);
    output[i] = ((sample << 16) >> 16) / 32_768;
  }
  return output;
}
