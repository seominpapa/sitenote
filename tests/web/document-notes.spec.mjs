import { expect, test } from '@playwright/test';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.mjs';

const id = 'cd2d9a50-6f4e-4376-b412-b2d8bef751cb';
const filename = '안전 점검 회의.docx';
const line = '비상 대피 집결지는 동쪽 출입구로 확정했습니다.';

test('imports a local document, cites its note and reveals the original', async ({page}) => {
  const question = '비상 대피 집결지 어디인가요?';
  const mockKey = globalThis.crypto.randomUUID();
  let aiInput;
  const server = createApp({
    accessToken:globalThis.crypto.randomUUID(),
    webRoot: process.env.SITENOTE_WEB_TEST_ROOT || fileURLToPath(new URL('../../dist/web', import.meta.url)),
    openaiKey:mockKey,
    transport: async (_url, request) => {
      aiInput = JSON.parse(request.body);
      return Response.json({status:'completed',output:[{type:'message',content:[
        {type:'output_text',text:`동쪽 출입구입니다. [record:${id}#import-1]`},
      ]}]});
    },
  }).listen(0,'127.0.0.1');
  try {
    await once(server,'listening');
    await page.addInitScript(({id, filename, line}) => {
      window.calls = {saved:[], chosen:[], synced:[], revealed:[]};
      window.sitenoteNoteFiles = {
        status:async () => ({folder:'/library', root:'/library/Sitenote'}),
        chooseFolder:async entries => {
          calls.chosen.push(entries);
          return {folder:'/new', root:'/new/Sitenote'};
        },
        sync:async entries => { calls.synced.push(entries); },
        pickDocument:async () => ({id, filename, markdown:'# 결정 사항\n' + line}),
        saveImport:async entry => { calls.saved.push(entry); },
        revealOriginal:async noteId => { calls.revealed.push(noteId); return true; },
      };
    }, {id, filename, line});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button',{name:'노트 추가',exact:true}).click();
    await page.getByRole('textbox',{name:'프로젝트 (선택)'}).fill('한강');
    await page.getByRole('button',{name:'파일 선택'}).click();
    await expect(page.getByTestId('record-item').filter({hasText:'안전 점검 회의'})).toBeVisible();
    const [saved] = await page.evaluate(() => calls.saved);
    expect(saved.id).toBe(id);
    expect(saved['transcript.md']).toContain(line);

    await page.getByRole('button',{name:'설정',exact:true}).click();
    await expect(page.getByText('/library/Sitenote',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'저장 폴더 변경'}).click();
    await expect(page.getByText('/new/Sitenote',{exact:true})).toBeVisible();
    expect(await page.evaluate(() => calls.chosen[0].map(entry => entry.id))).toEqual([id]);

    await page.reload();
    await page.getByRole('button',{name:'검색',exact:true}).click();
    await page.getByRole('textbox',{name:'기록 검색'}).fill(question);
    await page.getByRole('button',{name:'검색 실행'}).click();
    await page.getByRole('button',{name:'이 기록에 AI로 질문'}).click();
    const answer = page.getByRole('heading',{name:'AI 답변'}).locator('..');
    await expect(answer.getByText(/동쪽 출입구입니다/)).toBeVisible();
    expect(JSON.stringify(aiInput)).toContain(line);
    await answer.getByRole('link',{name:/안전 점검 회의/}).click();
    await expect(page.getByTestId('transcript-turn').filter({hasText:line})).toBeFocused();
    await page.getByRole('button',{name:'원본 파일 위치 열기'}).click();
    expect(await page.evaluate(() => calls.revealed)).toEqual([id]);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
