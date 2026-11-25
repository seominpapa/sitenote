import { expect, test } from '@playwright/test';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.mjs';
import { summaryMarkdown, transcriptMarkdown } from '../../src/records/markdown.ts';
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
    const download = await downloadRequested;
    const markdown = await readFile(await download.path(), 'utf8');
    expect(download.suggestedFilename()).toMatch(/^\d{8}_현장 착공 준비 회의\.md$/u);
    expect(markdown).not.toMatch(/<!-- sitenote-|meeting:a:1|followup:c:1|\[record:/);
    for (const {text} of turns) expect(markdown).toContain(`> ${text}`);
    expect(markdown.match(/### .*김 담당/g)).toHaveLength(2);
    expect(markdown.match(/### .*이 참가자/g)).toHaveLength(2);
    const exportedSummary = markdown.split('\n---\n\n').at(-1);
    expect(exportedSummary).toContain('김 담당이 안전 점검을 부탁했습니다.');
    expect(exportedSummary).toContain('이 참가자가 내일 순찰합니다.');
  } finally {
    await page.close();
    await new Promise(done => server.close(done));
  }
});

test('optional correction moves only selected utterances and preserves source anchors after reload', async ({page}) => {
  const id = 'speaker-correction-test';
  const title = '화자 정정이 필요한 회의';
  const original = [utterance('moved','meeting:a:1','김 과장이 맡겠습니다.',2000),
    utterance('untouched','meeting:a:1','공정은 예정대로입니다.',3500),
    utterance('second-speaker','meeting:a:2','제가 일정표를 배포합니다.',4200),
    utterance('followup','followup:a:1','보충 설명입니다.',5300,'followup')];
  const server = createApp({
    webRoot:process.env.SITENOTE_WEB_TEST_ROOT || fileURLToPath(new URL('../../dist/web', import.meta.url)),
    accessToken:'local-mock-speaker-correction-token-only',
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  try {
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(record => new Promise((resolve,reject) => {
      const open = indexedDB.open('sitenote',1);
      open.onupgradeneeded = () => open.result.createObjectStore('markdown',{keyPath:'id'});
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('markdown','readwrite');
        tx.objectStore('markdown').put(record);
        tx.oncomplete = () => {db.close(); resolve();};
        tx.onabort = () => {db.close(); reject(tx.error);};
      };
    }),{id,'transcript.md':transcriptMarkdown({...createRecord({id,kind:'meeting',title}),turns:original}),
      'summary.md':summaryMarkdown('## 주요 논의\n- 점검 담당자를 지정했습니다. [record:speaker-correction-test#moved]')});

    const reopen = async () => {
      await page.reload();
      await page.getByTestId('record-item').filter({hasText:title}).click();
    };
    await reopen();
    const control = page.getByText('화자 정정 (선택 사항)',{exact:true});
    const menu = page.getByRole('form',{name:'화자 정정'});
    await expect(menu).toHaveCount(0);
    await control.click();
    await expect(menu.getByRole('checkbox')).toHaveCount(3);
    await expect(menu.getByText('CAM++ 설치 안내',{exact:true})).toHaveCount(0);
    const chosen = menu.getByRole('checkbox',{name:/김 과장이 맡겠습니다/});
    const source = page.locator('#moved[data-testid=transcript-turn]');
    const apply = async () => {
      await chosen.check();
      await menu.getByLabel('옮길 화자').selectOption({label:'새 화자 추가'});
      await menu.getByLabel('새 화자 이름 (선택 사항)').fill('김 과장');
      await menu.getByRole('button',{name:'선택한 1개 발언 옮기기'}).click();
      await expect(source).toContainText('김 과장 (화자 3)');
      await expect(page.locator('#untouched[data-testid=transcript-turn]')).toContainText('발언자 미확인 (화자 1)');
    };
    await apply();
    await menu.getByRole('button',{name:'마지막 변경 되돌리기'}).click();
    await expect(source).toContainText('발언자 미확인 (화자 1)');
    await apply();
    await reopen();
    await expect(source).toContainText('김 과장 (화자 3)');
    await expect(source).toContainText('00:00:02');
    await expect(source).toContainText(original[0].text);
    await page.evaluate(() => { window.location.hash = '#record:speaker-correction-test#moved'; });
    await expect(source).toBeFocused();
    const requested = page.waitForEvent('download');
    await page.getByRole('button',{name:'Markdown 내보내기'}).click();
    const markdown = await readFile(await (await requested).path(),'utf8');
    expect(markdown).toContain('00:00:02 · 김 과장 \\(화자 3\\)');
    expect(markdown).toContain('00:00:03 · 화자 1');
  } finally {
    await page.close();
    await new Promise(done => server.close(done));
  }
});

test('regenerated summaries preserve corrected speaker names and separate equal numbers from different streams', async ({page}) => {
  const id = 'speaker-summary-regeneration';
  const title = '회의 요약 화자 검증';
  const moved = utterance('moved','meeting:a:1','김 담당이 현장 점검을 맡습니다.',2000);
  const stayed = utterance('stayed','meeting:a:1','서 부장이 일정을 공지합니다.',5000);
  const reconnected = utterance('reconnected','meeting:b:1','이 과장이 자재를 확인합니다.',9000);
  const record = {...createRecord({id,kind:'meeting',title}),turns:[moved,stayed,reconnected],
    speakers:{[stayed.speakerId]:'서 부장',[reconnected.speakerId]:'이 과장'}};
  const entries = [];
  const server = createApp({
    webRoot:process.env.SITENOTE_WEB_TEST_ROOT || fileURLToPath(new URL('../../dist/web', import.meta.url)),
    accessToken:'local-mock-summary-regeneration-token-only',openaiKey:'test-purpose-only',
    async transport(_url,request) {
      const input = JSON.parse(JSON.parse(request.body).input);
      const spoken = new Map([...input.source.matchAll(/^(\[record:[^\]\n]+\])\n(\{[^\n]+\})/gm)]
        .map(([,anchor,encoded]) => [anchor,JSON.parse(encoded).speaker]));
      entries.push(spoken);
      const owned = [moved,stayed,reconnected].map((turn,i) => {
        const anchor = `[record:${id}#${turn.id}]`;
        return `- ${spoken.get(anchor)}이 시험 항목 ${i+1}을 확인했습니다. ${anchor}`;
      });
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',
        text:JSON.stringify({markdown:['## 새 요약',...owned].join('\n'),questions:[]})}]}]});
    },
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  try {
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
    }),{id,'transcript.md':transcriptMarkdown(record),
      'summary.md':summaryMarkdown('## 기존 요약\n- 화자 1이 점검합니다. [record:speaker-summary-regeneration#moved]')});
    async function reopen() {
      await page.reload();
      await page.getByTestId('record-item').filter({hasText:title}).click();
    }
    await reopen();
    await page.getByText('화자 정정 (선택 사항)',{exact:true}).click();
    const menu = page.getByRole('form',{name:'화자 정정'});
    await menu.getByRole('checkbox',{name:/현장 점검을 맡습니다/}).check();
    await menu.getByLabel('옮길 화자').selectOption({label:'새 화자 추가'});
    await menu.getByLabel('새 화자 이름 (선택 사항)').fill('김 담당');
    await menu.getByRole('button',{name:'선택한 1개 발언 옮기기'}).click();
    const movedTurn = page.locator('#moved[data-testid=transcript-turn]');
    await expect(movedTurn).toContainText('김 담당');
    const regenerated = page.getByRole('button',{name:'요약 다시 만들기'});
    await regenerated.click();
    await expect(page.getByRole('heading',{name:'새 요약'})).toBeVisible();
    expect(entries).toHaveLength(1);
    expect([...entries[0].keys()]).toEqual([moved,stayed,reconnected].map(turn => `[record:${id}#${turn.id}]`));
    expect([...new Set(entries[0].values())]).toHaveLength(3);
    for (const label of entries[0].values()) expect(label).toMatch(/^화자 \d+$/);
    await reopen();
    const summary = page.locator('#summary');
    await expect(summary).toContainText('김 담당이 시험 항목 1을');
    await expect(summary).toContainText('서 부장이 시험 항목 2을');
    await expect(summary).toContainText('이 과장이 시험 항목 3을');
    await page.evaluate(hash => {window.location.hash = hash;},`#record:${id}#${moved.id}`);
    await expect(movedTurn).toBeFocused();
    const requested = page.waitForEvent('download');
    await page.getByRole('button',{name:'Markdown 내보내기'}).click();
    const markdown = await readFile(await (await requested).path(),'utf8');
    expect(markdown).toContain('김 담당이 시험 항목 1을');
    expect(markdown).toContain('서 부장이 시험 항목 2을');
    expect(markdown).toContain('이 과장이 시험 항목 3을');
  } finally {
    await page.close();
    await new Promise(done => server.close(done));
  }
});

