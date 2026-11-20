import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRecord, renameSpeaker, type Turn} from './model.ts';
import {summaryWithSpeakerNames} from './summary-speakers.ts';
import {analysisContext} from '../recordContext.ts';

function meeting(summary?: string) {
  const voice = (id: string, speakerId: string, section: Turn['section'] = 'meeting'): Turn =>
    ({id,speakerId,section,role:'speaker',text:'원래 발언',timeMs:0});
  return {...createRecord({id:'meeting',kind:'meeting'}),summary,turns:[
    voice('main','meeting:a:1'),voice('other','meeting:b:1'),voice('followup','followup:c:1','followup'),
    voice('two','meeting:a:2'),
  ]};
}

test('speaker names resolve by cited turn or unique group and do not change underlying Markdown', () => {
  const summary = [
    '# 회의록',
    '- 화자 1이 점검합니다. [record:meeting#main]',
    '- **화자 2**: 검토.',
    '- 화자 1은 구분할 수 없습니다.',
    '- 화자 2가 확인했습니다. [record:past#old]',
    '- 통화자 2에게 전달합니다.',
    '- 화자 2의 메모입니다.',
    '- 화자 1이 확인했습니다. [record:meeting#main] [record:meeting#other]',
    '## 회의 후 보충 질문',
    '- 발언자 미확인 (화자 1)은 확인했습니다.',
    '> 화자 1을 그대로 인용',
    '- “화자 1”과 `화자 1`과 [화자 1](https://example.com)',
    '~~~',
    '화자 1',
    '~~~',
  ].join('\n');
  const original = meeting(summary);
  const edited = renameSpeaker(renameSpeaker(renameSpeaker(original, 'meeting:a:1', '하나'),
    'meeting:a:2', '길'), 'followup:c:1', '김 팀장');
  assert.equal(summaryWithSpeakerNames(edited), summary
    .replace('화자 1이 점검', '하나가 점검')
    .replace('**화자 2**', '**길**')
    .replace('화자 2의 메모', '길의 메모')
    .replace('발언자 미확인 (화자 1)은 확인', '김 팀장은 확인'));
  assert.equal(summaryWithSpeakerNames(renameSpeaker(edited, 'meeting:a:1', '민준'))?.includes('민준이 점검'),true);
  assert.equal(summaryWithSpeakerNames(renameSpeaker(edited, 'meeting:a:1', ''))?.includes('화자 1이 점검'),true);
  assert.equal(edited.summary, summary);
  assert.deepEqual(edited.turns, original.turns);
  assert.equal(summaryWithSpeakerNames(original),summary);
  assert.equal(summaryWithSpeakerNames(meeting()),undefined);
});

test('new summaries use stable speaker labels even after an actual name is entered', () => {
  const record = renameSpeaker(meeting(), 'meeting:a:1', '개인 이름');
  const context = analysisContext(record);
  assert.match(context, /\[record:meeting#main\][\s\S]*?"speaker":"화자 1"/);
  assert.doesNotMatch(context, /개인 이름/);
});
