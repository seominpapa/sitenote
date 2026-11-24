import {expect, test} from '@playwright/test';
import {EventEmitter, once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createApp} from '../../server/app.mjs';

const title = '시간별 음성 재생 시험';
const first = '첫 발언을 전사합니다.';
const second = '두 번째 발언의 음성만 재생합니다.';
const frameSamples = 480;

function tone(frame, hz) {
  let sine = 0, cosine = 0, energy = 0;
  for (let i = 0; i < frameSamples; i++) {
    const value = frame.readInt16LE(i * 2);
    const phase = 2 * Math.PI * hz * i / 24_000;
    sine += value * Math.sin(phase);
    cosine += value * Math.cos(phase);
    energy += value * value;
  }
  return energy > frameSamples * 200 ** 2 && 2 * (sine * sine + cosine * cosine) > 0.8 * frameSamples * energy;
}

test('the compact meeting audio option is off by default and explains correction on demand', async ({page}) => {
  const server = createApp({
    webRoot:process.env.SITENOTE_WEB_TEST_ROOT || fileURLToPath(new URL('../../dist/web', import.meta.url)),
    accessToken:'local-test-audio-help-no-credentials',
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  try {
    await page.setViewportSize({width:1280,height:850});
    await page.goto('http://127.0.0.1:' + server.address().port);
    const opt = page.getByRole('checkbox',{name:/원본 음성 보관/});
    const help = page.getByRole('button',{name:'원본 음성 보관 안내'});
    await expect(opt).not.toBeChecked();
    await expect(help).toBeVisible();

    const box = await opt.boundingBox();
    const trigger = await help.boundingBox();
    const form = await opt.locator('xpath=ancestor::form').boundingBox();
    expect(box.height).toBeLessThanOrEqual(24);
    expect(Math.abs(box.y + box.height/2 - trigger.y - trigger.height/2)).toBeLessThanOrEqual(5);
    expect(Math.min(box.x,trigger.x)).toBeGreaterThan(form.x + form.width/2);
    expect(Math.abs(Math.max(box.x+box.width,trigger.x+trigger.width) - (form.x+form.width))).toBeLessThanOrEqual(16);

    const correction = page.getByText(/다시 듣고 올바른 화자로 옮길/);
    await expect(correction).not.toBeVisible();
    await help.focus();
    await help.press('Enter');
    await expect(correction).toBeVisible();
    await expect(help).toHaveAttribute('aria-expanded','true');
    await expect(opt).not.toBeChecked();
    await help.click();
    await expect(correction).not.toBeVisible();
    await expect(help).toHaveAttribute('aria-expanded','false');
    await expect(opt).not.toBeChecked();
  } finally {
    await page.close();
    await new Promise(done => server.close(done));
  }
});

test('opted-in meetings replay the exact saved microphone samples at a later utterance after reload', async ({page}) => {
  let selectedPcm;
  const server = createApp({
    webRoot:process.env.SITENOTE_WEB_TEST_ROOT || fileURLToPath(new URL('../../dist/web', import.meta.url)),
    accessToken:'local-test-archive-token-no-credentials', sonioxKey:'local-test-key',
    upstream() {
      let frames = 0, initial = 0, later = 0;
      const deliver = data => queueMicrotask(() => socket.emit('message', JSON.stringify(data)));
      const announce = (text, speaker, at) => deliver({tokens:[{text,speaker,is_final:true,start_ms:at,end_ms:at+20}]});
      const socket = Object.assign(new EventEmitter(), {
        readyState:0, bufferedAmount:0,
        send(data) {
          if (Buffer.isBuffer(data) && data.length === 960) {
            const at = frames++ * 20;
            if (tone(data, 450) && ++initial === 4) announce(first, '1', at);
            if (tone(data, 850) && ++later === 4) {
              selectedPcm = Buffer.from(data);
              announce(second, '2', at);
            }
          } else if (data === '') deliver({finished:true});
        },
        close() {socket.readyState=3; socket.emit('close');},
        terminate() {socket.close();},
      });
      queueMicrotask(() => {socket.readyState=1;socket.emit('open');});
      return socket;
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await page.addInitScript(() => {
      const objectUrl = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => {
        if (blob.type === 'audio/wav') window.lastReplayClip = blob;
        return objectUrl(blob);
      };
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new AudioContext();
        await context.resume();
        const source = context.createOscillator();
        source.frequency.value = 450;
        const gain = context.createGain();
        gain.gain.value = 0.25;
        const output = context.createMediaStreamDestination();
        source.connect(gain).connect(output);
        source.start();
        window.advanceTestMic = () => {source.frequency.value = 850;};
        const track = output.stream.getAudioTracks()[0];
        const stop = track.stop.bind(track);
        track.stop = () => {stop(); source.stop(); void context.close();};
        return output.stream;
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const opt = page.getByRole('checkbox',{name:/원본 음성 보관/});
    await expect(opt).not.toBeChecked();
    await opt.check();
    await page.getByLabel('회의 제목',{exact:true}).fill(title);
    await page.getByRole('button',{name:'회의 시작'}).click();
    await expect(page.getByText(first,{exact:true})).toBeVisible();
    await page.evaluate(() => window.advanceTestMic());
    await expect(page.getByText(second,{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'녹음 종료'}).click();
    await expect(page.getByRole('heading',{name:'원문 · 2개 발언'})).toBeVisible();
    await page.reload();
    await page.getByTestId('record-item').filter({hasText:title}).click();
    const utterance = page.getByTestId('transcript-turn').filter({hasText:second});
    await utterance.getByRole('button',{name:/음성 재생/}).click();
    const player = page.locator('audio[aria-label="선택한 발언 음성"]');
    await expect.poll(() => player.evaluate(audio => audio.readyState)).toBeGreaterThan(0);
    await expect.poll(() => player.evaluate(audio => audio.currentTime)).toBeGreaterThan(0);
    const replay = await page.evaluate(async () => Array.from(new Uint8Array(await window.lastReplayClip.arrayBuffer()).slice(44,1004)));
    expect(Buffer.from(replay)).toEqual(selectedPcm);
  } finally {
    await page.close();
    await new Promise(done => server.close(done));
  }
});
