import { expect, test } from '@playwright/test';
import { EventEmitter, once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.mjs';
import { ordinaryQuestionPlan } from './voice-plan.mjs';

const firstTurn = '다음 현장 점검은 금요일입니다.';
const lastTurn = '안전 점검표도 가져오세요.';
const otherClosingTurns = ['보호구도 확인하겠습니다.', '현장 안내는 제가 맡을게요.'];
const questionPrefix = '이번 현장 점검은';
const questionTail = ' 언제인가요?';
const questions = [questionPrefix + questionTail, '안전 점검표는 누가 준비하나요?'];
const playbackSpeech = 'AI 스피커에서 되돌아온 소리입니다.';
const latePlaybackSpeech = '이전 재생 중에 포착한 발언에 답해주세요.';
const aiReply = '금요일 현장 점검으로 기록했습니다.';
const secondAiReply = '점검표는 안전 담당자가 준비합니다.';
const followupQuestion = '현장 점검의 담당자는 누구인가요?';
const nextFollowupQuestion = '점검표를 누가 준비하나요?';
const followupAnswer = '김 대리가 현장 점검을 맡습니다.';
const followupSecondSpeaker = '현장 도착 시간은 오전 열 시입니다.';
const followupTail = '점검표는 제가 준비하겠습니다.';
const redundantGptTranscript = 'GPT의 중복 사용자 전사';
const title = '사용자가 입력한 현장 안전회의';
const summaryTitle = '현장 점검 자동 요약';
const audio = Buffer.alloc(48_000);
for (let i = 0; i < audio.length; i += 2) audio.writeInt16LE(Math.round(9_800 * Math.sin(Math.PI * 440 * i / 24_000)), i);
const audioEvent = {type: 'session.output_audio.delta', delta: audio.toString('base64')};
const chunk = (data) => ({...audioEvent, delta:data.toString('base64')});
// 500 ms of sound followed by 900 ms of silence split across provider deltas.
const paddedFollowup = [chunk(Buffer.concat([audio.subarray(0, 24_000), Buffer.alloc(1_920)])),
  ...Array.from({length:6}, () => chunk(Buffer.alloc(960))), chunk(Buffer.alloc(35_520))];
const sonioxTurn = (text, speaker, start) => ({
  text, speaker, is_final: true, start_ms: start, end_ms: start + 40,
});
const endpoint = {text:'<end>', is_final:true};

function pcmPeak(frame) {
  let peak = 0;
  for (let i = 0; i < frame.length; i += 2) peak = Math.max(peak, Math.abs(frame.readInt16LE(i)));
  return peak;
}

function containsTone(frame, hz) {
  const samples = frame.length / 2;
  let i = 0, sine = 0, cosine = 0, energy = 0;
  for (let sample = 0; sample < samples; sample++) {
    const value = frame.readInt16LE(i);
    i += 2;
    const phase = 2 * Math.PI * hz * sample / 24_000;
    sine += value * Math.sin(phase);
    cosine += value * Math.cos(phase);
    energy += value * value;
  }
  return energy > samples * 1_000 ** 2 && 2 * (sine ** 2 + cosine ** 2) > 0.7 * samples * energy;
}

// Recognize two distinct synthetic mic signals only after several frames and a pause.
function meetingUtterances() {
  let index = 0;
  let voiced = 0;
  let silent = 0;
  return peak => {
    if (index >= questions.length) return;
    if (index === 0 ? peak > 2_000 && peak < 5_000 : peak > 5_000 && peak < 9_000) {
      voiced++;
      silent = 0;
    } else if (peak < 20 && voiced >= 4 && ++silent === 3) {
      voiced = 0;
      silent = 0;
      return index++;
    }
  };
}

function fakeSocket(onSend, delay = 0) {
  const socket = Object.assign(new EventEmitter(), {
    readyState: 0, bufferedAmount: 0,
    send(data) { onSend(data, reply); },
    close() { this.readyState = 3; this.emit('close'); },
    terminate() { this.close(); },
  });
  const reply = data => queueMicrotask(() => socket.emit('message', JSON.stringify(data)));
  const open = () => { if (socket.readyState === 0) { socket.readyState = 1; socket.emit('open'); } };
  if (delay) setTimeout(open, delay).unref();
  else queueMicrotask(open);
  return socket;
}

test('answers only finalized meeting questions, then advances followup after a complete Soniox answer', async ({ page }) => {
  let releaseSummary;
  const slowSummary = new Promise(resolve => { releaseSummary = resolve; });
  let meetingFrames = 0;
  let followupSessions = 0;
  let questionSessions = 0;
  let liveConnections = 0;
  let sonioxConnections = 0;
  let releaseFirstEndpoint;
  let rememberLateUtterance;
  let playbackSpeechFrames = 0;
  const forwardedQuestions = [];
  const questionAudioInput = [];
  let meetingFlushed = false;
  let followupFinalized = false;
  let followupSonioxFinalized = false;
  let consentFrames = 0;
  let consentPromptEcho = 0;
  let answerFrames = 0;
  let judgedComplete = false;
  const server = createApp({
    planQuestion: ordinaryQuestionPlan,
    webRoot: process.env.SITENOTE_WEB_TEST_ROOT || fileURLToPath(new URL('../../dist/web', import.meta.url)),
    accessToken: 'test-only-not-a-real-access-token',
    openaiKey: 'test-only', sonioxKey: 'test-only',
    async transport(_url, request) {
      const payload = JSON.parse(request.body);
      const input = JSON.parse(payload.input);
      if (payload.text?.format?.name === 'followup_verdict') {
        const spoken = JSON.stringify(input);
        const complete = spoken.includes(followupAnswer);
        judgedComplete ||= complete;
        return Response.json({status:'completed', output:[{type:'message', content:[
          {type:'output_text', text: JSON.stringify({verdict:complete ? 'advance' : 'wait'})},
        ]}]});
      }
      const source = input.source;
      if (!followupFinalized) await slowSummary;
      if (![firstTurn, lastTurn, ...questions, aiReply, secondAiReply, title, '새 현장'].every(text => source.includes(text))) return new Response(null, {status: 400});
      if (source.includes(playbackSpeech)) return new Response(null, {status: 400});
      if (followupFinalized && (![followupAnswer, followupSecondSpeaker, followupTail].every(text => source.includes(text))
        || source.includes(redundantGptTranscript))) return new Response(null, {status: 400});
      return Response.json({status: 'completed', output: [{type: 'message', content: [{
        type: 'output_text', text: JSON.stringify({markdown: '# ' + summaryTitle, questions: [followupQuestion, nextFollowupQuestion]}),
      }]}]});
    },
    upstream(url) {
      const provider = new URL(url);
      if (provider.hostname === 'stt-rt.soniox.com') {
        const connection = ++sonioxConnections;
        const inMeeting = connection === 1;
        let answerStart;
        let secondSpeakerFrames = 0;
        let audioMs = 0;
        const meetingMic = meetingUtterances();
        return fakeSocket((data, reply) => {
          if (inMeeting && !rememberLateUtterance) rememberLateUtterance = () => {
            const beforeDrain = audioMs;
            return () => reply({tokens: [sonioxTurn(latePlaybackSpeech, '1', beforeDrain), endpoint]});
          };
          if (Buffer.isBuffer(data)) audioMs += data.length / 48;
          if (inMeeting && Buffer.isBuffer(data) && data.length === 960) {
            const peak = pcmPeak(data);
            const question = meetingMic(peak);
            const at = Math.max(0, audioMs - 210);
            if (peak > 9_000 && ++playbackSpeechFrames === 4) reply({tokens: [sonioxTurn(playbackSpeech, '1', at), endpoint]});
            if (question === 0) {
              const tail = sonioxTurn(questionTail, '1', at + 40);
              reply({tokens: [sonioxTurn(questionPrefix, '1', at), {...tail, is_final:false}]});
              releaseFirstEndpoint = () => reply({tokens: [tail, endpoint]});
            } else if (question !== undefined) reply({tokens: [sonioxTurn(questions[question], '1', at), endpoint]});
          }
          if (Buffer.isBuffer(data) && data.length === 960 && data.some(Boolean)) {
            if (inMeeting && ++meetingFrames === 1) reply({tokens: [sonioxTurn(firstTurn, '1', 0), endpoint]});
            if (connection === 2 && containsTone(data, 440)) consentPromptEcho++;
            if (connection === 2 && containsTone(data, 1073) && ++consentFrames === 4) {
              reply({tokens:[sonioxTurn('예', '1', 0), endpoint]});
            }
            if (connection === 3 && containsTone(data, 733)) {
              answerStart ??= audioMs - data.length / 48;
              if (++answerFrames === 2) reply({tokens:[sonioxTurn(followupAnswer, '1', answerStart), endpoint]});
            }
            if (connection === 3 && containsTone(data, 913) && ++secondSpeakerFrames === 5) {
              reply({tokens:[sonioxTurn(followupSecondSpeaker, '2', audioMs - 20)]});
            }
          }
          if (data === '') {
            if (connection === 2) return reply({finished:true});
            if (inMeeting) {
              meetingFlushed = true;
              const closingAt = audioMs + 60;
              [lastTurn, ...otherClosingTurns].forEach((text, index) => {
                reply({tokens:[sonioxTurn(text, String(index + 2), closingAt)]});
              });
              return reply({finished:true});
            }
            followupSonioxFinalized = true;
            reply({tokens:[sonioxTurn(followupTail, '2', audioMs + 60)], finished:true});
          }
        }, connection === 2 ? 950 : 0);
      }
      expect(provider.pathname).toBe('/v1/live/sessions');
      liveConnections++;
      let followupConnection = 0;
      let realFrames = 0;
      return fakeSocket((data, reply) => {
        const message = JSON.parse(data);
        if (message.type === 'session.start') {
          expect(message.session.model).toBe('gpt-live-1.1');
          expect(message.session.audio.output.voice).toBe('noeul');
          reply({type:'session.started'});
          if (message.session.instructions.startsWith('종료된 회의')) {
            followupConnection = ++followupSessions;
          } else {
            const question = message.session.input.filter(item => item.role === 'user').at(-1)?.content[0].text;
            const index = questionSessions++;
            forwardedQuestions.push(question);
            if (question !== questions[index] || index >= questions.length) return;
            reply({ ...audioEvent, event_id:`meeting-audio-${index}` });
            reply({
              type:'session.output_transcript.delta', event_id:`meeting-text-${index}`, delta:[aiReply, secondAiReply][index],
              start_ms:10, end_ms:100,
            });
          }
          return;
        }
        if (message.type === 'session.close') {
          if (followupConnection === 2) followupFinalized = true;
          return reply({type:'session.closed', reason:'close_requested'});
        }
        if (!followupConnection) {
          if (message.type === 'session.input_audio.append') questionAudioInput.push(message.audio);
          return;
        }
        if (message.type !== 'session.input_audio.append') return;
        if (++realFrames === 1 && followupConnection === 1) {
          for (const delta of paddedFollowup) reply(delta);
          reply({type: 'session.output_transcript.delta', delta: followupQuestion, start_ms: 20, end_ms: 150, event_id: 'followup-question'});
        }
        if (followupConnection === 1 && realFrames === 15) {
          reply({type: 'session.input_transcript.delta', delta: redundantGptTranscript, start_ms: 1000, end_ms: 1350, event_id: 'followup-duplicate'});
        }
        if (followupConnection === 2 && realFrames === 1) {
          reply(audioEvent);
          reply({type:'session.output_transcript.delta', delta:nextFollowupQuestion, start_ms:20, end_ms:150, event_id:'followup-next'});
        }
      });
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await page.addInitScript(() => {
      const audit = window.consentAudit = {ended:false, connected:false, ready:false, nonzeroBeforeEnd:0};
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        send(raw) {
          const packet = typeof raw === 'string' ? JSON.parse(raw) : undefined;
          if (packet?.type === 'start' && packet.mode === 'consent') {
            this.isConsent = audit.connected = true;
            this.addEventListener('message', ({data}) => {
              if (JSON.parse(data).type === 'ready') audit.ready = true;
            });
          }
          if (this.isConsent && !audit.ended && packet?.type === 'audio' && /[^\x00]/.test(atob(packet.audio))) audit.nonzeroBeforeEnd++;
          return super.send(raw);
        }
      };
      let worklets = 0;
      const NativeWorklet = window.AudioWorkletNode;
      window.AudioWorkletNode = class extends NativeWorklet {
        constructor(...args) { super(...args); worklets++; }
      };
      window.speechSynthesis.speak = utterance => {
        audit.micStartedBeforePrompt = worklets >= 2;
        audit.socketStartedBeforePrompt = audit.connected;
        audit.readyBeforePrompt = audit.ready;
        window.speakTestMic?.(0.22, 440, 0.14);
        setTimeout(() => {
          audit.ended = true;
          utterance.dispatchEvent(new Event('end'));
          window.speakTestMic?.(0.18, 1073, 0.16);
        }, 190);
      };
      let micCount = 0;
      navigator.mediaDevices.getUserMedia = async () => {
        if (micCount === 2) throw Error('이미 열린 마이크를 다시 요청했습니다.');
        const meeting = ++micCount === 1;
        const context = new AudioContext();
        await context.resume();
        const output = context.createMediaStreamDestination();
        const mic = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = meeting ? 0.03 : 0;
        mic.connect(gain).connect(output);
        mic.start();
        const track = output.stream.getAudioTracks()[0];
        const stop = track.stop.bind(track);
        track.stop = () => { stop(); mic.stop(); void context.close(); };
        window.speakTestMic = (amp, hz = 440, duration = 0.27) => {
          if (context.state === 'closed') return;
          const start = context.currentTime;
          mic.frequency.setValueAtTime(hz, start);
          gain.gain.cancelScheduledValues(start);
          gain.gain.setValueAtTime(amp, start);
          gain.gain.setValueAtTime(0, start + duration);
        };
        return output.stream;
      };
      const originalStart = AudioBufferSourceNode.prototype.start;
      window.playedAnswers = 0;
      window.drainedAnswers = 0;
      window.followupPauseMs = 0;
      AudioBufferSourceNode.prototype.start = function (...args) {
        if (this.buffer?.getChannelData(0).some(sample => sample !== 0)) {
          const answer = ++window.playedAnswers;
          if (answer === 3) {
            // The question is already inaudible, but the original PCM buffer wouldn't end until 1.4 seconds.
            setTimeout(() => window.speakTestMic(0.16, 733, 0.3), 650);
          }
          this.addEventListener('ended', () => {
            window.drainedAnswers++;
            if (answer === 4) window.speakTestMic(0.13, 913, 0.22);
          }, {once:true});
        } else if (this.buffer && window.playedAnswers === 3) {
          window.followupPauseMs += this.buffer.duration * 1_000;
        }
        return originalStart.apply(this, args);
      };
    });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await expect(page.getByText('로컬 서버 연결됨')).toBeVisible();
    await page.getByRole('button', {name:'설정',exact:true}).click();
    await page.getByRole('combobox', {name:'AI 목소리'}).selectOption('noeul');
    await page.getByRole('button', {name:'Sitenote 홈'}).click();
    await page.getByLabel('회의 제목', {exact: true}).fill(title);
    await page.getByLabel('회의 프로젝트').fill('새 현장');
    await page.getByRole('button', {name: '회의 시작'}).click();
    await expect(page.getByTestId('transcript-turn').first()).toContainText(firstTurn);
    await expect(page.getByTestId('voice-meter')).toHaveAttribute('data-signal', 'audible');
    await expect(page.getByTestId('ai-panel')).toContainText('대기 중');
    expect(meetingFrames).toBeGreaterThan(0);
    expect(followupSessions).toBe(0);
    expect(questionSessions).toBe(0);
    await page.getByRole('button', {name: 'AI에게 질문'}).click();
    await expect(page.getByTestId('ai-panel')).toContainText('질문 듣는 중');
    await page.evaluate(() => window.speakTestMic(0.1));
    await expect(page.getByTestId('transcript-turn').filter({hasText: questionPrefix})).toBeVisible();
    await expect(page.getByTestId('ai-panel')).toContainText('질문 듣는 중');
    expect(liveConnections).toBe(0);
    expect(forwardedQuestions).toEqual([]);
    expect(await page.evaluate(() => window.playedAnswers)).toBe(0);
    releaseFirstEndpoint();
    await expect(page.getByTestId('ai-panel')).toContainText('답변 재생 중');
    await expect(page.getByTestId('ai-panel')).toHaveAttribute('data-signal', 'audible');
    await expect(page.getByTestId('transcript-turn').filter({hasText: aiReply})).toContainText('질의응답');
    await expect.poll(() => page.evaluate(() => window.playedAnswers)).toBe(1);
    const deliverLateUtterance = rememberLateUtterance();
    await page.evaluate(() => window.speakTestMic(0.4));
    await expect.poll(() => page.evaluate(() => window.drainedAnswers)).toBe(1);
    await expect(page.getByTestId('ai-panel')).toContainText('질문 듣는 중');
    await expect(page.getByTestId('transcript-turn').filter({hasText: secondAiReply})).toHaveCount(0);
    expect(forwardedQuestions).toEqual([questions[0]]);
    expect(playbackSpeechFrames).toBe(0);
    await expect(page.getByTestId('transcript-turn').filter({hasText: playbackSpeech})).toHaveCount(0);
    deliverLateUtterance();
    await expect(page.getByTestId('transcript-turn').filter({hasText:latePlaybackSpeech})).toBeVisible();
    expect(forwardedQuestions).toEqual([questions[0]]);
    await page.evaluate(() => window.speakTestMic(0.23));
    await expect(page.getByTestId('transcript-turn').filter({hasText:secondAiReply})).toContainText('질의응답');
    await expect.poll(() => page.evaluate(() => window.playedAnswers)).toBe(2);
    expect(forwardedQuestions).toEqual(questions);
    expect(questionAudioInput.length).toBeGreaterThan(0);
    expect(questionAudioInput.every(raw => Buffer.from(raw,'base64').every(byte => byte === 0))).toBe(true);
    for (const question of questions) {
      const source = page.getByTestId('transcript-turn').filter({hasText: question});
      await expect(source).toHaveCount(1);
      await expect(source).toContainText('화자 1');
    }
    expect(questionSessions).toBe(2);
    expect(followupSessions).toBe(0);
    await page.getByRole('button', {name: 'AI 질문 닫기'}).click();
    await expect(page.getByTestId('voice-status')).toContainText('회의 전사 중');
    await page.getByRole('button', {name: '녹음 종료'}).click();
    await expect(page.getByRole('heading', {level: 1, name: title})).toBeVisible();
    await expect(page.getByTestId('transcript-turn').filter({hasText: lastTurn})).toContainText('화자 2');
    for (const [index, text] of otherClosingTurns.entries()) {
      await expect(page.getByTestId('transcript-turn').filter({hasText:text})).toContainText(`화자 ${index + 3}`);
    }
    expect(meetingFlushed).toBe(true);
    await expect(page.getByRole('heading', {name: 'AI 보충 질문을 시작할까요?'})).toBeVisible();
    expect(followupSessions).toBe(0);
    await expect.poll(() => page.evaluate(() => window.consentAudit.ended)).toBe(true);
    expect(await page.evaluate(() => window.consentAudit)).toMatchObject({
      micStartedBeforePrompt:true, socketStartedBeforePrompt:true, readyBeforePrompt:true, nonzeroBeforeEnd:0,
    });
    await expect(page.getByTestId('soniox-status')).toContainText('Soniox 답변 전사 중');
    expect(sonioxConnections).toBe(3);
    expect(consentFrames).toBeGreaterThanOrEqual(4);
    expect(consentPromptEcho).toBe(0);
    await expect(page.getByTestId('transcript-turn').filter({hasText: followupQuestion})).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.playedAnswers)).toBeGreaterThanOrEqual(3);
    await expect(page.getByTestId('transcript-turn').filter({hasText: followupAnswer})).toContainText('화자 1');
    expect(answerFrames).toBeGreaterThanOrEqual(2);
    expect(await page.evaluate(() => window.followupPauseMs)).toBeCloseTo(60, 1);
    releaseSummary();
    await expect(page.getByTestId('transcript-turn').filter({hasText:nextFollowupQuestion})).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.playedAnswers)).toBe(4);
    expect(judgedComplete).toBe(true);
    await expect(page.getByTestId('transcript-turn').filter({hasText: followupSecondSpeaker})).toContainText('화자 2');
    await expect(page.getByText(redundantGptTranscript)).toHaveCount(0);
    await expect(page.getByTestId('transcript-turn').filter({hasText:/^예$/})).toHaveCount(0);
    await page.getByRole('button', {name: '녹음 종료'}).click();
    await expect(page.getByRole('heading', {name: summaryTitle})).toBeVisible();
    await expect(page.getByTestId('transcript-turn').filter({hasText: followupAnswer})).toContainText('화자 1');
    await expect(page.getByTestId('transcript-turn').filter({hasText: followupTail})).toContainText('화자 2');
    await expect(page.getByRole('heading', {name: 'AI 보충 질문을 시작할까요?'})).toHaveCount(0);
    expect(followupFinalized).toBe(true);
    expect(followupSonioxFinalized).toBe(true);
    await page.getByRole('button', {name: 'Sitenote 홈'}).click();
    await expect(page.getByTestId('record-item')).toContainText(title);
    const remove = page.getByTestId('record-delete');
    page.once('dialog', dialog => dialog.dismiss());
    await remove.click();
    await expect(page.getByTestId('record-item')).toContainText(title);
    page.once('dialog', dialog => dialog.accept());
    await remove.click();
    await expect(page.getByTestId('record-item')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('record-item')).toHaveCount(0);
  } finally {
    releaseSummary();
    await page.close();
    await new Promise(done => server.close(done));
  }
});

