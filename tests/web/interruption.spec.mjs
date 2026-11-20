import { expect, test } from '@playwright/test';
import { EventEmitter, once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.mjs';

const first = '첫 번째 안내를 부탁합니다.';
const barge = '잠깐만요, 바뀐 날짜를 알려 주세요.';
const ongoing = '첫 질문에 길게 답하는 중입니다.';
const next = '변경된 날짜는 다음 월요일입니다.';
const stale = '중단 이후 이전 답변의 뒷부분입니다.';
const render = Buffer.alloc(24_000 * 2 * 3);
for (let i = 0; i < render.length / 2; i++) {
  render.writeInt16LE(Math.round(9_800 * Math.sin(2 * Math.PI * 440 * i / 24_000)), i * 2);
}

for (const { kind, label, completeOnServer } of [
  { kind: '개인 대화', label: '개인 대화', completeOnServer: false },
  { kind: '회의', label: '회의', completeOnServer: true },
]) {
  test(`${kind}: loud echo is ignored; speaking over AI stops playback and sends the next complete question`, async ({ page }) => {
    const forwarded = [];
    let speechFrames = 0;
    let echoFrames = 0;
    let sttConnections = 0;
    let aiConnections = 0;
    let previousReplyClosed = false;
    const server = createApp({
      webRoot: process.env.SITENOTE_WEB_TEST_ROOT || fileURLToPath(new URL('../../dist/web', import.meta.url)),
      accessToken: 'test-only-not-a-real-access-token',
      openaiKey: 'test-only',
      sonioxKey: 'test-only',
      upstream(url) {
        const soniox = new URL(url).hostname === 'stt-rt.soniox.com';
        const connection = soniox ? ++sttConnections : ++aiConnections;
        let audioMs = 0;
        let start = 0;
        let utterance = 0;
        let voiced = 0;
        let quiet = 0;
        let firstResponse;
        const socket = Object.assign(new EventEmitter(), {
          readyState: 1, bufferedAmount: 0,
          send(raw) {
            if (soniox) {
              if (!Buffer.isBuffer(raw) || raw.length !== 960) return;
              let peak = 0;
              for (let i = 0; i < raw.length; i += 2) peak = Math.max(peak, Math.abs(raw.readInt16LE(i)));
              if (peak > 9_000) echoFrames++;
              if (peak > 1_000 && peak <= 9_000) {
                if (!voiced) start = audioMs;
                voiced++;
                quiet = 0;
              } else if (voiced && ++quiet === 3) {
                if (utterance === 1) speechFrames = voiced;
                const text = utterance++ === 0 ? first : barge;
                emit({ tokens: [{text, speaker:'1', start_ms:start, end_ms:audioMs, is_final:true}, {text:'<end>', is_final:true}] });
                voiced = quiet = 0;
              }
              audioMs += 20;
              return;
            }
            const data = JSON.parse(raw);
            if (data.type === 'session.update') {
              if (connection === 1) emit({type:'session.updated'});
              else setTimeout(() => emit({type:'session.updated'}), 330);
            }
            if (data.type === 'conversation.item.create') forwarded.push(data.item.content[0].text);
            if (data.type !== 'response.create') return;
            const response = {id:`reply-${connection}`, metadata:data.response.metadata};
            if (connection === 1) firstResponse = response.id;
            emit({type:'response.created', response});
            const audio = connection === 1 ? render : render.subarray(0, 9_600);
            for (let i = 0; i < audio.length; i += 24_000) {
              emit({type:'response.output_audio.delta', event_id:`audio-${i}`, response_id:response.id,
                delta:audio.subarray(i,i + 24_000).toString('base64')});
            }
            emit({type:'response.output_audio_transcript.delta', event_id:'text', response_id:response.id,
              delta:connection === 1 ? ongoing : next});
            if (connection > 1 || completeOnServer) emit({type:'response.done',response:{...response,status:'completed'}});
          },
          close() {
            if (this.readyState === 3) return;
            this.readyState = 3;
            if (!soniox && firstResponse) {
              previousReplyClosed = true;
              emit({type:'response.output_audio_transcript.delta', event_id:'late', response_id:firstResponse, delta:stale});
            }
            this.emit('close');
          },
          terminate() { this.close(); },
        });
        const emit = data => queueMicrotask(() => socket.emit('message', JSON.stringify(data)));
        queueMicrotask(() => socket.emit('open'));
        return socket;
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      await page.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = async () => {
          const context = new AudioContext();
          await context.resume();
          const output = context.createMediaStreamDestination();
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          gain.gain.value = 0;
          oscillator.connect(gain).connect(output);
          oscillator.start();
          window.speak = (hz, amplitude, duration) => {
            const start = context.currentTime + 0.01;
            oscillator.frequency.setValueAtTime(hz, start);
            gain.gain.setValueAtTime(amplitude, start);
            gain.gain.setValueAtTime(0, start + duration);
          };
          return output.stream;
        };
        const stop = AudioBufferSourceNode.prototype.stop;
        window.stoppedAnswerBeforeEnd = false;
        AudioBufferSourceNode.prototype.stop = function (...args) {
          if (this.buffer?.duration === 0.5) window.stoppedAnswerBeforeEnd = true;
          return stop.apply(this, args);
        };
      });
      await page.goto('http://127.0.0.1:' + server.address().port);
      await expect(page.getByText('로컬 서버 연결됨')).toBeVisible();
      await page.getByLabel(`${label} 제목`, {exact:true}).fill('음성 끼어들기 테스트');
      await page.getByRole('button', {name:`${label} 시작`, exact:true}).click();
      await page.getByRole('button', {name:'AI에게 질문', exact:true}).click();
      await expect(page.getByTestId('ai-panel')).toContainText('질문 듣는 중');
      await page.evaluate(() => window.speak(610, .1, .24));
      await expect(page.getByTestId('ai-panel')).toContainText('답변 재생 중');
      const firstReply = page.getByTestId('transcript-turn').filter({hasText:ongoing});
      await expect(firstReply).toBeVisible();
      await page.evaluate(() => window.speak(440, .4, .24));
      // Stay in playback after a complete echo burst, then speak independently before it finishes.
      await expect.poll(() => page.evaluate(() => new Promise(resolve => {
        setTimeout(() => resolve(window.stoppedAnswerBeforeEnd), 330);
      }))).toBe(false);
      expect(echoFrames).toBe(0);
      await expect(page.getByTestId('ai-panel')).toContainText('답변 재생 중');
      await page.evaluate(() => window.speak(733, .18, .25));
      await expect(firstReply).toContainText('중단', {timeout:1_400});
      expect(await page.evaluate(() => window.stoppedAnswerBeforeEnd)).toBe(true);
      await expect(page.getByTestId('transcript-turn').filter({hasText:next})).toBeVisible();
      await expect(page.getByTestId('transcript-turn').filter({hasText:barge})).toHaveCount(1);
      await expect(page.getByText(stale)).toHaveCount(0);
      expect(speechFrames).toBeGreaterThanOrEqual(10);
      expect(forwarded).toEqual([first, barge]);
      expect(previousReplyClosed).toBe(true);
      expect(sttConnections).toBe(1);
    } finally {
      await page.close();
      await new Promise(done => server.close(done));
    }
  });
}
