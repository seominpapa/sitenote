import { expect, test } from '@playwright/test';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.mjs';
import { transcriptMarkdown } from '../../src/records/markdown.ts';
import { applyTurn, createRecord } from '../../src/records/model.ts';

const context = '오늘 첫 순서는 방수막 관리 절차를 검토하는 것입니다.';
const raw = '다음 주에는 방수막 간리를 다시 점검합니다.';
const corrected = '다음 주에는 방수막 관리를 다시 점검합니다.';
const id = 'soniox-fixture-1';

test('transcript correction keeps the raw speech, speaker, and timestamp after reload and export', async ({page}) => {
  const previous = applyTurn(createRecord({id:'correction-fixture',kind:'meeting',title:'방수막 점검 회의',project:'한강'}), {
    id:'soniox-fixture-0', timeMs:1_000, role:'speaker', section:'meeting', speakerId:'meeting:fixture:1', text:context,
  });
  const record = applyTurn(previous, {
    id, timeMs:4_000, role:'speaker', section:'meeting', speakerId:'meeting:fixture:1', text:raw,
  });
  const providerInputs = [];
  const server = createApp({
    accessToken:'fixture-transcript-correction-not-a-real-token', openaiKey:'fixture-openai', sonioxKey:'fixture-soniox',
    webRoot:process.env.SITENOTE_WEB_TEST_ROOT || fileURLToPath(new URL('../../dist/web',import.meta.url)),
    async transport(_url, request) {
      const {input} = JSON.parse(request.body);
      providerInputs.push(JSON.parse(input));
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',
        text:JSON.stringify({corrections:[{id,text:corrected}]}),
      }]}]});
    },
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  try {
    const entry = {id:record.id, 'transcript.md':transcriptMarkdown(record)};
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(entry => new Promise((resolve,reject) => {
      const open = indexedDB.open('sitenote',1);
      open.onupgradeneeded = () => open.result.createObjectStore('markdown',{keyPath:'id'});
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('markdown','readwrite');
        tx.objectStore('markdown').put(entry);
        tx.oncomplete = () => {db.close(); resolve();};
        tx.onabort = () => {db.close(); reject(tx.error);};
      };
    }),entry);
    await page.reload();
    const note = page.getByTestId('record-item').filter({hasText:record.title});
    await note.click();
    const turn = page.getByTestId('transcript-turn').filter({hasText:'다시 점검합니다.'});
    await expect(turn.getByText(raw,{exact:true})).toBeVisible();
    await expect(page.getByText(/OpenAI에 보냅니다/)).toBeVisible();
    await page.getByRole('button',{name:'전사 보정',exact:true}).click();
    await expect(turn.getByText(corrected,{exact:true})).toBeVisible();
    await expect(turn).toContainText(/00:00:04.+AI 보정/);
    expect(providerInputs).toHaveLength(1);
    expect(JSON.stringify(providerInputs[0])).toContain(raw);
    expect(JSON.stringify(providerInputs[0])).toContain(context);
    expect(providerInputs[0]).toMatchObject({title:record.title,project:record.project});
    await page.reload();
    await note.click();
    await expect(turn.getByText(corrected,{exact:true})).toBeVisible();
    await expect(turn.getByText(raw,{exact:true})).toBeHidden();
    await turn.getByText('보정 전 원문 보기',{exact:true}).click();
    await expect(turn.getByText(raw,{exact:true})).toBeVisible();
    await expect(turn.getByText('발언자 미확인 (화자 1)',{exact:true})).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),page.getByRole('button',{name:'Markdown 내보내기'}).click(),
    ]);
    const markdown = await readFile(await download.path(),'utf8');
    expect(markdown).toContain(raw);
    expect(markdown).not.toContain(corrected);
  } finally {
    await page.close();
    await new Promise(done => server.close(done));
  }
});