for (const {width,height,mode,longTitle} of [{width:1280,height:720,mode:'회의'}, {width:375,height:667,mode:'회의'},
  {width:375,height:667,mode:'개인 대화'}, {width:500,height:460,mode:'회의',longTitle:true}]) {
  test(`${mode} keeps independent transcription controls and latest text in view at ${width}`, async ({page}) => {
    let emit;
    const server = createApp({
      webRoot:process.env.SITENOTE_WEB_TEST_ROOT || fileURLToPath(new URL('../../dist/web', import.meta.url)),
      accessToken:'fixture-access-token-not-a-real-key', sonioxKey:'fixture-soniox',
      upstream:() => fakeSocket((_data, reply) => { emit = reply; }),
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      await page.setViewportSize({width,height});
      await page.goto('http://127.0.0.1:' + server.address().port);
      const title = longTitle ? '회의 제목과 안건을 길게 입력하는 경우 '.repeat(5).trim() : '스크롤 테스트';
      await page.getByLabel(`${mode} 제목`, {exact:true}).fill(title);
      await page.getByRole('button', {name:`${mode} 시작`}).click();
      await expect(page.getByTestId('voice-status')).toContainText(`${mode} 전사 중`);
      const controls = page.getByRole('button', {name:'녹음 종료'});
      const prefix = mode === '회의' ? '회의' : '전사';
      const pause = page.getByRole('button', {name:`${prefix}중지`, exact:true});
      await expect(pause).toBeInViewport({ratio:1});
      await pause.click();
      await expect(page.getByTestId('voice-status')).toContainText(`${mode} 전사 일시정지`);
      const muteMic = page.getByRole('button', {name:'마이크 중지', exact:true});
      await muteMic.click();
      const resumeTranscription = page.getByRole('button', {name:`${prefix}재개`, exact:true});
      await expect(resumeTranscription).toBeEnabled();
      await expect(resumeTranscription).toBeInViewport({ratio:1});
      await page.getByRole('button', {name:'마이크 재개', exact:true}).click();
      await expect(page.getByTestId('voice-status')).toContainText(`${mode} 전사 일시정지`);
      await resumeTranscription.click();
      await expect(page.getByTestId('voice-status')).toContainText(`${mode} 전사 중`);
      await page.evaluate(() => document.fonts.ready);
      const initial = await controls.boundingBox();
      for (let i = 0; i < 32; i++) emit({tokens:[sonioxTurn('발언 ' + i, '1', i * 100), endpoint]});
      await expect(page.getByTestId('transcript-turn').last()).toContainText('발언 31');
      const region = page.getByRole('region', {name:'실시간 원문'});
      await expect(region).toBeInViewport();
      await expect.poll(() => region.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
      emit({tokens:[{...sonioxTurn('아직 말하는 중 '.repeat(80), '2', 3300), is_final:false}]});
      await expect(region.locator('.partial p')).toContainText('아직 말하는 중');
      await expect.poll(() => region.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
      expect((await controls.boundingBox()).y).toBeCloseTo(initial.y, 0);
      await expect(controls).toBeInViewport({ratio:1});
      expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
      await new Promise(resolve => server.close(resolve));
    }
  });
}

test('spoken 아니오 dismisses the invitation without opening an AI session or recording the choice', async ({page}) => {
  let connections = 0;
  let emitChoice;
  let aiSessions = 0;
  const original = '회의 원문 그대로 보존';
  const server = createApp({
    webRoot:process.env.SITENOTE_WEB_TEST_ROOT || fileURLToPath(new URL('../../dist/web', import.meta.url)),
    accessToken:'fixture-access-token-not-a-real-key', sonioxKey:'fixture-soniox', openaiKey:'fixture-ai',
    planQuestion: ordinaryQuestionPlan,
    transport:async () => Response.json({status:'completed',output:[{type:'message',content:[
      {type:'output_text',text:JSON.stringify({markdown:'회의 요약',questions:[]})},
    ]}]}),
    upstream(url) {
      if (new URL(url).hostname !== 'stt-rt.soniox.com') aiSessions++;
      const meeting = ++connections === 1;
      let sent = false;
      return fakeSocket((data,reply) => {
        if (data === '') return reply({finished:true});
        if (!Buffer.isBuffer(data) || sent) return;
        sent = true;
        if (meeting) reply({tokens:[sonioxTurn(original,'1',0),endpoint]});
        else emitChoice = () => reply({tokens:[sonioxTurn('아니오.','1',0),endpoint]});
      });
    },
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  try {
    await page.addInitScript(() => {
      window.speechSynthesis.speak = utterance => queueMicrotask(() => utterance.dispatchEvent(new Event('end')));
    });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.getByLabel('회의 제목',{exact:true}).fill('거절 테스트');
    await page.getByRole('button',{name:'회의 시작'}).click();
    await expect(page.getByTestId('transcript-turn')).toContainText(original);
    await page.getByRole('button',{name:'녹음 종료'}).click();
    await expect(page.getByTestId('voice-consent-status')).toHaveAttribute('data-state','listening');
    await expect.poll(() => Boolean(emitChoice)).toBe(true);
    emitChoice();
    await expect(page.getByTestId('voice-consent-status')).toHaveCount(0);
    await expect(page.getByTestId('transcript-turn')).toHaveCount(1);
    await expect(page.getByTestId('transcript-turn')).toContainText(original);
    await expect(page.getByRole('button',{name:'보충 질문하기'})).toBeVisible();
    expect(aiSessions).toBe(0);
    expect(connections).toBe(2);
  } finally {
    await page.close();
    await new Promise(done => server.close(done));
  }
});
