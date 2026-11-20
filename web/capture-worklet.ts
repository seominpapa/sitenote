import { createPcmFramer } from './pcm.ts';

declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class PcmCapture extends AudioWorkletProcessor {
  private readonly frame = createPcmFramer(sampleRate);
  private readonly send = (pcm: ArrayBuffer, offset: number) => {
    this.port.postMessage({pcm, end: (currentFrame + offset) / sampleRate}, [pcm]);
  };
  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (input) this.frame(input, this.send);
    return true;
  }
}

registerProcessor('sitenote-pcm-capture', PcmCapture);
