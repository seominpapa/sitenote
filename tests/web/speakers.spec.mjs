import { expect, test } from '@playwright/test';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.mjs';
import { parseSummary, parseTranscript, summaryMarkdown, transcriptMarkdown } from '../../src/records/markdown.ts';
import { createRecord } from '../../src/records/model.ts';

const title = '현장 착공 준비 회의';
const utterance = (id, speakerId, text, timeMs, section = 'meeting') => ({id, speakerId, text, timeMs, section, role:'speaker'});
const turns = [
  utterance('first','meeting:a:1','회의 시작 전 안전 점검을 부탁합니다.',1_000),
  utterance('second','meeting:a:1','현장 출입증도 가져오세요.',2_000,'meeting-ai'),
  utterance('reconnected','meeting:b:1','다른 연결로 작업 목록을 확인합니다.',3_000),
  utterance('supplement-one','followup:c:1','보충 답변으로 내일 순찰합니다.',4_000,'followup'),
  utterance('supplement-two','followup:c:1','측정기는 제가 반납합니다.',5_000,'followup'),
];

test('speaker edits update saved summaries and survive reload and export without affecting other connections', async ({page}) => {
  const server = createApp({
    webRoot:process.env.SITENOTE_WEB_TEST_ROOT || fileURLToPath(new URL('../../dist/web', import.meta.url)),
    accessToken:'local-mock-speaker-test-token-only',
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const id = 'speaker-test';
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(record => new Promise((resolve, reject) => {
      const open = indexedDB.open('sitenote', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('markdown', {keyPath:'id'});
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('markdown', 'readwrite');
        tx.objectStore('markdown').put(record);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    }), {id, 'transcript.md':transcriptMarkdown({...createRecord({id,kind:'meeting',title}), turns}),
      'summary.md':summaryMarkdown([
        '## 주요 논의',
        '- 발언자 미확인 (화자 1)이 안전 점검을 부탁했습니다. [record:speaker-test#first]',
        '- 화자 1은 출입증을 준비해 달라고 했습니다. [record:speaker-test#second]',
        '- 화자 1은 작업 목록을 확인했습니다. [record:speaker-test#reconnected]',
        '## 회의 후 추가 설명',
        '- 화자 1이 내일 순찰합니다.',
      ].join('\n'))});
    const reopen = async () => {
      await page.reload();
      await page.getByTestId('record-item').filter({hasText:title}).click();
    };
    await reopen();
    const controls = page.locator('details').filter({hasText:'화자 이름 관리'});
    await controls.getByText('화자 이름 관리 · 3개 그룹', {exact:true}).click();
    await expect(controls.getByRole('textbox')).toHaveCount(3);
    const rename = async (area, label, name) => {
      const group = controls.locator('section').filter({has:page.getByRole('heading', {name:area,exact:true})});
      const input = group.getByRole('textbox', {name:label});
      await input.fill(name);
      await input.locator('xpath=ancestor::form').getByRole('button', {name:'화자 이름 저장'}).click();
    };
    const source = id => page.locator(`#${id}[data-testid=transcript-turn]`);
    await rename('회의 원문', /구분 1/, '김 담당');
    await expect(source('first')).toContainText('김 담당 (화자 1)');
    await expect(source('second')).toContainText('김 담당 (화자 1)');
    await expect(source('reconnected')).toContainText('발언자 미확인 (화자 1)');
    const summary = page.locator('#summary');
    await expect(summary).toContainText('김 담당이 안전 점검을 부탁했습니다.');
    await expect(summary).toContainText('김 담당은 출입증을 준비해 달라고 했습니다.');
    await expect(summary).toContainText('화자 1은 작업 목록을 확인했습니다.');
    await rename('회의 후 보충 대화', /화자 1/, '이 참가자');
    await expect(source('supplement-one')).toContainText('이 참가자 (화자 1)');
    await expect(source('supplement-two')).toContainText('이 참가자 (화자 1)');
    await reopen();
    await expect(source('first')).toContainText('김 담당 (화자 1)');
    await expect(source('supplement-two')).toContainText('이 참가자 (화자 1)');
    await expect(source('reconnected')).toContainText('발언자 미확인 (화자 1)');
    await expect(summary).toContainText('이 참가자가 내일 순찰합니다.');

    const downloadRequested = page.waitForEvent('download');
    await page.getByRole('button', {name:'Markdown 내보내기'}).click();
    const markdown = await readFile(await (await downloadRequested).path(), 'utf8');
    const exported = parseTranscript(markdown);
    expect(exported.speakers).toEqual({'meeting:a:1':'김 담당','followup:c:1':'이 참가자'});
    expect(exported.turns).toEqual(turns);
    expect(markdown.match(/### .*김 담당/g)).toHaveLength(2);
    expect(markdown.match(/### .*이 참가자/g)).toHaveLength(2);
    expect(parseSummary(markdown.split('\n---\n\n').at(-1)).summary).toContain('김 담당이 안전 점검을 부탁했습니다.');
    expect(parseSummary(markdown.split('\n---\n\n').at(-1)).summary).toContain('이 참가자가 내일 순찰합니다.');
  } finally {
    await page.close();
    await new Promise(done => server.close(done));
  }
});
