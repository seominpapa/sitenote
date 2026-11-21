import { expect, test } from '@playwright/test';
import { EventEmitter, once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.mjs';
import { ordinaryQuestionPlan } from './voice-plan.mjs';
import { summaryMarkdown, transcriptMarkdown } from '../../src/records/markdown.ts';
import { createRecord } from '../../src/records/model.ts';

const project = '한강 현장';
const activeTitle = '오늘 품질 회의';
const originalTitle = '지난 품질 합의';
const original = '방수막 재시험은 목요일 오전 열 시에 진행하기로 합의했습니다.';
const corroboratingTitle = '이전 작업자 일정 조율';
const corroborating = '방수막 재시험에 필요한 장비를 전날 들여오겠습니다.';
const lowerRanked = '방수막 재시험에 쓸 입회자 서명 양식을 준비하세요.';
const activeText = '방수막 재시험에 대한 현행안입니다. 오늘 기록만 검토 중입니다.';
const titleOnly = '출입구에서 방문자 명단을 확인하세요.';
const aiOnly = '방수막 재시험 관련 AI 추정은 일요일입니다.';
const summaryOnly = '방수막 재시험 관련 요약 추정은 토요일입니다.';
const privateText = '방수막 재시험 관련 개인 메모입니다. 공개 금지.';
const otherProjectText = '방수막 재시험 관련 다른 현장 자료입니다. 별도 계약.';
const futureText = '방수막 재시험에 관한 아직 열리지 않은 회의 기록입니다.';
const unrelated = '사진에 작업자 이름을 쓰지 마십시오.';
const question = '방수막 재시험 언제였나요?';
const noMatch = '제브라피시 먹이반응?';
const answer = '지난 회의에서 “목요일 오전 열 시에 진행하기로 합의했습니다”라고 했습니다.';
const emptyAnswer = '관련 과거 원문을 찾지 못했습니다.';
const fallbackQuestion = '토요일에 무슨 얘기했어?';
const fallbackAnswer = '요약에만 있는 내용입니다. 토요일이라는 추정이 있습니다.';
const latestQuestion = '최근에 한 회의 내용이 뭐였지?';
const latestAnswer = '가장 최근에 저장한 회의에서는 현장 출입구를 옮기기로 했습니다.';
const newestMeetingText = '현장 출입구를 북측으로 옮기기로 했습니다.';
const summaryTitle = '오늘 회의 핵심 정리';
const forged = '[record:summary-only#summary]';
const at = '2026-09-04T04:30:00.000Z';
const pcm = Buffer.alloc(9_600);
for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(800, i);

const speaking = (id, text, timeMs = 0) => ({id, section:'meeting', role:'speaker', speakerId:'1', text, timeMs});
const seed = ({id, title, kind = 'meeting', site = project, turns, summary, now = at, allowInMeetings}) => ({id,
  'transcript.md': transcriptMarkdown({...createRecord({id, title, kind, project:site, now}), turns,
    ...(allowInMeetings !== undefined && {allowInMeetings})}),
  ...(summary && {'summary.md': summaryMarkdown(summary)}),
});
const fixtures = [
  seed({id:'past-original', title:originalTitle, turns:[speaking('before-original', unrelated), speaking('exact-original', original, 83_000)]}),
  seed({id:'corroborating', title:corroboratingTitle, turns:[speaking('second-original', corroborating)]}),
  seed({id:'lower-ranked', title:'서류 준비', now:'2026-08-04T04:30:00.000Z', turns:[speaking('third-original', lowerRanked)]}),
  seed({id:'title-only', title:'방수막 재시험 자료 모음', turns:[speaking('title-decoy', titleOnly)]}),
  seed({id:'latest-meeting', title:'출입구 배치 회의', now:'2026-09-05T04:30:00.000Z',
    turns:[speaking('gate-decision', newestMeetingText)]}),
  seed({id:'summary-only', title:'기타 메모', summary:summaryOnly, turns:[speaking('unrelated', unrelated),
    {id:'ai-decoy', section:'meeting-ai', role:'ai', text:aiOnly, timeMs:1000}]}),
  seed({id:'private-record', title:'비공개 개인 기록', kind:'personal', allowInMeetings:false, turns:[{
    id:'private-turn', section:'personal', role:'user', text:privateText, timeMs:0,
  }]}),
  seed({id:'other-project', title:'다른 현장 회의', site:'성수 현장', turns:[speaking('other-turn', otherProjectText)]}),
  seed({id:'future-record', title:'예정된 회의', now:'2099-09-04T04:30:00.000Z', turns:[speaking('future-turn', futureText)]}),
];

function fakeSocket(onSend) {
  const socket = Object.assign(new EventEmitter(), {
    readyState:0, bufferedAmount:0,
    send(data) { onSend(data, reply); },
    close() { this.readyState = 3; this.emit('close'); },
    terminate() { this.close(); },
  });
  const reply = data => queueMicrotask(() => socket.emit('message', JSON.stringify(data)));
  queueMicrotask(() => { socket.readyState = 1; socket.emit('open'); });
  return socket;
}

async function seedLibrary(page) {
  await page.evaluate(entries => new Promise((resolve, reject) => {
    const open = indexedDB.open('sitenote', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('markdown', {keyPath:'id'});
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('markdown', 'readwrite');
      const store = tx.objectStore('markdown');
      for (const entry of entries) store.put(entry);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), fixtures);
  await page.reload();
  await expect(page.getByTestId('record-item')).toHaveCount(fixtures.length);
}

test('voice references are the matched historical originals, readable during recording and after saving', async ({page}) => {
  let meetingSocketCount = 0;
  let meetingFrames = 0;
  let utterance;
  let summarySource;
  const requests = [];
  const server = createApp({
    async planQuestion(input) {
      if (input.question !== latestQuestion) return ordinaryQuestionPlan(input);
      expect(input.meeting).toEqual({title:activeTitle,project});
      expect(input.recentQuestions).toEqual([question,fallbackQuestion,noMatch]);
      return {scope:'latest',range:'overview',terms:'',sameProject:false};
    },
    webRoot:process.env.SITENOTE_WEB_TEST_ROOT || fileURLToPath(new URL('../../dist/web', import.meta.url)),
    accessToken:'fixture-access-token-not-a-real-key', openaiKey:'fixture-openai', sonioxKey:'fixture-soniox',
    async transport(_url, request) {
      const payload = JSON.parse(request.body);
      const data = JSON.parse(payload.input);
      if (data.question === latestQuestion) {
        expect(data.transcript).toContain(newestMeetingText);
        expect(data.transcript).not.toContain(activeText);
        expect(data.transcript).not.toContain(original);
        return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:newestMeetingText}]}]});
      }
      if (!data.source?.includes(activeText)) return new Response(null, {status:400});
      summarySource = data.source;
      return Response.json({status:'completed', output:[{type:'message', content:[{type:'output_text', text:JSON.stringify({
        markdown:`# ${summaryTitle}\n\n목요일에 재시험을 합니다. 출처1 ${forged}`, questions:[],
      })}]}]});
    },
    upstream(url) {
      const provider = new URL(url);
      if (provider.hostname === 'stt-rt.soniox.com') {
        const meeting = ++meetingSocketCount === 1;
        let audioMs = 0;
        return fakeSocket((data, reply) => {
          if (data === '') return reply({finished:true});
          if (!meeting || !Buffer.isBuffer(data)) return;
          audioMs += data.length / 48;
          const text = ++meetingFrames === 1 ? activeText : utterance;
          if (!text) return;
          utterance = undefined;
          reply({tokens:[{text, speaker:'1', is_final:true, start_ms:audioMs, end_ms:audioMs + 40}, {text:'<end>', is_final:true}]});
        });
      }
      if (provider.pathname !== '/v1/live/sessions') throw Error(`Unexpected fixture provider ${provider.pathname}`);
      return fakeSocket((data, reply) => {
        const message = JSON.parse(data);
        if (message.type === 'session.close') return reply({type:'session.closed',reason:'close_requested'});
        if (message.type !== 'session.start') return;
        const index = requests.length;
        const input = message.session.input;
        requests.push({
          question: input.filter(item => item.role === 'user').at(-1).content[0].text,
          evidence: input.find(item => item.role === 'user'
            && item.content[0].text.startsWith('다음은 참고 데이터입니다: '))?.content[0].text ?? '',
          instructions: message.session.instructions,
        });
        reply({type:'session.started'});
        reply({type:'session.output_audio.delta', event_id:`audio-${index}`, delta:pcm.toString('base64')});
        reply({type:'session.output_transcript.delta', event_id:`text-${index}`, delta:[answer,fallbackAnswer,emptyAnswer,latestAnswer][index], start_ms:10,end_ms:110});
      });
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await page.goto('http://127.0.0.1:' + server.address().port);
    await expect(page.getByText('로컬 서버 연결됨')).toBeVisible();
    await seedLibrary(page);
    await page.getByLabel('회의 제목', {exact:true}).fill(activeTitle);
    await page.getByLabel('회의 프로젝트').fill(project);
    await page.getByRole('button', {name:'회의 시작'}).click();
    const turns = page.getByTestId('transcript-turn');
    await expect(turns.filter({hasText:activeText})).toBeVisible();
    await page.getByRole('button', {name:'AI에게 질문'}).click();
    const ai = page.getByTestId('ai-panel');
    await expect(ai).toContainText('질문 듣는 중');
    utterance = question;
    await expect(turns.filter({hasText:answer})).toBeVisible();
    expect(requests.map(item => item.question)).toEqual([question]);
    const context = requests[0].evidence;
    expect(context).toContain(original);
    expect(context).toContain(corroborating);
    const historical = JSON.parse(context.split('다음은 참고 데이터입니다: ')[1]).split('검색된 과거 원문:\n')[1];
    expect(historical.split('\n').map(line => JSON.parse(line).excerpt).sort()).toEqual([original, corroborating].sort());
    const excludedSources = [titleOnly, aiOnly, summaryOnly, privateText, otherProjectText, futureText, unrelated, lowerRanked];
    for (const excluded of excludedSources) {
      expect(context).not.toContain(excluded);
    }

    const sources = page.getByTestId('live-sources');
    await expect(sources.getByRole('list', {name:'답변에서 직접 인용한 원문'})).toContainText(originalTitle);
    await expect(sources.getByRole('list', {name:'답변에 제공한 다른 원문'})).toContainText(corroboratingTitle);
    await expect(sources.getByRole('button')).toHaveCount(2);
    await expect(sources.getByRole('button', {name:new RegExp(corroboratingTitle)})).toBeVisible();
    await expect(ai).toContainText('질문 듣는 중');
    await sources.getByRole('button', {name:new RegExp(originalTitle)}).click();
    const preview = page.getByRole('dialog', {name:'원문 보기'});
    await expect(preview.getByText(original, {exact:true})).toBeVisible();
    await expect(preview.getByText(unrelated, {exact:true})).toHaveCount(0);
    const framesOnOpen = meetingFrames;
    await expect.poll(() => meetingFrames).toBeGreaterThan(framesOnOpen + 2);
    expect(meetingSocketCount).toBe(1);
    await expect(preview).toBeVisible();
    await preview.getByRole('button', {name:'닫기'}).click();
    await expect(preview).toHaveCount(0);

    utterance = fallbackQuestion;
    await expect(turns.filter({hasText:fallbackAnswer})).toBeVisible();
    expect(requests[1].evidence).toContain(summaryOnly);
    expect(JSON.parse(requests[1].evidence.split('다음은 참고 데이터입니다: ')[1])).toContain('"summaryOnly":true');
    expect(requests[1].instructions).toContain('요약에만 있는 내용');
    await sources.getByRole('list',{name:'요약에만 있는 내용'}).getByRole('button').click();
    const summaryPreview = page.getByRole('dialog', {name:'요약에만 있는 내용'});
    await expect(summaryPreview.getByText(summaryOnly,{exact:true})).toBeVisible();
    await summaryPreview.getByRole('button',{name:'닫기'}).click();
    await expect(ai).toContainText('질문 듣는 중');

    utterance = noMatch;
    await expect(turns.filter({hasText:emptyAnswer})).toBeVisible();
    expect(requests.map(item => item.question)).toEqual([question, fallbackQuestion, noMatch]);
    expect(requests[2].evidence).not.toContain('검색된 과거 원문:');
    await expect(sources).toHaveCount(0);
    await expect(ai).toContainText('질문 듣는 중');
    utterance = latestQuestion;
    await expect(turns.filter({hasText:latestAnswer})).toBeVisible();
    expect(requests[3].evidence).toContain(newestMeetingText);
    expect(requests[3].evidence).not.toContain(activeText);
    expect(requests[3].evidence).not.toContain(original);
    await expect(sources.getByRole('button', {name:/출입구 배치 회의/})).toBeVisible();
    await page.getByRole('button', {name:'AI 질문 닫기'}).click();
    await page.getByRole('button', {name:'녹음 종료'}).click();
    await expect(page.getByRole('heading', {name:summaryTitle})).toBeVisible();
    expect(summarySource).not.toContain(original);
    expect(summarySource).not.toContain(corroborating);
    for (const excluded of excludedSources) expect(summarySource).not.toContain(excluded);
    await expect(page.locator('#summary')).not.toContainText(/출처\s*1|\[record:summary-only/);
    await page.reload();
    await page.getByTestId('record-item').filter({hasText:activeTitle}).click();
    await expect(page.getByRole('heading', {level:1, name:activeTitle})).toBeVisible();
    const saved = turns.filter({hasText:answer}).getByTestId('saved-sources');
    const savedFallback = turns.filter({hasText:fallbackAnswer}).getByTestId('saved-sources')
      .getByRole('list',{name:'요약에만 있는 내용'}).getByRole('link');
    await expect(savedFallback).toHaveAttribute('href', /#record:summary-only#summary-only-[0-9a-f]{8}$/);
    await expect(turns.filter({hasText:answer}).getByTestId('saved-sources')).toHaveCount(1);
    await expect(turns.filter({hasText:emptyAnswer}).getByTestId('saved-sources')).toHaveCount(0);
    await expect(saved.getByRole('list', {name:'답변에서 직접 인용한 원문'})).toContainText(originalTitle);
    await expect(saved.getByRole('link', {name:new RegExp(originalTitle)})).toHaveAttribute('href', '#record:past-original#exact-original');
    await expect(saved.getByRole('link')).toHaveCount(2);
    await expect(saved.getByRole('link', {name:new RegExp(corroboratingTitle)})).toBeVisible();
    await expect(page.locator('#summary')).not.toContainText(/출처\s*1|\[record:summary-only/);
    await saved.getByRole('link', {name:new RegExp(originalTitle)}).click();
    await expect(page.getByRole('heading', {level:1, name:originalTitle})).toBeVisible();
    const exactTurn = turns.filter({hasText:original});
    await expect(exactTurn).toBeVisible();
    await expect(exactTurn).toBeFocused();
  } finally {
    await page.close();
    await new Promise(done => server.close(done));
  }
});

test('library AI answers label unconfirmed summary evidence and link supported answers to the original turn', async ({page}) => {
  const contexts = [];
  const reference = '[record:past-original#exact-original]';
  const server = createApp({
    webRoot:process.env.SITENOTE_WEB_TEST_ROOT || fileURLToPath(new URL('../../dist/web', import.meta.url)), accessToken:'fixture-access-token-not-a-real-key',
    openaiKey:'fixture-openai', sonioxKey:'fixture-soniox',
    async transport(_url, request) {
      const payload = JSON.parse(request.body);
      const {source} = JSON.parse(payload.input);
      contexts.push(source);
      const fallback = /\[record:summary-only#summary-only-[0-9a-f]{8}\]/.exec(source)?.[0];
      if (fallback) expect(payload.instructions).toContain('요약에만 있는 내용');
      return Response.json({status:'completed', output:[{type:'message', content:[{type:'output_text',
        text:fallback ? '토요일이라는 요약입니다. ' + fallback + ' ' + forged : '목요일 오전입니다. ' + reference + ' ' + forged}]}]});
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await page.goto('http://127.0.0.1:' + server.address().port);
    await seedLibrary(page);
    await page.getByRole('button', {name:'검색', exact:true}).click();
    const submit = async query => {
      await page.getByLabel('기록 검색').fill(query);
      await page.getByRole('button', {name:'검색 실행'}).click();
      await page.getByRole('button', {name:'이 기록에 AI로 질문'}).click();
    };
    const result = page.getByRole('heading', {name:'AI 답변'}).locator('..');
    await submit('토요일');
    const fallback = result.getByRole('link', {name:/요약에만 있는 내용: 기타 메모/});
    await expect(fallback).toBeVisible();
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toContain(summaryOnly);
    expect(contexts[0]).toContain('"summaryOnly":true');
    expect(contexts[0]).not.toContain(aiOnly);
    await fallback.click();
    await expect(page.locator('#summary')).toBeFocused();
    await expect(page.locator('#summary')).toContainText('원문에서 확인되지 않았습니다.');
    await page.getByRole('button', {name:'최근 노트'}).click();
    await page.getByRole('button', {name:'검색', exact:true}).click();
    await submit('목요일');
    await expect(result).toContainText('목요일 오전입니다.');
    expect(contexts).toHaveLength(2);
    expect(contexts[1]).toContain(original);
    expect(contexts[1]).not.toContain(aiOnly);
    expect(contexts[1]).not.toContain(summaryOnly);
    await expect(result).not.toContainText(forged);
    await result.getByRole('link', {name:new RegExp(originalTitle)}).click();
    await expect(page.getByTestId('transcript-turn').filter({hasText:original})).toBeFocused();
  } finally {
    await page.close();
    await new Promise(done => server.close(done));
  }
});
