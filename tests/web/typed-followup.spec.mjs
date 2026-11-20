import { expect, test } from '@playwright/test';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.mjs';
import { summaryMarkdown, transcriptMarkdown } from '../../src/records/markdown.ts';
import { createRecord, applyTurn } from '../../src/records/model.ts';

const record = applyTurn(createRecord({id:'typed-note', kind:'meeting', title:'현장 점검 회의'}), {
  id:'original', section:'meeting', role:'speaker', text:'서편 출입구 정리 일정이 아직 남았습니다.', timeMs:13, speakerId:'1',
});

async function withPage(page, config, run, {cached = []} = {}) {
  const server = createApp({
    webRoot:process.env.SITENOTE_WEB_TEST_ROOT || fileURLToPath(new URL('../../dist/web', import.meta.url)),
    accessToken:'typed-test-application-fixture-key', ...config,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await page.addInitScript(() => {
      window.microphoneCalls = 0;
      navigator.mediaDevices.getUserMedia = async () => { window.microphoneCalls += 1; throw Error('Unexpected microphone'); };
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(url);
    await page.evaluate(({id, markdown, summary}) => new Promise((resolve, reject) => {
      const request = indexedDB.open('sitenote', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('markdown', {keyPath:'id'});
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('markdown', 'readwrite');
        tx.objectStore('markdown').put({id, 'transcript.md':markdown, ...(summary && {'summary.md':summary})});
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    }), {id:record.id, markdown:transcriptMarkdown(record), summary:cached.length ? summaryMarkdown('회의 요약 초안', cached) : undefined});
    await page.reload();
    await page.getByTestId('record-item').filter({hasText:record.title}).click();
    await run();
  } finally {
    await page.close();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
}

test('writes an AI supplemental answer before judging, preserves it through retry and reloads without a microphone', async ({page}) => {
  await withPage(page, {openaiKey:'test-openai'}, async () => {
    const calls = [];
    await page.route('**/followup', async route => {
      const body = route.request().postDataJSON();
      calls.push(body);
      if (body.action === 'question') return route.fulfill({json:{question:'서편 출입구 정리는 누가 맡았나요?'}});
      if (calls.length === 2) return route.fulfill({status:502, json:{error:'AI 확인이 잠시 실패했습니다.'}});
      return route.fulfill({json:{verdict:'complete'}});
    });
    await page.getByRole('button', {name:'글로 보충하기', exact:true}).click();
    await page.getByRole('button', {name:'AI 질문 받기', exact:true}).click();
    await expect(page.getByRole('region', {name:'글로 보충하기'})).toContainText('서편 출입구 정리는 누가 맡았나요?');
    await page.getByLabel('AI 질문에 대한 답변').fill('안전팀 박 대리가 담당합니다.');
    await page.getByRole('button', {name:'답변 저장', exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('저장');
    await page.getByRole('button', {name:'답변 확인 다시 시도', exact:true}).click();
    await expect(page.getByRole('region', {name:'글로 보충하기'})).toContainText('AI 보충 질문을 마쳤습니다.');
    expect(calls[0].context).toContain(record.turns[0].text);
    expect(calls[2]).toEqual(calls[1]);
    expect(await page.evaluate(() => window.microphoneCalls)).toBe(0);
    await page.reload();
    await page.getByTestId('record-item').filter({hasText:record.title}).click();
    await expect(page.getByText('서편 출입구 정리는 누가 맡았나요?', {exact:true})).toHaveCount(1);
    await expect(page.getByText('안전팀 박 대리가 담당합니다.', {exact:true})).toHaveCount(1);
  });
});

test('writes a manual question and answer with no AI key, no AI requests or microphone', async ({page}) => {
  await withPage(page, {}, async () => {
    const calls = [];
    page.on('request', request => { if (/\/(answer|followup|summary)$/.test(request.url())) calls.push(request.url()); });
    await page.getByRole('button', {name:'글로 보충하기', exact:true}).click();
    await expect(page.getByRole('button', {name:'AI 질문 받기', exact:true})).toBeDisabled();
    await page.getByRole('button', {name:'직접 질문과 답변 기록', exact:true}).click();
    await page.getByLabel('직접 입력할 질문').fill('출입구 표지판은 몇 개 더 필요한가요?');
    await page.getByLabel('직접 입력할 답변').fill('두 개가 더 필요합니다.');
    await page.getByRole('button', {name:'질문과 답변 저장', exact:true}).click();
    await expect(page.getByText('직접 입력한 질문', {exact:true})).toBeVisible();
    await expect(page.getByText('직접 입력한 답변', {exact:true})).toBeVisible();
    await expect(page.getByText('두 개가 더 필요합니다.', {exact:true})).toBeVisible();
    expect(calls).toEqual([]);
    expect(await page.evaluate(() => window.microphoneCalls)).toBe(0);
  });
});

test('saved AI questions stay answerable when no provider key is available', async ({page}) => {
  const question = '현장 출입구 확인은 언제인가요?';
  await withPage(page, {}, async () => {
    const calls = [];
    await page.route('**/followup', route => { calls.push(route.request().postDataJSON()); return route.abort(); });
    await page.getByRole('button', {name:'글로 보충하기', exact:true}).click();
    await page.getByRole('button', {name:'AI 질문 받기', exact:true}).click();
    await expect(page.getByRole('region', {name:'글로 보충하기'})).toContainText(question);
    await page.getByLabel('AI 질문에 대한 답변').fill('오후 두 시에 확인합니다.');
    await page.getByRole('button', {name:'답변 저장', exact:true}).click();
    await expect(page.getByRole('region', {name:'글로 보충하기'})).toContainText('답변 확인은 건너뛰었습니다.');
    await expect(page.getByText('오후 두 시에 확인합니다.', {exact:true})).toBeVisible();
    expect(calls).toEqual([]);
    expect(await page.evaluate(() => window.microphoneCalls)).toBe(0);
  }, {cached:[question]});
});
