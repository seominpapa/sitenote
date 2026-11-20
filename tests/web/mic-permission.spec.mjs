import { expect, test } from '@playwright/test';
import { EventEmitter, once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.mjs';

test('finishing a meeting closes a pending microphone request and discards its eventual track', async ({page}) => {
  const requests = [];
  const server = createApp({
    webRoot:process.env.SITENOTE_WEB_TEST_ROOT || fileURLToPath(new URL('../../dist/web',import.meta.url)),
    accessToken:'test-only-not-a-real-access-token', sonioxKey:'test-only',
    upstream() {
      const socket = Object.assign(new EventEmitter(), {
        readyState:0, bufferedAmount:0,
        send(value) {
          if (value === '') {
            requests.push('finish');
            queueMicrotask(() => socket.emit('message', JSON.stringify({finished:true})));
          } else if (Buffer.isBuffer(value)) requests.push('audio');
        },
        close() { this.readyState = 3; this.emit('close'); },
        terminate() { this.close(); },
      });
      queueMicrotask(() => { socket.readyState = 1; socket.emit('open'); });
      return socket;
    },
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  try {
    await page.addInitScript(() => {
      window.micRequests = 0;
      window.micStops = 0;
      navigator.mediaDevices.getUserMedia = () => new Promise(resolve => {
        window.micRequests++;
        window.grantMic = () => resolve({getTracks:() => [{stop:() => window.micStops++}]});
      });
    });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.getByLabel('회의 제목', {exact:true}).fill('권한 요청 중 종료');
    await page.getByRole('button',{name:'회의 시작'}).click();
    await expect.poll(() => page.evaluate(() => window.micRequests)).toBe(1);
    await page.getByRole('button',{name:'녹음 종료'}).click();
    await expect(page.getByRole('button',{name:'녹음 종료'})).toHaveCount(0, {timeout:3_000});
    expect(requests).toEqual(['finish']);
    await page.evaluate(() => window.grantMic());
    await expect.poll(() => page.evaluate(() => window.micStops)).toBe(1);
    expect(requests).toEqual(['finish']);
  } finally {
    await page.close();
    await new Promise(done => server.close(done));
  }
});