async function seedArchivedMeeting(page, note) {
  return page.evaluate(({entry,id,turns}) => {
    const store = (database,name,upgrade,write) => new Promise((resolve,reject) => {
      const open = indexedDB.open(database,1);
      open.onupgradeneeded = () => upgrade(open.result);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(name,'readwrite');
        write(tx);
        tx.oncomplete = () => {db.close(); resolve();};
        tx.onabort = () => {db.close(); reject(tx.error);};
      };
    });
    return Promise.all([
      store('sitenote','markdown',db => db.createObjectStore('markdown',{keyPath:'id'}),
        tx => tx.objectStore('markdown').put(entry)),
      store('sitenote-meeting-audio',['chunks','completed'],db => {
        db.createObjectStore('chunks',{keyPath:['id','index']});
        db.createObjectStore('completed');
      },tx => {
        const chunks = new Map();
        for (const [i,turn] of turns.entries()) {
          for (let start = turn.timeMs*24, stop = start + 3*24000; start < stop;) {
            const index = Math.floor(start/96_000);
            const offset = start%96_000;
            const length = Math.min(stop-start,96_000-offset);
            const chunk = chunks.get(index) ?? {id,index,pcm:new ArrayBuffer(192_000),captured:[]};
            new Int16Array(chunk.pcm).fill(i === 1 ? -8_192 : 8_192,offset,offset+length);
            chunk.captured.push([offset,offset+length]);
            chunks.set(index,chunk);
            start += length;
          }
        }
        for (const chunk of chunks.values()) tx.objectStore('chunks').put(chunk);
        tx.objectStore('completed').put(true,id);
      }),
    ]);
  },{entry:{id:note.id,'transcript.md':transcriptMarkdown(note)},id:note.id,turns:note.turns});
}

