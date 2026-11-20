import { expect, test } from '@playwright/test';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.mjs';
import { parseTranscript, transcriptMarkdown } from '../../src/records/markdown.ts';
import { createRecord, applyTurn } from '../../src/records/model.ts';

const project = '서편 현장';
const personal = applyTurn(createRecord({id:'past', kind:'personal', title:'현장 확인 기록', project, now:'2026-10-01T00:00:00.000Z'}), {
  id:'past-turn', section:'personal', role:'user', timeMs:0, text:'방수막 재시험은 목요일 열 시입니다.',
});

async function disk(page, patch = {}) {
  return page.evaluate(({put, raw, drop, read}) => new Promise((resolve, reject) => {
    const open = indexedDB.open('sitenote', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('markdown', {keyPath:'id'});
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('markdown', put || raw || drop ? 'readwrite' : 'readonly');
      const store = tx.objectStore('markdown');
      if (put) store.put(put);
      if (raw) store.put(raw);
      if (drop) store.delete(drop);
      const request = read && store.get(read);
      tx.oncomplete = () => { db.close(); resolve(request?.result?.['transcript.md']); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), {...patch, ...(patch.put && {put:{id:patch.put.id, 'transcript.md':transcriptMarkdown(patch.put)}})});
}

async function usingServer(run) {
  const server = createApp({
    webRoot:process.env.SITENOTE_WEB_TEST_ROOT || fileURLToPath(new URL('../../dist/web', import.meta.url)),
    accessToken:'isolated-multiple-tabs-fixture-key', openaiKey:'fixture-openai', sonioxKey:'fixture-soniox',
    async transport() { throw Error('Unexpected provider call'); },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
}

async function openEditor(page, title = personal.title) {
  await page.getByTestId('record-item').filter({hasText:title}).click();
  await page.getByText('기록 설정', {exact:true}).click();
}

test('voice search respects sharing switched off in another tab during recording', async ({page, context}) => {
  await usingServer(async url => {
    const received = [];
    let stream;
    await page.routeWebSocket('**/stream', socket => {
      stream = socket;
      socket.onMessage(raw => {
        const data = JSON.parse(raw);
        if (data.type === 'start') socket.send(JSON.stringify({type:'ready', scope:'meeting'}));
        if (data.type === 'ask') socket.send(JSON.stringify({type:'ready', scope:'live'}));
        if (data.type === 'search_result') received.push(data);
      });
    });
    const peer = await context.newPage();
    await peer.goto(url);
    await disk(peer, {put:personal});
    await peer.reload();
    await page.goto(url);
    await expect(page.getByTestId('record-item')).toHaveCount(1);
    await page.getByLabel('회의 제목', {exact:true}).fill('현재 방수 회의');
    await page.getByLabel('회의 프로젝트', {exact:true}).fill(project);
    await page.getByRole('button', {name:'회의 시작', exact:true}).click();
    await page.getByRole('button', {name:'AI에게 질문', exact:true}).click();
    await expect(page.getByTestId('voice-status')).toHaveText(/지금 질문하세요/);
    const ask = id => stream.send(JSON.stringify({type:'search', id, query:'방수막 재시험 언제였나요?'}));
    ask('before-revocation');
    await expect.poll(() => received.find(m => m.id === 'before-revocation')?.context).toContain('[record:past#past-turn]');
    stream.send(JSON.stringify({type:'live', streamId:'answer-1', offsetMs:1, refs:['[record:past#past-turn]'],
      event:{type:'session.output_transcript.delta', delta:'목요일 열 시입니다.', event_id:'fixture-answer', start_ms:1, end_ms:2}}));
    await page.getByTestId('live-sources').getByRole('button', {name:new RegExp(personal.title)}).click();
    const reader = page.getByRole('dialog', {name:'원문 보기'});
    await expect(reader.getByText(personal.turns[0].text, {exact:true})).toBeVisible();
    await openEditor(peer);
    await peer.getByRole('checkbox', {name:'회의에서 이 개인 기록 참고하지 않음'}).check();
    await peer.getByRole('button', {name:'기록 설정 저장'}).click();
    await expect(peer.getByText('기록을 업데이트했습니다.')).toBeVisible();
    await expect(reader).toHaveCount(0);
    await expect(page.getByTestId('live-sources')).toHaveCount(0);
    await expect(page.getByTestId('voice-status')).toHaveText(/지금 질문하세요/);
    ask('after-revocation');
    await expect.poll(() => received.find(m => m.id === 'after-revocation')?.context).toBe('');
    await peer.close();
    await page.close();
  });
});

test('a stale editor preserves newly committed turns and permissions and cannot recreate a deleted note', async ({page, context}) => {
  await usingServer(async url => {
    const peer = await context.newPage();
    await peer.goto(url);
    await disk(peer, {put:personal});
    await page.goto(url);
    await openEditor(page);
    const old = await disk(peer, {read:personal.id});
    const expanded = applyTurn({...parseTranscript(old), allowInMeetings:false}, {
      id:'other-tab-turn', section:'personal', role:'user', text:'다른 탭의 새 원문입니다.', timeMs:100,
    });
    await disk(peer, {put:expanded});
    await page.getByLabel('기록 제목').fill('수정한 제목');
    await page.getByRole('button', {name:'기록 설정 저장'}).click();
    await expect(page.getByRole('heading', {name:'수정한 제목'})).toBeVisible();
    const saved = parseTranscript(await disk(peer, {read:personal.id}));
    expect(saved.turns.map(turn => turn.id)).toEqual(['past-turn','other-tab-turn']);
    expect(saved.allowInMeetings).toBe(false);

    const details = page.locator('details.edit-record');
    if (await details.getAttribute('open') === null) await page.getByText('기록 설정', {exact:true}).click();
    await page.getByLabel('기록 제목').fill('아직 저장하지 않은 제목');
    await openEditor(peer, '수정한 제목');
    const sharing = '회의에서 이 개인 기록 참고하지 않음';
    await peer.getByRole('checkbox', {name:sharing}).uncheck();
    await peer.getByRole('button', {name:'기록 설정 저장'}).click();
    await expect(peer.getByText('기록을 업데이트했습니다.')).toBeVisible();
    await expect.poll(() => page.getByRole('checkbox', {name:sharing}).evaluate(input => input.defaultChecked)).toBe(false);
    await expect(page.getByLabel('기록 제목')).toHaveValue('아직 저장하지 않은 제목');
    await page.getByRole('button', {name:'기록 설정 저장'}).click();
    await expect(page.getByRole('heading', {name:'아직 저장하지 않은 제목'})).toBeVisible();
    expect(parseTranscript(await disk(peer, {read:personal.id})).allowInMeetings).toBe(true);

    if (await details.getAttribute('open') === null) await page.getByText('기록 설정', {exact:true}).click();
    await disk(peer, {drop:personal.id});
    await page.getByLabel('기록 제목').fill('다시 나타나면 안 되는 기록');
    await page.getByRole('button', {name:'기록 설정 저장'}).click();
    await expect(page.getByText(/다른 탭에서.*삭제/)).toBeVisible();
    expect(await disk(peer, {read:personal.id})).toBeUndefined();
    await peer.close();
    await page.close();
  });
});

test('an older undo control cannot revert a newer classification batch from another tab', async ({page, context}) => {
  await usingServer(async url => {
    // Simulate a notification arriving after the user clicked the older control.
    await page.addInitScript(() => {
      window.BroadcastChannel = class extends BroadcastChannel {
        addEventListener(type, ...args) { if (type !== 'message') super.addEventListener(type, ...args); }
      };
    });
    const peer = await context.newPage();
    const older = {...personal, category:['초기 AI 분류']};
    const fresh = createRecord({id:'unclassified', kind:'meeting', title:'새로 분류할 기록'});
    await peer.goto(url);
    await disk(peer, {put:older});
    await disk(peer, {put:fresh});
    await peer.evaluate(base => localStorage.setItem('sitenote:category-undo', JSON.stringify([base])), {
      id:older.id, path:older.category, updatedAt:older.updatedAt,
    });
    await page.goto(url);
    await page.getByRole('button', {name:'분류별', exact:true}).click();
    const undo = page.getByRole('button', {name:'AI 분류 되돌리기', exact:true});
    await expect(undo).toBeEnabled();

    await peer.route('**/categories', route => route.fulfill({json:{assignments:[{id:fresh.id, path:['새 AI 분류']}]}}));
    await peer.reload();
    await peer.getByRole('button', {name:'분류별', exact:true}).click();
    await peer.getByRole('button', {name:'AI 자동 분류', exact:true}).click();
    await expect(peer.getByText('기록 1개의 분류를 저장했습니다.')).toBeVisible();

    await undo.click();
    await expect(page.getByText(/다른 탭에서 AI 분류를 바꿨습니다/)).toBeVisible();
    expect(parseTranscript(await disk(peer, {read:fresh.id})).category).toEqual(['새 AI 분류']);
    expect(parseTranscript(await disk(peer, {read:older.id})).category).toEqual(['초기 AI 분류']);
    await undo.click();
    await expect(page.getByText('기록 1개의 AI 분류를 되돌렸습니다.')).toBeVisible();
    expect(parseTranscript(await disk(peer, {read:fresh.id})).category).toBeUndefined();
    expect(parseTranscript(await disk(peer, {read:older.id})).category).toEqual(['초기 AI 분류']);
    await peer.close();
    await page.close();
  });
});

test('a damaged record leaves readable notes available and reports the issue', async ({page}) => {
  await usingServer(async url => {
    await page.goto(url);
    await disk(page, {put:personal, raw:{id:'damaged', 'transcript.md':'unreadable transcript'}});
    await page.reload();
    await expect(page.getByText(/기록 1개의 원문 또는 요약을 읽지 못했습니다/)).toBeVisible();
    await page.getByTestId('record-item').filter({hasText:personal.title}).click();
    await expect(page.getByTestId('transcript-turn').getByText(personal.turns[0].text, {exact:true})).toBeVisible();
    expect(await disk(page, {read:'damaged'})).toBe('unreadable transcript');
    await page.close();
  });
});
