/// <reference types="vite/client" />
import type { Audio, AudioEvents } from '../src/session/session.ts';
import { createBargeInDetector, type MicFrame } from './barge-in.ts';
import workletUrl from './capture-worklet.ts?worker&url';
import { decodePcm, FRAME_SAMPLES, PCM_RATE } from './pcm.ts';

const frameTime = FRAME_SAMPLES / PCM_RATE;
const silent = btoa('\0'.repeat(FRAME_SAMPLES * 2));
const echoTail = 0.25;
const retainedPauseSamples = PCM_RATE / 10;
const nearSilence = 3 / 32_768;
const meterSize = 1024;
type Capture = {stream: MediaStream; source: MediaStreamAudioSourceNode; analyser: AnalyserNode; worklet: AudioWorkletNode};
type PlaybackWindow = {start: number; end: number};
type Listeners = { [K in keyof AudioEvents]: Set<(event: AudioEvents[K]) => void> };
type WebAudio = Audio & {
  unlock(): Promise<void>;
  readMeter(kind: 'mic' | 'speaker', samples: Float32Array<ArrayBuffer>): void;
  dispose(): Promise<void>;
};

function createAnalyser(context: AudioContext): AnalyserNode {
  const analyser = context.createAnalyser();
  analyser.fftSize = meterSize;
  return analyser;
}

function microphoneError(error: unknown): Error {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return Error('브라우저에서 마이크 사용을 허용해 주세요.');
    if (error.name === 'NotFoundError') return Error('연결된 마이크가 없습니다.');
    if (error.name === 'NotReadableError') return Error('마이크를 사용할 수 없습니다. 다른 앱이나 기기 설정을 확인하세요.');
  }
  return error instanceof Error ? error : Error('마이크를 시작하지 못했습니다.');
}