test('CAM++ installation guide is opt-in when audio exists and never starts downloads', async ({page,context}) => {
  const id = 'speaker-guide-test';
  const title = '화자 모델 설치 안내 검증';
  const speech = utterance('reference','meeting:a:1','보관된 회의 발언입니다.',2000);
  const fixture = await mkdtemp(join(tmpdir(),'sitenote-install-guide-'));
  const previousModel = process.env.SITENOTE_SPEAKER_MODEL;
  let server;
  try {
    process.env.SITENOTE_SPEAKER_MODEL = join(fixture,'model-not-installed.onnx');
    server = createApp({
      webRoot:process.env.SITENOTE_WEB_TEST_ROOT || fileURLToPath(new URL('../../dist/web', import.meta.url)),
      accessToken:'local-test-model-guide-no-credentials',
    });
  } finally {
    if (previousModel === undefined) delete process.env.SITENOTE_SPEAKER_MODEL;
    else process.env.SITENOTE_SPEAKER_MODEL = previousModel;
    await rm(fixture,{recursive:true,force:true});
  }
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  try {
    const origin = 'http://127.0.0.1:' + server.address().port;
    await page.goto(origin);
    await seedArchivedMeeting(page,{...createRecord({id,kind:'meeting',title}),turns:[speech]});
    await page.reload();
    await page.getByTestId('record-item').filter({hasText:title}).click();
    const guide = page.getByText('CAM++ 설치 안내',{exact:true});
    await expect(guide).not.toBeVisible();
    await page.getByText('화자 정정 (선택 사항)',{exact:true}).click();
    await expect(guide).toBeVisible();
    await expect(page.getByText(/npm install.*sherpa-onnx-node/).first()).not.toBeVisible();
    await expect(page.getByRole('button',{name:'기준 발언과 비슷한 발언 찾기'})).toHaveCount(0);

    const requests = [];
    const downloads = [];
    const popups = [];
    function onRequest(request) { requests.push(request.url()); }
    function onDownload(download) { downloads.push(download.url()); }
    function onPopup(popup) { popups.push(popup); }
    context.on('request',onRequest);
    page.on('download',onDownload);
    page.on('popup',onPopup);
    await guide.click();
    await expect(page.getByText(/npm install.*sherpa-onnx-node/).first()).toBeVisible();
    expect(requests).toEqual([]);
    expect(downloads).toEqual([]);
    expect(popups).toEqual([]);
  } finally {
    await page.close();
    await new Promise(done => server.close(done));
  }
});

