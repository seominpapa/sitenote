import { openQuestionVoice } from './question-voice.mjs';
import { isAiVoice } from './voices.mjs';

const sample = '안녕하세요. 사이트노트가 대화와 회의를 기록합니다.';
const sampleRate = 24_000;
const maxBytes = sampleRate * 2 * 8;

export function validVoicePreview(data) {
  return data && typeof data === 'object' && Object.keys(data).length === 1 && isAiVoice(data.voice);
}

function wave(chunks, size) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + size, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(size, 40);
  return Buffer.concat([header, ...chunks], header.length + size);
}

export function voicePreview(voice, options, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('요청이 취소되었습니다.'));
    const chunks = [];
    let size = 0;
    let connection;
    let finished = false;
    const finish = (message) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      connection?.close();
      if (message || !size) return reject(new Error(message || '미리 들을 음성을 받지 못했습니다.'));
      return resolve(wave(chunks, size));
    };
    const abort = () => finish('요청이 취소되었습니다.');
    const timer = setTimeout(() => finish('목소리 미리 듣기 요청 시간이 초과되었습니다.'), 14_000).unref();
    signal.addEventListener('abort', abort, {once: true});
    connection = openQuestionVoice(options, {
      ready: () => {
        if (!connection.speak(sample)) finish('목소리 미리 듣기를 시작하지 못했습니다.');
      },
      audio: encoded => {
        const bytes = Buffer.from(encoded, 'base64').subarray(0, maxBytes - size);
        chunks.push(bytes);
        size += bytes.length;
        if (size === maxBytes) finish();
      },
      done: () => finish(),
      fail: finish,
    }, voice);
  });
}
