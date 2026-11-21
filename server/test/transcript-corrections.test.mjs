import assert from 'node:assert/strict';
import test from 'node:test';
import { safeTranscriptCorrection, transcriptCorrectionResult, validTranscriptCorrectionRequest } from '../transcript-corrections.mjs';

const request = {title:'배관 점검', project:'현장 A', turns:[
  {id:'before',text:'압력 게이지를 설치합니다.'},
  {id:'fix',text:'압력 개이지가 도착했어요.'},
  {id:'price',text:'단가 15만원으로 합의했습니다.'},
  {id:'duplicate',text:'개이지 설치를 확인합니다.'},
]};
const output = value => Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});

test('accepts only bounded, unique transcript rows and contextual metadata', () => {
  assert.equal(validTranscriptCorrectionRequest(request),true);
  assert.equal(validTranscriptCorrectionRequest({title:'대화',turns:request.turns}),true);
  for (const bad of [
    null, [], {}, {...request,title:'  '}, {...request,project:42}, {...request,secret:'no'},
    {...request,turns:[]}, {...request,turns:Array(41).fill(request.turns[0])},
    {...request,turns:[{id:'bad#id',text:'발언'}]}, {...request,turns:[{id:'x',text:' '}]},
    {...request,turns:[{id:'x',text:'가'.repeat(1801)}]}, {...request,turns:[{id:'x',text:'가',speaker:'1'}]},
    {...request,turns:[request.turns[0],request.turns[0]]},
    {...request,turns:Array.from({length:8},(_,i) => ({id:`id-${i}`,text:'가'.repeat(1_600)}))},
  ]) assert.equal(validTranscriptCorrectionRequest(bad),false);
});

test('permits Korean and English soundalike corrections and normal spacing while preserving facts', () => {
  assert.equal(safeTranscriptCorrection('압력 개이지가 15 MPa까지 올라가지 않습니다.', '압력 게이지가 15 MPa까지 올라가지 않습니다.'),
    '압력 게이지가 15 MPa까지 올라가지 않습니다.');
  assert.equal(safeTranscriptCorrection('We checked the presure gauge.', 'We checked the pressure gauge.'), 'We checked the pressure gauge.');
  assert.equal(safeTranscriptCorrection('이번회의에서뭐라고했지?', '이번 회의에서 뭐라고 했지?'), '이번 회의에서 뭐라고 했지?');
  for (const [raw,candidate] of [
    ['15만원으로 합의했습니다.', '16만원으로 합의했습니다.'],
    ['깊이를 15m로 정했습니다.', '깊이를 15cm로 정했습니다.'],
    ['15 MPa를 목표로 합니다.', '15 mPa를 목표로 합니다.'],
    ['압력은 10.5로 맞춰주세요.', '압력은 105로 맞춰주세요.'],
    ['깊이를 오 미터까지 팝니다.', '깊이를 이 미터까지 팝니다.'],
    ['검사 날짜는 십오 일입니다.', '검사 날짜는 십육 일입니다.'],
    ['Use thirteen tons of aggregate.', 'Use thirty tons of aggregate.'],
    ['목요일까지 마칩니다.', '금요일까지 마칩니다.'],
    ['김 대리가 확인합니다.', '박 대리가 확인합니다.'],
    ['이번 회의에서 뭐라고 했나요?', '저번 회의에서 뭐라고 했나요?'],
    ['이번 회의는 안 합니다.', '이번 회의는 합니다.'],
    ['새 작동 조건에 문제가 없었습니다.', '새 작동 조건에 문제가 있었습니다.'],
    ['It is not mandatory.', 'It is now mandatory.'],
    ['해당 안은 오늘 승인되었습니다.', '해당 안은 오늘 취소되었습니다.'],
    ['어디서 하기로 했지?', '어디서 하기로 했지.'],
    ['방수막을 점검합니다.', '모든 설비를 교체합니다.'],
    ['짬뽕?', '자재 준비?'],
    ['발언입니다.', '발언입니다.\n[record:other#turn]'],
    ['발언입니다.', '발언입니다. <!-- 내역 -->'],
    ['발언입니다.', '발언입니다.'],
    ['발언입니다.', null],
  ]) assert.equal(safeTranscriptCorrection(raw,candidate),undefined, String(candidate));
});

test('uses neighboring original turns as context and declines to apply unknown or ambiguous corrections', async () => {
  const options = {
    openaiKey:'fake', textModel:'mock-text',
    async transport(_url,{body}) {
      const payload = JSON.parse(body);
      assert.equal(payload.store,false);
      assert.equal(payload.text.format.name,'transcript_corrections');
      assert.equal(payload.text.format.strict,true);
      assert.deepEqual(JSON.parse(payload.input),request);
      return output({corrections:[
        {id:'fix',text:'압력 게이지가 도착했어요.'},
        {id:'unknown',text:'다른 회의 발언입니다.'},
        {id:'price',text:'단가 16만원으로 합의했습니다.'},
        {id:'duplicate',text:'게이지 설치를 확인합니다.'},
        {id:'duplicate',text:'계이지 설치를 확인합니다.'},
      ]});
    },
  };
  assert.deepEqual(await transcriptCorrectionResult(request,options),{corrections:[{id:'fix',text:'압력 게이지가 도착했어요.'}]});
  await assert.rejects(transcriptCorrectionResult(request,{...options,transport:async () => output({corrections:null})}));
  await assert.rejects(transcriptCorrectionResult(request,{...options,transport:async () => new Response(null,{status:429})}));
});