export function createWebAudio(options: {bargeIn?: boolean; recoverTail?: boolean} = {}): WebAudio {
  const detector = options.bargeIn || options.recoverTail ? createBargeInDetector() : undefined;
  const listeners: Listeners = {onAudio: new Set(), onPlayback: new Set(), onError: new Set()};
  const emit = <K extends keyof AudioEvents>(name: K, event: AudioEvents[K]) => listeners[name].forEach(fn => fn(event));
  const scheduled = new Set<AudioBufferSourceNode>();
  let context: AudioContext | undefined;
  let workletLoaded: Promise<void> | undefined;
  let capture: Capture | undefined;
  let speaker: AnalyserNode | undefined;
  let starting: Promise<void> | undefined;
  let captureVersion = 0;
  let playbackVersion = 0;
  let played: PlaybackWindow[] = [];
  let outputEnds = 0;
  let quietSamples = 0;
  let closed = false;

  async function unlock(): Promise<void> {
    if (closed) throw Error('종료한 음성 세션입니다.');
    if (!globalThis.AudioContext) throw Error('이 브라우저에서는 실시간 음성을 사용할 수 없습니다.');
    context ??= new AudioContext({latencyHint: 'interactive'});
    if (context.state !== 'running') await context.resume();
  }

  async function stopCapture(): Promise<void> {
    captureVersion++;
    detector?.resetCapture();
    starting = undefined;
    const active = capture;
    capture = undefined;
    if (!active) return;
    active.worklet.port.onmessage = null;
    active.worklet.onprocessorerror = null;
    active.worklet.port.close();
    active.source.disconnect();
    active.analyser.disconnect();
    active.worklet.disconnect();
    active.stream.getTracks().forEach(track => track.stop());
  }

  function routeCapture(data: MicFrame) {
    const begin = data.end - frameTime;
    const overlaps = (guard: number) => played.some(({start, end}) => data.end > start && begin < end + guard);
    const guarded = overlaps(echoTail);
    let captureMode: boolean | 'tail' | 'mute' = guarded;
    if (guarded && !options.bargeIn) captureMode = options.recoverTail && !overlaps(0) ? 'tail' : 'mute';
    for (const frame of detector?.read(data, captureMode) ?? [{pcm:data.pcm,suppressed:guarded}]) {
      const audio = frame.suppressed ? silent : btoa(String.fromCharCode(...new Uint8Array(frame.pcm)));
      emit('onAudio', {audio, suppressed:frame.suppressed, ...('bargeIn' in frame ? {bargeIn:frame.bargeIn} : {})});
    }
  }

  async function attachCapture(version: number): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw Error('마이크는 안전한 웹 주소에서만 사용할 수 있습니다.');
    await unlock();
    const ctx = context!;
    if (!ctx.audioWorklet) throw Error('이 브라우저는 실시간 마이크 처리를 지원하지 않습니다.');
    workletLoaded ??= ctx.audioWorklet.addModule(workletUrl).catch(() => {
      workletLoaded = undefined;
      throw Error('브라우저에서 음성 처리 모듈을 열 수 없습니다.');
    });
    await workletLoaded;
    if (version !== captureVersion) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true},
      video: false,
    }).catch(error => { throw microphoneError(error); });
    try {
      if (version !== captureVersion) return;
      const analyser = createAnalyser(ctx);
      const worklet = new AudioWorkletNode(ctx, 'sitenote-pcm-capture', {channelCount: 1, channelCountMode: 'explicit'});
      const source = ctx.createMediaStreamSource(stream);
      capture = {stream, source, analyser, worklet};
      const lostCapture = (message: string) => {
        if (version !== captureVersion) return;
        void stopCapture();
        emit('onError', {message});
      };
      worklet.onprocessorerror = () => lostCapture('마이크 음성 처리가 중단되었습니다.');
      for (const track of stream.getAudioTracks()) {
        track.addEventListener('ended', () => lostCapture('마이크 연결이 끊겼습니다.'), {once: true});
      }
      worklet.port.onmessage = ({data}: MessageEvent<MicFrame>) => {
        if (version === captureVersion) routeCapture(data);
      };
      source.connect(analyser);
      analyser.connect(worklet);
      // The worklet sends PCM to the session and writes no audio to its output.
      worklet.connect(ctx.destination);
    } finally {
      if (capture?.stream !== stream) stream.getTracks().forEach(track => track.stop());
    }
  }

  function startCapture(signal?: AbortSignal): Promise<void> {
    const canceled = () => Error('마이크 시작이 취소되었습니다.');
    if (signal?.aborted) return Promise.reject(canceled());
    if (capture) return Promise.resolve();
    if (starting) return starting;
    const version = ++captureVersion;
    const attached = attachCapture(version).catch(async error => {
      if (version === captureVersion) await stopCapture();
      throw error;
    }).finally(() => {
      if (version === captureVersion) starting = undefined;
    });
    if (!signal) return (starting = attached);
    starting = new Promise<void>((resolve, reject) => {
      const abort = () => {
        if (version === captureVersion) void stopCapture();
        reject(canceled());
      };
      signal.addEventListener('abort', abort, {once:true});
      void attached.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
    return starting;
  }

  function readMeter(kind: 'mic' | 'speaker', samples: Float32Array<ArrayBuffer>): void {
    const analyser = kind === 'mic' ? capture?.analyser : speaker;
    if (context?.state !== 'running' || !analyser) {
      samples.fill(0);
      return;
    }
    analyser.getFloatTimeDomainData(samples);
    if (samples.length > analyser.fftSize) samples.fill(0, analyser.fftSize);
  }

  function clearSpeaker() {
    speaker?.disconnect();
    speaker = undefined;
  }

  function trimFollowupPadding(samples: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
    let audibleEnd = samples.length;
    while (audibleEnd && Math.abs(samples[audibleEnd - 1]) <= nearSilence) audibleEnd--;
    // A pause can span several entirely silent provider chunks. Keep at most
    // 100 ms in total, without altering anything before a chunk's last sound.
    if (audibleEnd) quietSamples = 0;
    const retained = Math.min(samples.length - audibleEnd, retainedPauseSamples - quietSamples);
    quietSamples += retained;
    return samples.subarray(0, audibleEnd + retained);
  }

  async function play(audio: string) {
    const version = playbackVersion;
    await unlock();
    if (version !== playbackVersion) return;
    const ctx = context!;
    const decoded = decodePcm(audio);
    const samples = options.recoverTail && !options.bargeIn ? trimFollowupPadding(decoded) : decoded;
    if (!samples.length) return;
    const buffer = ctx.createBuffer(1, samples.length, PCM_RATE);
    buffer.copyToChannel(samples, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const start = Math.max(outputEnds, ctx.currentTime);
    const end = start + buffer.duration;
    if (!speaker) {
      speaker = createAnalyser(ctx);
      speaker.connect(ctx.destination);
    }
    source.connect(speaker);
    source.start(start);
    detector?.addOutput(start, samples);
    source.onended = () => {
      source.disconnect();
      if (scheduled.delete(source) && !scheduled.size) {
        clearSpeaker();
        emit('onPlayback', {active: false});
      }
    };
    const first = scheduled.size === 0;
    scheduled.add(source);
    const recent = played.filter(window => window.end + echoTail > ctx.currentTime - 3);
    const previous = recent.at(-1);
    played = previous && start <= previous.end
      ? [...recent.slice(0, -1), {start:previous.start, end}]
      : [...recent, {start, end}];
    outputEnds = end;
    if (first) emit('onPlayback', {active: true});
  }

  async function stopPlayback() {
    playbackVersion++;
    quietSamples = 0;
    clearSpeaker();
    if (!scheduled.size || !context) return;
    const now = context.currentTime;
    detector?.stopOutput(now);
    for (const source of scheduled) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    scheduled.clear();
    played = played.filter(window => window.start < now).map(window => ({...window, end: Math.min(window.end, now)}));
    outputEnds = 0;
    emit('onPlayback', {active: false});
  }

  return {
    unlock, startCapture, stopCapture, play, stopPlayback, readMeter,
    addListener<K extends keyof AudioEvents>(name: K, listener: (event: AudioEvents[K]) => void) {
      listeners[name].add(listener);
      return {remove: () => { listeners[name].delete(listener); }};
    },
    async dispose() {
      closed = true;
      await Promise.all([stopCapture(), stopPlayback()]);
      if (context && context.state !== 'closed') await context.close();
    },
  };
}
