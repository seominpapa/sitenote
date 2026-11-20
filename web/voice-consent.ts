import { createWebAudio } from './audio.ts';

export type ConsentState = 'speaking' | 'connecting' | 'listening' | 'unavailable' | 'timeout' | 'accepted';
export type ConsentAudio = ReturnType<typeof prepareVoiceConsent>;

export function prepareVoiceConsent() {
  const audio = createWebAudio({recoverTail:true});
  const unlocked = new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), 3_000);
    const finish = (ready: boolean) => { clearTimeout(timer); resolve(ready); };
    void audio.unlock().then(() => finish(true), () => finish(false));
  });
  let ownsAudio = true;

  return {
    audio, unlocked,
    take() {
      if (!ownsAudio) return;
      ownsAudio = false;
      return audio;
    },
    dispose() {
      if (!ownsAudio) return;
      ownsAudio = false;
      void audio.dispose().catch(() => undefined);
    },
  };
}

type Options = {
  onState: (state: 'connecting' | 'listening' | 'unavailable' | 'timeout') => void;
  onReady: (listen: () => void) => void;
  onDecision: (accepted: boolean) => void;
};

export function listenForVoiceConsent(prepared: ConsentAudio, options: Options) {
  const { audio, unlocked } = prepared;
  let socket: WebSocket | undefined;
  let stopped = false;
  let captureRequested = false;
  let captureReady = false;
  let listening = false;
  let sentAudio = false;
  let timeout = setTimeout(() => fail('unavailable'), 16_000);
  const subscriptions = [
    audio.addListener('onAudio', ({audio: frame, suppressed}) => {
      if (stopped || suppressed || socket?.readyState !== WebSocket.OPEN) return;
      if (!captureReady) {
        captureReady = true;
        clearTimeout(timeout);
        options.onReady(beginListening);
        return;
      }
      if (!listening || socket.bufferedAmount > 128_000) return;
      socket.send(JSON.stringify({type: 'audio', audio: frame}));
      sentAudio = true;
    }),
    audio.addListener('onError', () => fail('unavailable')),
  ];

  function stop(keepCapture = false) {
    if (stopped) return;
    stopped = true;
    listening = false;
    clearTimeout(timeout);
    subscriptions.forEach(sub => sub.remove());
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
    }
    if (captureRequested && !keepCapture) void audio.stopCapture().catch(() => undefined);
  }

  function fail(state: 'unavailable' | 'timeout') {
    if (stopped) return;
    stop();
    options.onState(state);
  }

  function beginListening() {
    if (stopped || listening) return;
    listening = true;
    // The server may finalize an utterance that has no endpoint yet as the window closes.
    timeout = setTimeout(() => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type:'finish'}));
      timeout = setTimeout(() => fail('timeout'), 2_200);
    }, 15_000);
    options.onState('listening');
  }

  function onMessage(event: MessageEvent) {
    if (stopped || typeof event.data !== 'string') return;
    let message: {type?: string; scope?: string; accepted?: boolean} | null;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message?.type === 'ready' && message.scope === 'meeting' && !captureRequested) {
      captureRequested = true;
      void audio.startCapture().catch(() => fail('unavailable'));
    } else if (message?.type === 'consent' && sentAudio && typeof message.accepted === 'boolean') {
      stop(message.accepted);
      options.onDecision(message.accepted);
    } else if (message?.type === 'error') {
      fail('unavailable');
    } else if (message?.type === 'finished') {
      fail(listening ? 'timeout' : 'unavailable');
    }
  }

  options.onState('connecting');
  void unlocked.then(ready => {
    if (stopped) return;
    if (!ready) { fail('unavailable'); return; }
    const url = new URL('/stream', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const connection = new WebSocket(url);
    socket = connection;
    connection.onopen = () => connection.send(JSON.stringify({type: 'start', mode: 'consent', timeMs: 0}));
    connection.onmessage = onMessage;
    connection.onerror = connection.onclose = () => fail('unavailable');
  }).catch(() => fail('unavailable'));
  return stop;
}
