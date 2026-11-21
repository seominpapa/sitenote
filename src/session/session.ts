import { isOriginalSourceRef, isSourceRef, type Turn, type VoiceSearchPlan } from '../records/core.ts';
import type { AiVoice } from '../../server/voices.mjs';
import type { MeetingQuestionHistory, MeetingRecap } from '../meeting-history.ts';
import { liveTranscript, sonioxTranscript, type LiveEvent, type SonioxToken } from './transcript.ts';

export type Mode = 'meeting' | 'personal' | 'followup';
export type Phase = 'idle' | 'connecting' | 'recording' | 'question' | 'processing' | 'responding' | 'finishing' | 'finished' | 'disconnected' | 'error';
type FollowupState = 'prompting' | 'waiting' | 'judging' | 'complete';
export type AudioEvents = {
  onAudio: { audio: string; suppressed?: boolean; bargeIn?: boolean };
  onPlayback: { active: boolean };
  onError: { message: string; scope?: string };
};
export type Audio = {
  startCapture(signal?: AbortSignal): Promise<void>;
  stopCapture(): Promise<void>;
  setMicMuted?(muted: boolean): void;
  play(audio: string): Promise<void>;
  stopPlayback(): Promise<void>;
  addListener(name: 'onAudio', listener: (event: AudioEvents['onAudio']) => void): {remove(): void};
  addListener(name: 'onPlayback', listener: (event: AudioEvents['onPlayback']) => void): {remove(): void};
  addListener(name: 'onError', listener: (event: AudioEvents['onError']) => void): {remove(): void};
};
export type Snapshot = {
  phase: Phase;
  paused: boolean;
  transcriptionPaused: boolean;
  micMuted: boolean;
  capturing: boolean;
  sonioxReady: boolean;
  liveReady: boolean;
  playback: boolean;
  partials: Turn[];
  references: string[];
  saving: boolean;
  followupState?: FollowupState;
  error?: string;
  saveError?: string;
};
type Socket = {
  readyState: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: {data: unknown}) => void) | null;
  send(body: string): void;
  close(): void;
};
type Options = {
  baseUrl: string;
  token: string;
  mode: Mode;
  voice?: AiVoice;
  audio: Audio;
  persist(turn: Turn): Promise<void>;
  search(query: string, beforeMs: number, pendingTurns: readonly Turn[], scope?: MeetingQuestionHistory['scope'], plan?: VoiceSearchPlan):
    Promise<string | {context: string; recap?: MeetingRecap}>;
  getQuestionHistory?(query: string, beforeMs: number, pendingTurns: readonly Turn[], plan?: VoiceSearchPlan): MeetingQuestionHistory;
  getQuestionMeeting?(): {title: string; project?: string};
  getContext(): string;
  timeMs?: () => number;
  connect?: (url: string, token: string) => Socket;
  finishTimeoutMs?: number;
};
type Incoming =
  | {type:'ready'; scope:'meeting'|'live'; plansSearch?: boolean}
  | {type:'soniox'; tokens: SonioxToken[]; offsetMs: number; streamId: string}
  | {type:'live'; event: LiveEvent; offsetMs: number; streamId: string; refs?: unknown; quotedRefs?: unknown}
  | {type:'audio'; audio: string}
  | {type:'search'; id: string; query: string; questionStart?: number; plan?: VoiceSearchPlan}
  | {type:'evidence'; refs: string[]}
  | {type:'ai_state'; state: 'meeting'|'listening'|'processing'|'responding'|'idle'; interrupted?: boolean}
  | {type:'followup_state'; state: FollowupState}
  | {type:'finished'; flushed: boolean}
  | {type:'error'; message: string; scope?: string; fatal?: boolean};
const saveError = '원문을 저장하지 못했습니다. 저장 공간을 확인한 뒤 다시 시도하세요.';
const disconnected = '연결이 끊겼습니다. 저장된 원문을 유지했으며 연결이 끊긴 구간은 녹음되지 않았습니다.';
const unflushed = '서버에서 마지막 전사 완료 신호를 받지 못했습니다. 이미 저장된 부분은 유지했습니다.';
const validSearchPlan = (plan?: VoiceSearchPlan) => plan != null &&
  ['general','current','latest','related','newest_note'].includes(plan.scope) &&
  ['overview','opening','topic','prior-question'].includes(plan.range) &&
  typeof plan.terms === 'string' && plan.terms.length <= 300 && typeof plan.sameProject === 'boolean';
