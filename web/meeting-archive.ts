import { assertId } from '../src/records/model.ts';
import { FRAME_SAMPLES, PCM_RATE } from './pcm.ts';

const databaseName = 'sitenote-meeting-audio';
const samplesPerMs = PCM_RATE / 1000;
const chunkSamples = PCM_RATE * 4;
const maxPendingChunks = 8;
const maxPreviewMs = 60_000;
const defaultPreviewMs = 30_000;

type Interval = [start: number, end: number];
type Chunk = { id: string; index: number; pcm: ArrayBuffer; captured: Interval[] };

let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('chunks', { keyPath: ['id', 'index'] });
      request.result.createObjectStore('completed');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
  }).catch(error => { database = undefined; throw error; });
  return database;
}

async function transact<T>(mode: IDBTransactionMode, action: (tx: IDBTransaction) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['chunks', 'completed'], mode);
    tx.onabort = () => reject(tx.error ?? Error('녹음 저장소를 사용할 수 없습니다.'));
    try {
      const request = action(tx);
      tx.oncomplete = () => resolve(request.result);
    } catch (error) {
      reject(error);
      tx.abort();
    }
  });
}

const chunkRange = (id: string, first: number, last: number) => IDBKeyRange.bound([id, first], [id, last]);

export function removeMeetingArchive(id: string): Promise<void> {
  assertId(id);
  return transact('readwrite', tx => {
    tx.objectStore('chunks').delete(chunkRange(id, 0, Number.MAX_SAFE_INTEGER));
    return tx.objectStore('completed').delete(id);
  });
}

export async function hasMeetingArchive(id: string): Promise<boolean> {
  assertId(id);
  return (await transact('readonly', tx => tx.objectStore('completed').get(id))) === true;
}

function newChunk(id: string, index: number): Chunk {
  return { id, index, pcm:new ArrayBuffer(chunkSamples * 2), captured:[] };
}

function addSamples(chunk: Chunk, offset: number, source: Uint8Array<ArrayBuffer>, from: number, length: number): void {
  new Uint8Array(chunk.pcm).set(source.subarray(from * 2, (from + length) * 2), offset * 2);
  const previous = chunk.captured.at(-1);
  if (previous?.[1] === offset) chunk.captured[chunk.captured.length - 1] = [previous[0], offset + length];
  else chunk.captured.push([offset, offset + length]);
}

/** One writer per new note. Frame offsets are on the note's absolute 24 kHz timeline. */
export function createMeetingArchive(id: string) {
  assertId(id);
  let active: Chunk | undefined;
  let pending = 0;
  let lastSample = 0;
  let writeError: unknown;
  let closed = false;
  let writes: Promise<unknown> = Promise.resolve();
  let completed: Promise<boolean> | undefined;

  function flush() {
    if (!active) return;
    const chunk = active;
    active = undefined;
    if (writeError) return;
    if (pending >= maxPendingChunks) {
      writeError = Error('녹음 저장 속도가 마이크 입력을 따라가지 못했습니다.');
      return;
    }
    pending++;
    writes = writes.then(() => {
      if (!writeError) return transact('readwrite', tx => tx.objectStore('chunks').add(chunk));
    }).catch(error => { writeError = error; }).finally(() => { pending--; });
  }

  function appendFrame(startSample: number, base64: string): void {
    if (closed || writeError || !Number.isSafeInteger(startSample) || startSample < 0 ||
      startSample > Number.MAX_SAFE_INTEGER - FRAME_SAMPLES || base64.length > Math.ceil(FRAME_SAMPLES * 2 / 3) * 4) return;
    let pcm: Uint8Array<ArrayBuffer>;
    try { pcm = Uint8Array.from(atob(base64), char => char.charCodeAt(0)); }
    catch { return; }
    if (!pcm.length || pcm.length % 2) return;
    const samples = pcm.length / 2;
    const first = Math.max(startSample, lastSample);
    for (let at = first; at < startSample + samples;) {
      const index = Math.floor(at / chunkSamples);
      const offset = at % chunkSamples;
      if (active?.index !== index) {
        flush();
        if (writeError) return;
        active = newChunk(id, index);
      }
      const length = Math.min(chunkSamples - offset, startSample + samples - at);
      addSamples(active!, offset, pcm, at - startSample, length);
      at += length;
      lastSample = at;
    }
  }

  async function discard(): Promise<void> {
    closed = true;
    active = undefined;
    await (completed ?? writes).catch(() => {});
    await removeMeetingArchive(id);
  }

  return {
    appendFrame,
    finish(): Promise<boolean> {
      if (completed) return completed;
      if (closed) return Promise.resolve(false);
      closed = true;
      flush();
      completed = writes.then(async () => {
        try {
          if (writeError) throw writeError;
          if (!lastSample) return false;
          await transact('readwrite', tx => tx.objectStore('completed').add(true, id));
          return true;
        } catch (error) {
          await removeMeetingArchive(id);
          throw error;
        }
      });
      return completed;
    },
    discard,
    discardIfUnfinished: () => completed ? Promise.resolve() : discard(),
  };
}

function wave(pcm: Uint8Array<ArrayBuffer>): Blob {
  const header = new DataView(new ArrayBuffer(44));
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) header.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  header.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, 'WAVEfmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, PCM_RATE, true);
  header.setUint32(28, PCM_RATE * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  ascii(36, 'data');
  header.setUint32(40, pcm.byteLength, true);
  return new Blob([header.buffer, pcm], {type:'audio/wav'});
}

/** Read a bounded WAV starting on the requested note timestamp, leaving holes silent. */
export async function readMeetingAudio(id: string, startMs: number, endMs = startMs + defaultPreviewMs,
  options: {minimumCapturedMs?: number; requireContinuous?: boolean; stopAtGap?: boolean} = {}): Promise<Blob | undefined> {
  assertId(id);
  const start = Math.round(startMs * samplesPerMs);
  const end = Math.round(Math.min(endMs, startMs + maxPreviewMs) * samplesPerMs);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || !await hasMeetingArchive(id)) return;
  const chunks = await transact<Chunk[]>('readonly', tx => tx.objectStore('chunks').getAll(chunkRange(id,
    Math.floor(start / chunkSamples), Math.floor((end - 1) / chunkSamples))));
  const pcm = new Uint8Array((end - start) * 2);
  let playedSamples = 0;
  let capturedSamples = 0;
  playback: for (const chunk of chunks) {
    const offset = chunk.index * chunkSamples;
    for (const [first, last] of chunk.captured) {
      const from = Math.max(start, offset + first);
      const to = Math.min(end, offset + last);
      if (from >= to) continue;
      if (from - start > playedSamples) {
        if (options.requireContinuous) return;
        if (options.stopAtGap) break playback;
      }
      pcm.set(new Uint8Array(chunk.pcm, (from - offset) * 2, (to - from) * 2), (from - start) * 2);
      playedSamples = Math.max(playedSamples, to - start);
      capturedSamples += to - from;
    }
  }
  if (playedSamples && capturedSamples >= (options.minimumCapturedMs ?? 0) * samplesPerMs) {
    return wave(pcm.subarray(0, playedSamples * 2));
  }
}