test('finding similar voices proposes archived utterances and only changes those the user confirms', async ({page}) => {
  const id = 'speaker-match-test';
  const title = '비슷한 발언을 찾을 회의';
  const ref = utterance('reference','meeting:a:1','화자가 확실한 발언입니다.',2000);
  const other = utterance('other','meeting:a:1','이 발언은 다른 사람의 것입니다.',5500);
  const match = utterance('match','meeting:b:2','다른 번호에 섞인 같은 사람입니다.',9000);
  const note = {...createRecord({id,kind:'meeting',title}),turns:[ref,other,match]};
  const observed = [];
  const server = createApp({
    webRoot:process.env.SITENOTE_WEB_TEST_ROOT || fileURLToPath(new URL('../../dist/web', import.meta.url)),
    accessToken:'local-mock-similar-speaker-token-only',
    speakerEmbedder:async (samples) => {
      observed.push(samples.length);
      return [samples[500], samples[500]];
    },
    transport:async () => { throw Error('mocked speaker match should never call a hosted service'); },
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  try {
    await page.goto('http://127.0.0.1:' + server.address().port);
    await seedArchivedMeeting(page,note);
    await page.reload();
    await page.getByTestId('record-item').filter({hasText:title}).click();
    const source = id => page.locator('#'+id+'[data-testid=transcript-turn]');
    await page.getByText('화자 정정 (선택 사항)',{exact:true}).click();
    const menu = page.getByRole('form',{name:'화자 정정'});
    const find = menu.getByRole('button',{name:'기준 발언과 비슷한 발언 찾기'});
    await expect(find).toBeDisabled();
    await menu.getByRole('checkbox',{name:new RegExp(ref.text)}).check();
    await find.click();
    await expect(menu.getByRole('status')).toContainText('비슷한 발언 1개를 선택했습니다');
    await expect(menu.getByRole('checkbox')).toHaveCount(2);
    await expect(menu.getByRole('checkbox',{name:new RegExp(match.text)})).toBeChecked();
    await expect(source(ref.id)).toContainText('화자 1');
    await expect(source(match.id)).toContainText('화자 2');
    await menu.getByLabel('옮길 화자').selectOption({label:'새 화자 추가'});
    await menu.getByLabel('새 화자 이름 (선택 사항)').fill('박 과장');
    await menu.getByRole('button',{name:'선택한 2개 발언 옮기기'}).click();
    await expect(source(ref.id)).toContainText('박 과장 (화자 3)');
    await expect(source(match.id)).toContainText('박 과장 (화자 3)');
    await expect(source(other.id)).toContainText('화자 1');
    expect(observed).toEqual([72000*2/3,72000*2/3,72000*2/3]);
  } finally {
    await page.close();
    await new Promise(done => server.close(done));
  }
});