// Keep the PCM frame length while removing audio before it leaves the device.
const silentFrame = (frame: string) => frame.replace(/[^=]/g, 'A');

function reactNativeSocket(url: string, token: string): Socket {
  const RNWebSocket = WebSocket as unknown as new (url: string, protocols: string[], options: { headers: Record<string, string> }) => Socket;
  return new RNWebSocket(url, [], { headers: { Authorization: `Bearer ${token}` } });
}

export function createVoiceSession(options: Options) {
  const { audio, mode } = options;
  const onDemand = mode !== 'followup';
  const startedAt = Date.now();
  const time = options.timeMs ?? (() => Date.now() - startedAt);
  let state: Snapshot = { phase:'idle', paused:false, transcriptionPaused:false, micMuted:false, capturing:false, sonioxReady:false, liveReady:false, playback:false, partials:[], references:[], saving:false };
  const listeners = new Set<() => void>();
  const pending = new Map<string, Turn>();
  const soniox = sonioxTranscript();
  const live = liveTranscript(mode === 'meeting' ? 'meeting-ai' : mode);
  let socket: Socket | undefined;
  let startedSocket: Socket | undefined;
  let capture: Promise<void> | undefined;
  let captureControl: AbortController | undefined;
  let stoppingCapture: Promise<void> | undefined;
  let firstAudioAt: number | undefined;
  let connectingTimer: ReturnType<typeof setTimeout> | undefined;
  let saveTask: Promise<boolean> | undefined;
  let endTask: Promise<boolean> | undefined;
  let endAck: ((flushed: boolean) => void) | undefined;
  let finishTask: Promise<{flushed: boolean; saved: boolean}> | undefined;
  let lastFlushed = true;
  let liveUnavailable = false;
  let plansSearch = false;
  let engaged = false;
  let outputBlocked = false;
  let disposed = false;
  let generation = 0;
  let playbackEpoch = 0;
  let queueingPlayback = 0;
  let suppressedInput = false;
  let listeningPending = false;
  let followupPlayback = false;
  let followupAudioStarted: number | undefined;
  let followupPlayedMs = 0;
  let sonioxPartials: Turn[] = [];
  let followupPreview: Turn[] = [];
  let questions: Array<{start:number; end?:number}> = [];

  const patch = (change: Partial<Snapshot>) => {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  };
  const socketUrl = () => {
    const url = options.baseUrl;
    if (!/^https?:\/\/(?:[\w.-]+|\[[\da-f:]+\])(?::\d{1,5})?\/?$/i.test(url)) throw Error('서버 주소를 확인하세요.');
    return url.replace(/^http/i, 'ws').replace(/\/$/, '') + '/stream';
  };
  const send = (message: Record<string, unknown>, target = socket): boolean => {
    if (!target || target.readyState !== 1) return false;
    try { target.send(JSON.stringify(message)); return true; }
    catch { return false; }
  };
  const recordingDetails = () => {
    const meeting = options.getQuestionMeeting?.();
    if (!meeting) return;
    return {title:meeting.title.trim().slice(0,120), project:meeting.project?.trim().slice(0,120) || undefined};
  };

  function retrySave(): Promise<boolean> {
    if (saveTask) return saveTask;
    if (!pending.size) return Promise.resolve(true);
    saveTask = Promise.resolve().then(async () => {
      patch({saving:true,saveError:undefined});
      while (pending.size) {
        const entry = pending.entries().next();
        if (entry.done) break;
        const [id, turn] = entry.value;
        try { await options.persist(turn); }
        catch { patch({saveError}); return false; }
        if (pending.get(id) === turn) pending.delete(id);
      }
      return true;
    }).finally(() => { saveTask = undefined; patch({saving:false}); });
    return saveTask;
  }

  const enqueue = (turns: Turn[]) => {
    for (const turn of turns) pending.set(turn.id, turn);
    if (!state.saveError && turns.length) void retrySave();
  };
  const publishPartials = () => patch({partials:[...sonioxPartials,...followupPreview]});
  const followupPlayedTime = () => followupPlayedMs + (followupAudioStarted === undefined ? 0 : Math.max(0,time() - followupAudioStarted));
  const saveFollowupCaption = (finished: boolean) => {
    if (mode !== 'followup') return;
    const heard = live.heard(followupPlayedTime(), finished && state.playback);
    const entireCaption = heard.at(-1)?.text === followupPreview.at(-1)?.text;
    if (finished || entireCaption) {
      enqueue(heard);
      followupPreview = [];
      publishPartials();
    }
    if (finished) {
      followupAudioStarted = undefined;
      followupPlayedMs = 0;
      live.outputDrained();
    }
  };
  const clearConnection = (current = socket) => {
    if (!current || socket !== current) return;
    clearTimeout(connectingTimer);
    connectingTimer = undefined;
    socket = undefined;
    startedSocket = undefined;
    if (state.sonioxReady || state.liveReady) patch({sonioxReady:false,liveReady:false});
    current.onclose = null;
    try { current.close(); } catch { /* already closed */ }
  };
  const stopCapture = () => {
    const active = capture;
    capture = undefined;
    if (!active) return Promise.resolve();
    const wasCapturing = state.capturing;
    captureControl?.abort();
    captureControl = undefined;
    if (wasCapturing) patch({capturing:false});
    const stopping = active.then(() => audio.stopCapture(), () => undefined)
      .catch(() => { if (!disposed && state.phase !== 'finished') patch({error:'마이크를 중지하지 못했습니다.'}); })
      .finally(() => { if (stoppingCapture === stopping) stoppingCapture = undefined; });
    stoppingCapture = stopping;
    // The browser or OS can leave a permission prompt pending indefinitely.
    // An active capture still flushes before closing; late grants clean up separately.
    return wasCapturing ? stoppingCapture : Promise.resolve();
  };
  const stopOutput = (mark: boolean) => {
    outputBlocked = true;
    playbackEpoch++;
    queueingPlayback = 0;
    listeningPending = false;
    followupPlayback = false;
    if (state.playback) suppressedInput = true;
    if (mode === 'followup') saveFollowupCaption(true);
    else if (mark) enqueue(live.interrupt().turns);
    patch({playback:false});
    void audio.stopPlayback().catch(() => patch({error:'AI 음성을 중지하지 못했습니다.'}));
  };
  const settlePlayback = () => {
    if (state.playback || suppressedInput || queueingPlayback) return;
    if (followupPlayback) {
      followupPlayback = false;
      if (state.liveReady) send({type:'playback',active:false});
    }
    if (!onDemand && followupPreview.length) saveFollowupCaption(false);
    if (!listeningPending) return;
    listeningPending = false;
    playbackEpoch++;
    if (onDemand) live.outputDrained();
    if (onDemand && engaged && state.liveReady) send({type:'question_ready'});
    patch({phase:'question'});
  };
  const playbackFailure = (message: string) => {
    if (onDemand) leave();
    else stopOutput(true);
    patch({error:message});
  };
  const closeQuestion = () => {
    if (engaged && questions.length) {
      questions = [...questions.slice(0,-1), {...questions.at(-1)!, end:time()}];
    }
    engaged = false;
    if (state.liveReady) patch({liveReady:false});
    generation++;
  };
  const endUnexpected = (message: string, phase: 'error'|'disconnected') => {
    if (endAck) { endAck(false); return; }
    clearConnection();
    if (state.phase === 'finishing' || state.phase === 'finished' || disposed) return;
    lastFlushed = false;
    closeQuestion();
    stopOutput(true);
    void stopCapture();
    patch({phase,error:message,partials:[]});
  };
  const startCapture = () => {
    if (capture || state.paused || endTask) return capture;
    const control = new AbortController();
    captureControl = control;
    const start = async () => {
      if (control.signal.aborted) throw Error('마이크 시작이 취소되었습니다.');
      audio.setMicMuted?.(state.micMuted);
      await audio.startCapture(control.signal);
    };
    capture = stoppingCapture ? stoppingCapture.then(start) : start();
    const active = capture;
    void active.then(() => {
      if (capture === active && !disposed) patch({capturing:true});
    }, error => {
      if (capture === active) endUnexpected(error instanceof Error ? error.message : '마이크 권한과 상태를 확인하세요.', 'error');
    });
    return active;
  };
  const lookup = async (current: Socket, id: string, query: string, questionStart?: number, plan?: VoiceSearchPlan) => {
    const at = generation;
    const beforeMs = typeof questionStart === 'number' && Number.isFinite(questionStart) && questionStart >= 0
      ? (firstAudioAt ?? 0) + questionStart : questions.at(-1)?.start ?? time();
    const pendingTurns = [...pending.values()];
    let history: MeetingQuestionHistory | undefined;
    try { history = options.getQuestionHistory?.(query, beforeMs, pendingTurns, plan); }
    catch { /* Other eligible sources can still be searched. */ }
    if (history?.context || history?.scope) send({type:'search_context',id,currentContext:history.context,scope:history.scope},current);
    let failed = false;
    const result = await options.search(query,beforeMs,pendingTurns,history?.scope,plan).catch(() => {
      failed = true;
      return '기록 검색에 실패했습니다. 근거가 없다고 단정하지 마세요.';
    });
    if (socket === current && generation === at && state.liveReady && (!onDemand || engaged) && !finishTask) {
      if (failed) patch({error:'기기 저장소에서 기록을 검색하지 못했습니다.'});
      const recap = history?.recap ?? (typeof result === 'string' ? undefined : result.recap);
      const historyIncomplete = recap?.incomplete || recap?.chunks.some(text => !send({type:'search_history',id,text},current));
      send({type:'search_result',id,context:typeof result === 'string' ? result : result.context,
        ...(historyIncomplete ? {historyIncomplete:true} : {}),...(failed ? {failed:true} : {})},current);
    }
  };

  function onMessage(current: Socket, raw: unknown) {
    if (typeof raw !== 'string') return;
    let event: Incoming;
    try { event = JSON.parse(raw); } catch { return; }
    if (!event || typeof event !== 'object') return;
    const wantsAi = !onDemand || engaged;
    const activeAi = wantsAi && state.liveReady && !state.paused && !finishTask && state.phase !== 'finishing';
    switch (event.type) {
      case 'ready':
        if (endTask || finishTask || state.phase === 'finishing') break;
        if (event.scope === 'meeting') {
          plansSearch = event.plansSearch === true;
          const transcribing = onDemand || liveUnavailable;
          if (transcribing) clearTimeout(connectingTimer);
          startCapture();
          patch({sonioxReady:true, ...(transcribing ? {phase:'recording'} : {})});
        } else if (event.scope === 'live' && wantsAi && state.sonioxReady) {
          clearTimeout(connectingTimer);
          liveUnavailable = false;
          if (queueingPlayback || state.playback) stopOutput(true);
          else if (!onDemand) saveFollowupCaption(true);
          outputBlocked = false;
          playbackEpoch++;
          startCapture();
          patch({liveReady:true, phase:state.phase === 'processing' || state.phase === 'responding' ? state.phase : 'question'});
        }
        break;
      case 'soniox':
        if (!Array.isArray(event.tokens) || typeof event.streamId !== 'string' || !Number.isFinite(event.offsetMs)) break;
        {
          firstAudioAt ??= event.offsetMs;
          const tokens = state.transcriptionPaused
            ? event.tokens.filter(token => token && (token.is_final === true || token.questionAudio === true)) : event.tokens;
          const change = soniox.receive(event.streamId,firstAudioAt,tokens,(at, token) => {
            if (mode !== 'meeting') return mode;
            const invited = token.questionAudio === true || questions.some(({start,end}) => at >= start && (end === undefined || at < end));
            return invited ? 'meeting-ai' : 'meeting';
          });
          enqueue(change.turns);
          sonioxPartials = change.partials;
          publishPartials();
        }
        break;
      case 'live':
        if (!wantsAi || !event.event || typeof event.streamId !== 'string' || !Number.isFinite(event.offsetMs)) break;
        if (event.event.type === 'session.input_transcript.delta') break;
        if (event.event.type === 'session.output_transcript.delta' && (outputBlocked || !state.liveReady)) break;
        {
          const refs = onDemand && Array.isArray(event.refs) ? [...new Set(event.refs.filter(isSourceRef))].slice(0, 2) : undefined;
          const quotes = Array.isArray(event.quotedRefs) ? event.quotedRefs.filter(isOriginalSourceRef) : [];
          const quoted = refs?.filter(ref => quotes.includes(ref));
          const {turns} = live.receive(event.streamId,event.offsetMs,event.event,time(),refs,quoted);
          if (onDemand) enqueue(turns);
          else if (turns.length) {
            followupPreview = turns;
            publishPartials();
            if (!state.playback && !queueingPlayback && !suppressedInput) saveFollowupCaption(false);
          }
        }
        break;
      case 'audio':
        if (activeAi && !outputBlocked && typeof event.audio === 'string') {
          const at = playbackEpoch;
          queueingPlayback++;
          void audio.play(event.audio).catch(() => {
            if (at !== playbackEpoch || socket !== current || !state.liveReady || finishTask) return;
            playbackFailure('AI 음성을 재생하지 못했습니다.');
          }).finally(() => {
            if (at !== playbackEpoch) return;
            queueingPlayback--;
            settlePlayback();
          });
        }
        break;
      case 'search':
        if (activeAi && typeof event.id === 'string' && typeof event.query === 'string' &&
          (!options.getQuestionMeeting || validSearchPlan(event.plan))) {
          void lookup(current,event.id,event.query,event.questionStart,event.plan);
        }
        break;
      case 'evidence':
        if (activeAi && Array.isArray(event.refs)) patch({references:[...new Set(event.refs.filter(isSourceRef))].slice(0, 2)});
        break;
      case 'followup_state':
        if (mode === 'followup' && ['prompting','waiting','judging','complete'].includes(event.state)) patch({followupState:event.state});
        break;
      case 'ai_state':
        if (!wantsAi || (onDemand && !state.liveReady) || liveUnavailable || state.phase === 'finishing' || state.paused) break;
        if (event.interrupted) stopOutput(true);
        if (event.state === 'listening') {
          listeningPending = true;
          settlePlayback();
        } else if (event.state === 'processing') {
          if (state.phase === 'responding' && !state.playback && !suppressedInput && !queueingPlayback) {
            playbackEpoch++;
            if (onDemand) live.outputDrained();
          }
          listeningPending = false;
          if (state.liveReady) outputBlocked = false;
          patch({phase:'processing'});
        }
        else if (event.state === 'responding' && state.liveReady) {
          listeningPending = false;
          outputBlocked = false;
          patch({phase:'responding'});
        }
        break;
      case 'finished':
        endAck?.(event.flushed === true);
        break;
      case 'error':
        if (typeof event.message !== 'string') break;
        if (onDemand && event.scope === 'live') {
          if (!engaged || endTask) break;
          leave();
          patch({error:event.message});
        } else if (mode === 'followup' && event.scope === 'live' && !event.fatal) {
          lastFlushed = false;
          liveUnavailable = true;
          if (endTask || finishTask) break;
          if (state.sonioxReady) clearTimeout(connectingTimer);
          closeQuestion();
          stopOutput(true);
          patch({phase:state.sonioxReady ? 'recording' : 'connecting',error:event.message});
        } else if (mode === 'followup' && event.scope === 'meeting' && event.fatal) {
          lastFlushed = false;
          patch({sonioxReady:false});
          if (endTask || finishTask) break;
          void closeStream(true).then(() => { if (!disposed && !finishTask) patch({phase:'error',error:event.message}); });
        } else if (event.fatal) endUnexpected(event.message, 'error');
        else patch({error:event.message});
        break;
    }
  }

  function open() {
    if (disposed || socket || state.paused || finishTask || state.phase === 'finished') return;
    patch({phase:'connecting',error:undefined,partials:[],references:[],followupState:undefined});
    sonioxPartials = [];
    followupPreview = [];
    outputBlocked = false;
    suppressedInput = false;
    firstAudioAt = undefined;
    plansSearch = false;
    liveUnavailable = false;
    let current: Socket;
    try { current = (options.connect ?? reactNativeSocket)(socketUrl(),options.token); }
    catch { endUnexpected('서버에 연결할 수 없습니다. 주소와 네트워크를 확인하세요.', 'error'); return; }
    socket = current;
    const armTimeout = (message = '음성 서비스가 연결에 응답하지 않습니다.') => {
      clearTimeout(connectingTimer);
      connectingTimer = setTimeout(() => {
        if (socket === current) endUnexpected(message,'error');
      }, 20_000);
    };
    const sendStart = () => {
      if (socket !== current || endTask || finishTask) return;
      if (!send({type:'start',mode,timeMs:time(),...(options.voice ? {voice:options.voice} : {}),
        meeting:recordingDetails(),
        ...(state.transcriptionPaused ? {transcriptionPaused:true} : {}),
        ...(onDemand ? {} : {context:options.getContext()})},current)) {
        endUnexpected(disconnected,'disconnected');
      } else startedSocket = current;
    };
    current.onopen = () => {
      if (mode !== 'followup') { sendStart(); return; }
      if (socket !== current || endTask) return;
      armTimeout('마이크 시작에 시간이 너무 오래 걸렸습니다. 마이크 권한을 확인한 뒤 다시 연결하세요.');
      // Followup can speak as soon as the provider connects; bring up native playback first.
      void startCapture()?.then(() => {
        if (socket !== current || endTask || finishTask) return;
        armTimeout();
        sendStart();
      }, () => undefined);
    };
    current.onmessage = ({data}) => { if (socket === current) onMessage(current,data); };
    current.onclose = () => { if (socket === current) endUnexpected(disconnected,'disconnected'); };
    current.onerror = () => { if (socket === current) endUnexpected('서버 연결에 실패했습니다. 서버 주소, 접근 토큰과 네트워크를 확인하세요.','error'); };
    armTimeout();
  }

  async function closeStream(providerClosing = false): Promise<boolean> {
    if (endTask) return endTask;
    const current = socket;
    if (!current) return lastFlushed;
    patch({phase:'finishing'});
    stopOutput(true);
    if (startedSocket !== current && !providerClosing) {
      clearConnection(current);
      await stopCapture();
      return lastFlushed;
    }
    const acknowledgement = new Promise<boolean>(resolve => {
      const timer = setTimeout(() => endAck?.(false), options.finishTimeoutMs ?? 10_000);
      endAck = (received) => {
        clearTimeout(timer);
        endAck = undefined;
        clearConnection(current);
        resolve(received);
      };
    });
    const stopped = stopCapture();
    if (!providerClosing) {
      void stopped.then(() => {
        if (endAck && !send({type:'finish'},current)) endAck(false);
      });
    }
    endTask = Promise.all([acknowledgement,stopped]).then(([flushed]) => {
      closeQuestion();
      if (!flushed) lastFlushed = false;
      patch({partials:[],...(!flushed ? {error:unflushed} : {})});
      return lastFlushed;
    }).finally(() => { endTask = undefined; });
    return endTask;
  }

  function leave() {
    if (!onDemand || !engaged || endTask) return;
    closeQuestion();
    stopOutput(true);
    send({type:'leave'});
    patch({phase:'recording'});
  }
  function interruptOutput(bargeIn = false) {
    if (!state.liveReady || state.paused || finishTask || state.phase === 'finishing') return false;
    stopOutput(true);
    generation++;
    patch({liveReady:false,phase:'question'});
    return send({type:'interrupt',timeMs:time(),...(bargeIn ? {bargeIn:true} : {})});
  }
  async function pause() {
    if (disposed || state.paused || !socket || finishTask) return;
    patch({paused:true});
    await closeStream();
    if (!finishTask) patch({phase:'recording'});
  }
  function setTranscriptionPaused(paused: boolean) {
    if (disposed || !onDemand || finishTask || endTask || state.phase === 'finished' || state.transcriptionPaused === paused) return;
    if (socket && startedSocket === socket && !send({type:'transcription_pause',paused})) {
      endUnexpected(disconnected,'disconnected');
    }
    sonioxPartials = [];
    patch({transcriptionPaused:paused,partials:[]});
  }
  function setMicMuted(muted: boolean) {
    if (disposed || finishTask || endTask || state.phase === 'finished' || state.micMuted === muted) return;
    audio.setMicMuted?.(muted);
    patch({micMuted:muted});
  }
  let subs: Array<{remove(): void}> = [];
  function start() {
    if (!subs.length) subs = [
      audio.addListener('onAudio', ({audio:frame,suppressed,bargeIn}) => {
        const recording = state.sonioxReady && !state.paused && !finishTask && state.phase !== 'finishing';
        let muted = suppressed === true;
        if (bargeIn) {
          const speaking = state.playback || queueingPlayback || suppressedInput || state.phase === 'responding';
          // The interrupt sets the Soniox cutoff before the preserved opening speech.
          muted = muted || state.micMuted || !recording || !onDemand || !engaged || outputBlocked || !speaking || !interruptOutput(true);
        }
        suppressedInput = muted && !state.micMuted;
        if (!suppressedInput) settlePlayback();
        if (recording) {
          const silent = state.micMuted || (state.transcriptionPaused && !engaged);
          if (send({type:'audio',audio:silent ? silentFrame(frame) : frame,...(silent || muted ? {suppressed:true} : {})})) {
            // The Soniox clock starts at the first PCM frame, after any local permission prompt.
            firstAudioAt ??= Math.max(0,time() - Math.round(frame.length / 64));
          }
        }
      }),
      audio.addListener('onPlayback', ({active}) => {
        if (active && (outputBlocked || !state.liveReady || state.paused)) stopOutput(false);
        else {
          if (!onDemand) {
            if (active) followupAudioStarted ??= time();
            else {
              followupPlayedMs = followupPlayedTime();
              followupAudioStarted = undefined;
            }
          }
          if (active) {
            suppressedInput = true;
            if (mode === 'followup' && !followupPlayback) followupPlayback = send({type:'playback',active:true});
          }
          patch({playback:active});
          if (!active) settlePlayback();
        }
      }),
      audio.addListener('onError', ({message,scope}) => {
        if (scope === 'archive') patch({error:message});
        else if (scope === 'playback') playbackFailure(message);
        else if (!state.paused && !endTask && !finishTask) {
          lastFlushed = false;
          void closeStream().then(() => { if (!disposed && !finishTask) patch({phase:'error',error:message}); });
        }
      }),
    ];
    open();
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start,
    setTranscriptionPaused,
    setMicMuted,
    ask() {
      if (!onDemand || !state.sonioxReady || state.phase !== 'recording' || state.paused) return;
      if (options.getQuestionMeeting && !plansSearch) {
        patch({error:'서버를 최신 버전으로 업데이트한 뒤 AI에게 질문해 주세요. 전사는 계속됩니다.'});
        return;
      }
      const at = time();
      const meeting = recordingDetails();
      if (!send({type:'ask',timeMs:at,...(meeting ? {
        planSearch:true, meeting,
      } : {context:options.getContext()})})) return;
      engaged = true;
      generation++;
      outputBlocked = false;
      if (mode === 'meeting') questions = [...questions,{start:at}];
      patch({phase:'question',error:undefined,references:[]});
    },
    leave,
    interrupt() {
      interruptOutput();
    },
    skip() {
      if (mode !== 'followup' || !state.liveReady || state.paused || state.phase === 'finishing' || state.followupState === 'complete') return;
      stopOutput(true);
      generation++;
      patch({liveReady:false,phase:'processing',followupState:undefined});
      send({type:'skip',timeMs:time()});
    },
    pause,
    backgrounded: () => state.capturing ? pause() : undefined,
    async resume() {
      if (!state.paused || finishTask || disposed) return;
      await endTask;
      patch({paused:false,micMuted:false});
      open();
    },
    async reconnect() {
      if (state.phase !== 'disconnected' && state.phase !== 'error') return;
      await stopCapture();
      open();
    },
    retrySave,
    finish() {
      if (finishTask) return finishTask;
      finishTask = Promise.resolve().then(async () => {
        const flushed = await closeStream();
        const saved = await retrySave();
        if (!saved) finishTask = undefined;
        patch({phase:'finished',paused:false,transcriptionPaused:false,micMuted:false,playback:false,partials:[]});
        return {flushed,saved};
      });
      return finishTask;
    },
    dispose() {
      disposed = true;
      subs.forEach(sub => sub.remove());
      subs = [];
      listeners.clear();
      if (endAck) endAck(false);
      else clearConnection();
      void stopCapture();
      void audio.stopPlayback().catch(() => undefined);
    },
  };
}
