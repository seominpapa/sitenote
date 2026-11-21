import { expect, test } from '@playwright/test';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.mjs';

const id = 'cd2d9a50-6f4e-4376-b412-b2d8bef751cb';
const filename = '안전 점검 회의.docx';
const line = '비상 대피 집결지는 동쪽 출입구로 확정했습니다.';
const webRoot = process.env.SITENOTE_WEB_TEST_ROOT || fileURLToPath(new URL('../../dist/web', import.meta.url));

test('imports a local document, cites its note and reveals the original', async ({page}) => {
  const question = '비상 대피 집결지 어디인가요?';
  const mockKey = globalThis.crypto.randomUUID();
  let aiInput;
  const server = createApp({
    accessToken:globalThis.crypto.randomUUID(),
    webRoot,
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
    expect(saved.folderName).toMatch(/^\d{8}_안전 점검 회의$/u);
    expect(saved['transcript.md']).toBe('# 결정 사항\n' + line);
    expect(saved.imported).toBe(true);

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
    const [download] = await Promise.all([
      page.waitForEvent('download'), page.getByRole('button',{name:'Markdown 내보내기'}).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^\d{8}_안전 점검 회의\.md$/u);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('shows an accessible scan PDF alert without adding a note', async ({page}) => {
  const alert = '스캔 PDF는 지원하지 않습니다. 텍스트를 선택할 수 있는 PDF를 추가해 주세요.';
  const server = createApp({accessToken:globalThis.crypto.randomUUID(), webRoot}).listen(0,'127.0.0.1');
  try {
    await once(server,'listening');
    await page.addInitScript(message => {
      window.savedDocuments = 0;
      window.sitenoteNoteFiles = {
        status:async () => ({folder:'/library', root:'/library/Sitenote'}),
        sync:async () => {},
        pickDocument:async () => { throw Error(message); },
        saveImport:async () => { window.savedDocuments++; },
      };
    }, alert);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button',{name:'노트 추가',exact:true}).click();
    await page.getByRole('button',{name:'파일 선택'}).click();
    await expect(page.getByRole('alert')).toHaveText(alert);
    await expect(page.getByTestId('record-item')).toHaveCount(0);
    expect(await page.evaluate(() => window.savedDocuments)).toBe(0);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
