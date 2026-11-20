import { expect, test } from '@playwright/test';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.mjs';
import { parseTranscript } from '../../src/records/markdown.ts';

const pcm = Buffer.alloc(960).toString('base64');
const recorded = '납기 변경 내용을 기록합니다.';
const question = '납기 변경 이유를 짧게 알려주세요.';
const resumedRecording = '이어서 확인한 수량도 기록합니다.';
const aiReply = '자재 납품이 늦어져 납기를 변경했습니다.';
const summary = '납기 변경 회고';
const title = '개인 대화';
const project = '납품 검토';
const secondTitle = '외부 점검 아이디어';

test('starts personal recording on Soniox, invites GPT once, then keeps recording and files the note', async ({ page }) => {
  const tmp = await mkdtemp(join(tmpdir(), 'sitenote-browser-'));
  const openaiKey = 'fake-openai-key-for-sitenote-test';
  const sonioxKey = 'fake-soniox-key-for-sitenote-test';
  let sonioxConnections = 0;
  let liveConnections = 0;
  let closedLiveConnections = 0;
  let questionSpoken = false;
  const aiQuestions = [];
  const audioInput = [];
  let classified = false;
  const server = createApp({
    webRoot: process.env.SITENOTE_WEB_TEST_ROOT || fileURLToPath(new URL('../../dist/web', import.meta.url)),
    webKeysFile: join(tmp, 'keys.json'),
    accessToken: 'test-only-not-a-real-access-token',
    async transport(_url, request) {
      const payload = JSON.parse(request.body);
      const input = JSON.parse(payload.input);
      if (payload.text?.format?.name === 'record_categories') {
        if (input.records.length !== 1 || input.records[0].title !== secondTitle
          || JSON.stringify(input.knownPaths) !== JSON.stringify([['업무', '공급망']])) return new Response(null, {status: 400});
        classified = true;
        return Response.json({status:'completed', output:[{type:'message', content:[{type:'output_text',
          text: JSON.stringify({assignments:[{id:input.records[0].id, path:['업무', '안전 점검']}]}),
        }]}]});
      }
      const source = input.source;
      if (request.headers.Authorization !== 'Bearer ' + openaiKey || !source.includes(recorded)) {
        return new Response(null, {status: 400});
      }
      return Response.json({status: 'completed', output: [{type: 'message', content: [
        {type: 'output_text', text: JSON.stringify({markdown: '# ' + summary + '\n\n- 새 납기를 확인합니다.', questions: []})},
      ]}]});
    },
    upstream(url) {
      let sentReply = false;
      let sentResumed = false;
      let sentQuestion = false;
      let itemText;
      let audioMs = 0;
      const emit = event => queueMicrotask(() => ws.emit('message', JSON.stringify(event)));
      const soniox = new URL(url).hostname === 'stt-rt.soniox.com';
      const realtime = new URL(url).pathname === '/v1/realtime';
      const connection = soniox ? ++sonioxConnections : ++liveConnections;
      const ws = Object.assign(new EventEmitter(), {
        readyState: 1, bufferedAmount: 0,
        send(data) {
          if (soniox) {
            if (data === '') return emit({finished:true});
            if (!Buffer.isBuffer(data) || data.length !== 960) return;
            audioMs += data.length / 48;
            if (!data.some(Boolean)) return;
            if (!sentReply) {
              sentReply = true;
              emit({tokens:[{text:recorded, speaker:'1', start_ms:10, end_ms:50, is_final:true}, {text:'<end>', is_final:true}]});
            } else if (connection === 1 && questionSpoken && !sentQuestion) {
              sentQuestion = true;
              emit({tokens:[{text:question, speaker:'1', start_ms:audioMs, end_ms:audioMs + 40, is_final:true}, {text:'<end>', is_final:true}]});
            } else if (connection === 1 && closedLiveConnections && !sentResumed) {
              sentResumed = true;
              emit({tokens:[{text:resumedRecording, speaker:'1', start_ms:audioMs, end_ms:audioMs + 40, is_final:true}]});
            }
            return;
          }
          const message = JSON.parse(data);
          if (message.type === 'input_audio_buffer.append' || message.type === 'session.input_audio.append') audioInput.push(message.type);
          if (!realtime) return;
          if (message.type === 'session.update') emit({type: 'session.updated', session: {type:'realtime'}});
          if (message.type === 'conversation.item.create' && message.item?.role === 'user') {
            itemText = message.item.content?.find(part => part.type === 'input_text')?.text;
            aiQuestions.push(itemText);
          }
          if (message.type === 'response.create' && itemText === question && !sentReply) {
            sentReply = true;
            const response = {id:'personal-response', metadata:message.response?.metadata};
            emit({type: 'response.created', response});
            emit({type: 'response.output_audio.delta', event_id:'personal-audio', response_id: response.id, delta: pcm});
            emit({type: 'response.output_audio_transcript.delta', event_id:'personal-text', response_id: response.id, delta: aiReply});
            emit({type: 'response.done', response: {...response, status:'completed'}});
          }
        },
        close() {
          if (this.readyState === 3) return;
          if (!soniox) closedLiveConnections++;
          this.readyState = 3;
          this.emit('close');
        },
        terminate() { this.close(); },
      });
      queueMicrotask(() => {
        ws.emit('open');
        if (realtime) emit({type:'session.created', session:{type:'realtime'}});
      });
      return ws;
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await page.goto('http://127.0.0.1:' + server.address().port);
    await expect(page.getByText('로컬 서버 연결됨')).toBeVisible();
    await expect(page.getByRole('button', {name: '개인 대화 시작'})).toBeDisabled();
    await page.getByLabel('개인 대화 제목', {exact: true}).fill(title);
    await page.getByRole('button', {name: '개인 대화 시작'}).click();
    const openai = page.getByLabel('OpenAI API 키', {exact: true});
    const soniox = page.getByLabel('Soniox API 키', {exact: true});
    await expect(openai).toHaveAttribute('type', 'password');
    await expect(soniox).toHaveAttribute('type', 'password');
    await openai.fill(openaiKey);
    await soniox.fill(sonioxKey);
    const saveResponse = page.waitForResponse(response => response.url().endsWith('/settings/keys'));
    await page.getByRole('button', {name: 'API 키 저장'}).click();
    const response = await saveResponse;
    expect(await response.json()).toEqual({ok: true, providers: {live: true, soniox: true, text: true}});
    await expect(page.getByText('API 키를 저장했습니다.')).toBeVisible();
    await expect(openai).toHaveValue('');
    await expect(soniox).toHaveValue('');
    await page.reload();
    await page.getByRole('button', {name: '설정', exact: true}).click();
    await expect(page.getByText('키 저장됨', {exact: true})).toHaveCount(2);
    await page.getByRole('button', {name: 'Sitenote 홈'}).click();
    await page.getByLabel('개인 대화 제목', {exact: true}).fill(title);
    await page.getByLabel('개인 대화 프로젝트', {exact: true}).fill(project);
    await page.getByRole('button', {name: '개인 대화 시작'}).click();
    const transcript = page.getByTestId('transcript-turn');
    await expect(transcript.filter({hasText: recorded})).toContainText('나');
    await expect(transcript).toHaveCount(1);
    await expect(page.getByTestId('ai-panel')).toContainText('대기 중');
    expect(sonioxConnections).toBe(1);
    expect(liveConnections).toBe(0);
    await page.getByRole('button', {name: 'AI에게 질문', exact: true}).click();
    await expect(page.getByTestId('ai-panel')).toContainText('질문 듣는 중');
    expect(aiQuestions).toEqual([]);
    questionSpoken = true;
    await expect(transcript.filter({hasText: aiReply})).toContainText('AI');
    await expect(transcript.filter({hasText: question})).toHaveCount(1);
    expect(liveConnections).toBe(1);
    expect(aiQuestions).toEqual([question]);
    expect(audioInput).toEqual([]);
    await page.getByRole('button', {name: 'AI 질문 닫기', exact: true}).click();
    await expect(page.getByTestId('ai-panel')).toContainText('대기 중');
    await expect(transcript.filter({hasText: resumedRecording})).toContainText('나');
    await expect(transcript).toHaveCount(4);
    expect(closedLiveConnections).toBe(1);
    expect(sonioxConnections).toBe(1);
    await page.getByRole('button', {name: '녹음 종료'}).click();
    await expect(page.getByRole('heading', {name: summary})).toBeVisible();
    await expect(page.getByRole('heading', {level: 1, name: title})).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('record-item')).toContainText(title);
    await expect(page.getByTestId('record-item')).toContainText(project);
    await page.getByRole('button', {name: '검색', exact: true}).click();
    await page.getByLabel('기록 검색').fill('납기');
    await page.getByRole('button', {name: '검색 실행'}).click();
    await page.getByRole('button', {name: new RegExp(recorded)}).click();
    await expect(page.getByTestId('transcript-turn').filter({hasText:recorded})).toBeVisible();
    const exportMarkdown = async () => {
      const downloadReady = page.waitForEvent('download');
      await page.getByRole('button', {name: /Markdown/}).click();
      return readFile(await (await downloadReady).path(), 'utf8');
    };
    const markdown = await exportMarkdown();
    expect(markdown).toContain(recorded);
    expect(markdown).toContain(aiReply);
    expect(markdown).toContain(resumedRecording);
    expect(markdown.split(question)).toHaveLength(2);
    const recordSettings = page.getByText('기록 설정', {exact:true});
    const meetingOptOut = page.getByRole('checkbox', {name:'회의에서 이 개인 기록 참고하지 않음', exact:true});
    const saveSettings = async () => {
      await page.getByRole('button', {name:'기록 설정 저장'}).click();
      await expect(page.getByText('기록을 업데이트했습니다.', {exact:true})).toBeVisible();
    };
    const reopenSettings = async () => {
      await page.reload();
      await expect(page.getByRole('heading', {level:1, name:title})).toBeVisible();
      await recordSettings.click();
    };
    await recordSettings.click();
    await expect(meetingOptOut).toBeVisible();
    await expect(meetingOptOut).not.toBeChecked();
    expect(parseTranscript(markdown).allowInMeetings).toBe(true);
    await meetingOptOut.check();
    await page.getByLabel('분류', {exact:true}).fill('업무 / 공급망');
    await saveSettings();
    await reopenSettings();
    await expect(meetingOptOut).toBeChecked();
    expect(parseTranscript(await exportMarkdown()).allowInMeetings).toBe(false);
    await meetingOptOut.uncheck();
    await saveSettings();
    await reopenSettings();
    await expect(meetingOptOut).toBeVisible();
    await expect(meetingOptOut).not.toBeChecked();
    expect(parseTranscript(await exportMarkdown()).allowInMeetings).toBe(true);
    await page.getByRole('button', {name:'Sitenote 홈'}).click();
    await page.getByLabel('개인 대화 제목', {exact:true}).fill(secondTitle);
    await page.getByRole('button', {name:'개인 대화 시작'}).click();
    await expect(page.getByTestId('transcript-turn').filter({hasText: recorded})).toBeVisible();
    await expect(page.getByTestId('transcript-turn')).toHaveCount(1);
    expect(sonioxConnections).toBe(2);
    expect(liveConnections).toBe(1);
    await page.getByRole('button', {name:'녹음 종료'}).click();
    await expect(page.getByRole('heading', {level:1, name:secondTitle})).toBeVisible();
    await page.getByRole('button', {name:'Sitenote 홈'}).click();
    await expect(page.getByTestId('record-item')).toHaveCount(2);
    await expect(page.getByTestId('category-folder')).toHaveCount(0);
    await page.getByRole('button', {name:'분류별', exact:true}).click();
    await expect(page.getByText('미분류', {exact:true})).toBeVisible();
    await page.getByRole('button', {name:'AI 자동 분류', exact:true}).click();
    await expect(page.getByText('안전 점검', {exact:true})).toBeVisible();
    expect(classified).toBe(true);
    await page.reload();
    await page.getByRole('button', {name:'분류별', exact:true}).click();
    await expect(page.getByText('업무', {exact:true})).toHaveCount(1);
    await expect(page.getByText('공급망', {exact:true})).toBeVisible();
    await expect(page.getByText('안전 점검', {exact:true})).toBeVisible();
    await page.getByRole('button', {name:'AI 분류 되돌리기', exact:true}).click();
    await expect(page.getByText('미분류', {exact:true})).toBeVisible();
    await expect(page.getByText('안전 점검', {exact:true})).toHaveCount(0);
    await expect(page.getByText('공급망', {exact:true})).toBeVisible();
    await expect(page.getByRole('button', {name:'AI 분류 되돌리기', exact:true})).toHaveCount(0);
    await page.getByRole('button', {name:'새 폴더', exact:true}).click();
    await page.getByLabel('폴더 경로', {exact:true}).fill('자료 / 완료 기록');
    await page.getByRole('button', {name:'폴더 만들기', exact:true}).click();
    await expect(page.getByText('완료 기록', {exact:true})).toBeVisible();
    await page.reload();
    await page.getByRole('button', {name:'분류별', exact:true}).click();
    const folder = page.getByText('완료 기록', {exact:true}).locator('xpath=ancestor::details[1]');
    await expect(folder).toBeVisible();
    await expect(folder.getByTestId('record-item')).toHaveCount(0);
    await folder.getByRole('button', {name:'기록 추가', exact:true}).click();
    await folder.getByRole('combobox', {name:'추가할 기록', exact:true}).selectOption({label:secondTitle});
    await folder.getByRole('button', {name:'선택한 기록 추가', exact:true}).click();
    await expect(folder.getByTestId('record-item')).toContainText(secondTitle);
    await expect(page.getByTestId('record-item')).toHaveCount(2);
    await expect(page.getByText('미분류', {exact:true})).toHaveCount(0);
    await page.getByRole('button', {name:'검색', exact:true}).click();
    await page.getByLabel('기록 검색').fill('공급망');
    await page.getByRole('button', {name:'검색 실행'}).click();
    await expect(page.getByRole('button', {name:new RegExp(title)})).toBeVisible();
  } finally {
    await page.close();
    await new Promise(done => server.close(done));
    await rm(tmp, {recursive: true, force: true});
  }
});
