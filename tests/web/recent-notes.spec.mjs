import { expect, test } from '@playwright/test';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.mjs';
import { transcriptMarkdown } from '../../src/records/markdown.ts';
import { createRecord } from '../../src/records/model.ts';

const title = day => `현장 기록 ${String(day).padStart(2, '0')}`;
const id = day => `note-${String(day).padStart(2, '0')}`;
const days = (last, first) => Array.from({length:last - first + 1}, (_, index) => last - index);
const entries = days(23, 1).map(day => ({id:id(day), 'transcript.md':transcriptMarkdown(createRecord({
  id:id(day), title:title(day), kind:'personal', now:`2026-10-${String(day).padStart(2, '0')}T08:00:00.000Z`,
}))}));

function library(page, records) {
  return page.evaluate(seed => new Promise((resolve, reject) => {
    const open = indexedDB.open('sitenote', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('markdown', {keyPath:'id'});
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('markdown', seed ? 'readwrite' : 'readonly');
      const store = tx.objectStore('markdown');
      for (const item of seed ?? []) store.put(item);
      const keys = store.getAllKeys();
      tx.oncomplete = () => { db.close(); resolve(keys.result); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), records);
}

test('recent notes paginate, retain selections, and delete only a confirmed batch', async ({page}) => {
  const server = createApp({
    webRoot:process.env.SITENOTE_WEB_TEST_ROOT || fileURLToPath(new URL('../../dist/web', import.meta.url)),
    accessToken:'isolated-recent-notes-fixture-token',
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const deleteFour = page.getByRole('button', {name:'선택 삭제 (4개)', exact:true});
    const pageAll = page.getByRole('checkbox', {name:'이 페이지 전체 선택', exact:true});
    const globalAll = page.getByRole('button', {name:'모든 기록 선택', exact:true});
    const count = page.getByTestId('record-selection-count');
    const status = page.getByTestId('record-page-status');
    const prev = page.getByRole('button', {name:'이전 페이지'});
    const next = page.getByRole('button', {name:'다음 페이지'});
    const rows = page.getByTestId('record-item');
    const visibleTitles = rows.locator('strong');
    const rowBox = day => page.getByRole('checkbox', {name:`${title(day)} 선택`, exact:true});
    const draft = page.getByLabel('개인 대화 제목', {exact:true});
    const expectPage = async (current, total, displayed) => {
      await expect(visibleTitles).toHaveText(displayed.map(title));
      await expect(status).toHaveText(`페이지 ${current} / ${total}`);
    };
    const confirm = async (button, accept, amount) => {
      const opening = page.waitForEvent('dialog');
      const click = button.click();
      const dialog = await opening;
      const message = dialog.message();
      if (accept) await dialog.accept();
      else await dialog.dismiss();
      await click;
      expect(message).toContain(`${amount}개`);
    };

    await page.goto('http://127.0.0.1:' + server.address().port);
    await library(page, entries);
    await page.reload();
    await expectPage(1, 3, days(23, 14));
    await expect(prev).toBeDisabled();
    await draft.fill('아직 작성 중인 제목');
    await rowBox(23).check();
    await expect(pageAll).toHaveAttribute('aria-checked', 'mixed');
    await next.click();
    await expectPage(2, 3, days(13, 4));
    await expect(draft).toHaveValue('아직 작성 중인 제목');
    await expect(count).toHaveText('1개 선택됨');
    await expect(rowBox(13)).not.toBeChecked();
    await prev.click();
    await expect(rowBox(23)).toBeChecked();
    await next.click();
    await next.click();
    await expectPage(3, 3, days(3, 1));
    await expect(next).toBeDisabled();
    await pageAll.check();
    await expect(count).toHaveText('4개 선택됨');
    await expect(pageAll).toBeChecked();
    await expect(globalAll).toBeEnabled();
    for (const day of days(3, 1)) await expect(rowBox(day)).toBeChecked();
    await pageAll.uncheck();
    await expect(count).toHaveText('1개 선택됨');
    await pageAll.check();

    await confirm(deleteFour, false, 4);
    await expect(count).toHaveText('4개 선택됨');
    expect(await library(page)).toEqual(entries.map(item => item.id).sort());

    await page.evaluate(() => {
      const store = IDBObjectStore.prototype;
      const remove = store.delete;
      let attempts = 0;
      store.delete = function (key) {
        if (this.name === 'markdown' && ++attempts === 2) {
          store.delete = remove;
          throw new Error('fixture: second delete refused');
        }
        return remove.call(this, key);
      };
    });
    await confirm(deleteFour, true, 4);
    await expect(page.getByText('기록을 삭제하지 못했습니다. 선택한 기록은 그대로 남아 있습니다.', {exact:true})).toBeVisible();
    await expect(count).toHaveText('4개 선택됨');
    await expect(pageAll).toBeChecked();
    expect(await library(page)).toEqual(entries.map(item => item.id).sort());

    await confirm(deleteFour, true, 4);
    await expectPage(2, 2, days(12, 4));
    await expect(next).toBeDisabled();
    await expect(draft).toHaveValue('아직 작성 중인 제목');
    await page.reload();
    await expect(page.getByRole('heading', {name:/최근 노트\s*19/})).toBeVisible();
    expect(await library(page)).toEqual(days(22, 4).map(id).sort());
    await page.setViewportSize({width:390, height:844});
    await globalAll.click();
    await expect(count).toHaveText('19개 선택됨');
    await expect(globalAll).toBeDisabled();
    if (await next.isEnabled()) {
      await next.click();
      await expect(rowBox(4)).toBeChecked();
    } else {
      await prev.click();
      await expect(rowBox(22)).toBeChecked();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await confirm(page.getByRole('button', {name:'선택 삭제 (19개)', exact:true}), true, 19);
    await expect(page.getByText('아직 기록이 없어요')).toBeVisible();
    await expect(status).toHaveCount(0);
    await page.reload();
    await expect(page.getByText('아직 기록이 없어요')).toBeVisible();
    expect(await library(page)).toEqual([]);
  } finally {
    await page.close();
    await new Promise(done => server.close(done));
  }
});
