import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.mjs';

function wave() {
  const bytes = Buffer.alloc(44 + 4 * 24_000 * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24_000, 24); bytes.writeUInt32LE(48_000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

test('saves a chosen voice, plays its preview without the microphone, and reports preview errors', async ({ page }) => {
  const server = createApp({accessToken:randomBytes(32).toString('hex'), openaiKey:'test-key',
    webRoot:process.env.SITENOTE_WEB_TEST_ROOT || fileURLToPath(new URL('../../dist/web', import.meta.url))}).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    await page.addInitScript(() => {
      window.previewMicrophoneRequests = 0;
      navigator.mediaDevices.getUserMedia = async () => { window.previewMicrophoneRequests++; throw Error('No microphone'); };
    });
    const requests = [];
    await page.route('**/v1/voice-preview', async route => {
      expect(route.request().method()).toBe('POST');
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) await route.fulfill({contentType:'audio/wav', body:wave()});
      else await route.fulfill({status:502, json:{error:'미리듣기 연결에 실패했습니다.'}});
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const settings = page.getByRole('button', {name:'설정', exact:true});
    const voice = page.getByRole('combobox', {name:'AI 목소리'});
    const play = page.getByRole('button', {name:'짧게 들어보기', exact:true});
    await settings.click();
    await expect(voice).toHaveValue('marin');
    await voice.selectOption('noeul');
    await page.reload();
    await settings.click();
    await expect(voice).toHaveValue('noeul');
    await expect(requests).toEqual([]);
    await play.click();
    await expect(page.getByText('미리듣기 재생 중')).toBeVisible();
    await page.getByRole('button', {name:'미리듣기 중지'}).click();
    await expect(play).toBeEnabled();
    expect(requests).toEqual([{voice:'noeul'}]);
    expect(await page.evaluate(() => window.previewMicrophoneRequests)).toBe(0);
    await play.click();
    await expect(page.getByRole('alert')).toHaveText('미리듣기 연결에 실패했습니다.');
    await expect(play).toBeEnabled();
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
