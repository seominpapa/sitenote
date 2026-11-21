import { requireNativeModule, type NativeModule } from 'expo';
import { PermissionsAndroid, Platform } from 'react-native';
import { createInputRouter, type NativeInput } from './input';

type Events = {
  onAudio: { audio: string; suppressed?: boolean; bargeIn?: boolean };
  onPlayback: { active: boolean };
  onError: { message: string; scope?: string };
};

type EventListeners<T> = {[K in keyof T]: (event: T[K]) => void};

declare class NativeSiteAudio extends NativeModule<EventListeners<Events>> {
  startCapture(archiveUri: string | null, captureId: number, bargeIn: boolean): Promise<void>;
  cancelCaptureStart(captureId: number): Promise<void>;
  stopCapture(): Promise<void>;
  setMicMuted(muted: boolean): void;
  play(audio: string): Promise<void>;
  stopPlayback(): Promise<void>;
  playPreview(wave: ArrayBuffer): Promise<void>;
  stopPreview(): Promise<void>;
  writeTextAtomic(uri: string, text: string): Promise<void>;
  pickNoteFolder(): Promise<{uri: string; label: string} | null>;
  pickNoteDocument(): Promise<{filename: string; cachePath: string} | null>;
  publishNoteFiles(folderUri: string, id: string, name: string, transcript: string, summary: string | null, imported: boolean): Promise<void>;
  openOriginalNote(uri: string, id: string, name: string): Promise<void>;
  openLegacyNote(folderUri: string, id: string, name: string): Promise<void>;
  deleteNoteFiles(folderUri: string, id: string): Promise<void>;
}
declare class NativeVoiceEvents extends NativeModule<EventListeners<{
  onAudio: NativeInput;
  onRender: {audio: string; start: number} | {end: number};
}>> {}

const native = requireNativeModule<NativeSiteAudio>('SiteAudio');
let captureId = 0;
let input = createInputRouter(false);
const cancel = () => Error('마이크 시작이 취소되었습니다.');
const events = native as unknown as NativeVoiceEvents;

function addListener<K extends keyof Events>(name: K, listener: (event: Events[K]) => void) {
  if (name === 'onAudio') {
    const send = listener as (event: Events['onAudio']) => void;
    const render = events.addListener('onRender', event => {
      if ('audio' in event) input.output(event.audio,event.start);
      else input.endOutput(event.end);
    });
    const incoming = events.addListener('onAudio', event => input.input(event).forEach(send));
    return {remove() { incoming.remove(); render.remove(); }};
  }
  return (native.addListener.bind(native) as <T extends keyof Events>(
    event: T, callback: (value: Events[T]) => void,
  ) => {remove(): void})(name,listener);
}

export default {
  addListener,
  async startCapture(archiveUri?: string, signal?: AbortSignal, bargeIn = false) {
    if (signal?.aborted) throw cancel();
    if (Platform.OS === 'android') {
      const permission = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)
        ? PermissionsAndroid.RESULTS.GRANTED : await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      if (signal?.aborted) throw cancel();
      if (permission !== PermissionsAndroid.RESULTS.GRANTED) {
        throw new Error('마이크 권한을 허용해 주세요. 설정에서 다시 변경할 수 있습니다.');
      }
    }
    const id = ++captureId;
    const abort = () => { void native.cancelCaptureStart(id).catch(() => undefined); };
    signal?.addEventListener('abort',abort,{once:true});
    input = createInputRouter(bargeIn);
    try {
      await native.startCapture(archiveUri ?? null,id,bargeIn);
      if (signal?.aborted) throw cancel();
    } finally {
      signal?.removeEventListener('abort',abort);
    }
  },
  stopCapture: () => native.stopCapture(),
  setMicMuted: (muted: boolean) => native.setMicMuted(muted),
  play: (audio: string) => native.play(audio),
  stopPlayback: () => native.stopPlayback(),
  playPreview: (wave: ArrayBuffer) => native.playPreview(wave),
  stopPreview: () => native.stopPreview(),
  writeTextAtomic: (uri: string, text: string) => native.writeTextAtomic(uri, text),
  pickNoteFolder: () => native.pickNoteFolder(),
  pickNoteDocument: () => native.pickNoteDocument(),
  publishNoteFiles: (folderUri: string, id: string, name: string, transcript: string, summary: string | null, imported: boolean) =>
    native.publishNoteFiles(folderUri, id, name, transcript, summary, imported),
  openOriginalNote: (uri: string, id: string, name: string) => native.openOriginalNote(uri, id, name),
  openLegacyNote: (folderUri: string, id: string, name: string) => native.openLegacyNote(folderUri, id, name),
  deleteNoteFiles: (folderUri: string, id: string) => native.deleteNoteFiles(folderUri, id),
};
