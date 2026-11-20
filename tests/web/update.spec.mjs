import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.mjs';

test('asks at launch, downloads only on consent, and checks again in settings', async ({ page }) => {
  const server = createApp({accessToken:randomBytes(32).toString('hex'), webRoot:process.env.SITENOTE_WEB_TEST_ROOT ||
    fileURLToPath(new URL('../../dist/web', import.meta.url))}).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    await page.addInitScript(() => {
      let checks = 0, downloads = 0, opens = 0;
      const candidate = {currentVersion:'0.1.1', version:'0.1.2', assetName:'Sitenote-Windows-x64.exe', size:10};
      window.sitenoteDesktop = {
        version:async () => candidate.currentVersion,
        check:async () => { checks++; return {...candidate, status:'available'}; },
        download:async () => { downloads++; return {...candidate, status:'downloaded'}; },
        open:async () => { opens++; return true; },
      };
      window.updateEvidence = () => ({checks, downloads, opens});
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await expect(page.getByRole('heading', {name:'새 버전이 있습니다. 업데이트할까요?'})).toBeVisible();
    await page.getByRole('button', {name:'나중에'}).click();
    await expect(page.getByRole('button', {name:'업데이트 다운로드'})).toBeHidden();
    expect(await page.evaluate(() => window.updateEvidence())).toEqual({checks:1, downloads:0, opens:0});
    await page.getByRole('button', {name:'설정', exact:true}).click();
    await expect(page.getByRole('heading', {name:'설정', exact:true})).toHaveCount(0);
    await page.getByRole('button', {name:'업데이트 확인', exact:true}).click();
    await page.getByRole('button', {name:'업데이트 다운로드'}).click();
    await expect(page.getByText(/다운로드와 파일 검증을 마쳤습니다/)).toBeVisible();
    expect(await page.evaluate(() => window.updateEvidence())).toEqual({checks:2, downloads:1, opens:0});
    await page.getByRole('button', {name:'EXE 파일 위치 열기'}).click();
    await expect.poll(() => page.evaluate(() => window.updateEvidence().opens)).toBe(1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
