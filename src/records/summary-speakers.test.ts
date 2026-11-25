import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRecord, renameSpeaker, type Turn} from './model.ts';
import {parseSummary, parseTranscript, summaryMarkdown, transcriptMarkdown} from './markdown.ts';
import {buildSummarySpeakerLabels, summaryWithSpeakerNames} from './summary-speakers.ts';
import {analysisContext, liveContext} from '../recordContext.ts';

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

test('new summaries disambiguate labels across streams and keep names local', () => {
  const original = meeting();
  const record = renameSpeaker(renameSpeaker(renameSpeaker(original, 'meeting:a:1', '한 참가자'),
    'meeting:b:1', '김 참가자'), 'followup:c:1', '서 참가자');
  const labels = buildSummarySpeakerLabels(record);
  assert.deepEqual(labels, {'1':'meeting:a:1', '2':'meeting:a:2', '3':'meeting:b:1', '4':'followup:c:1'});
  const context = analysisContext(record);
  assert.match(context, /\[record:meeting#other\]\n[^\n]+"speaker":"화자 3"/);
  assert.match(context, /\[record:meeting#followup\]\n[^\n]+"speaker":"화자 4"/);
  assert.doesNotMatch(context, /참가자|meeting:b:1/);
  const summary = '- 화자 3이 확인. [record:meeting#other]\n- 화자 3이 답변. [record:meeting#main]\n- 화자 4의 확인. [record:meeting#followup]\n- 화자 3이 말했습니다.';
  const roundtrip = {...parseTranscript(transcriptMarkdown(record)), ...parseSummary(summaryMarkdown(summary, [], labels))};
  assert.equal(summaryWithSpeakerNames(roundtrip), summary.replace('화자 3이 확인','김 참가자가 확인').replace('화자 4의 확인','서 참가자의 확인'));
  assert.equal(summaryWithSpeakerNames(renameSpeaker(roundtrip,'meeting:b:1','박 팀장'))?.includes('박 팀장이 확인'),true);
  assert.match(summaryWithSpeakerNames(renameSpeaker(roundtrip,'meeting:b:1','')) ?? '', /화자 1 \(구분 2\)이 확인/);
});

test('stale summaries keep their original attribution and their stale status roundtrips', () => {
  const original = meeting('- 화자 1이 확인. [record:meeting#main]');
  const record = {...renameSpeaker(original,'meeting:a:1','한 참가자'),summaryNeedsSpeakerRefresh:true as const};
  const roundtrip = {...parseTranscript(transcriptMarkdown(record)), summary:record.summary, summarySpeakerLabels:buildSummarySpeakerLabels(record)};
  assert.equal(roundtrip.summaryNeedsSpeakerRefresh, true);
  assert.equal(summaryWithSpeakerNames(roundtrip),original.summary);
  assert.doesNotMatch(liveContext({...roundtrip, questions:['오래된 보충 질문']},true).context, /화자 1이 확인|오래된 보충 질문/);
  assert.match(liveContext({...roundtrip, summaryNeedsSpeakerRefresh:undefined},true).context, /화자 1이 확인/);
  assert.throws(() => parseSummary('<!-- sitenote-summary {"questions":[],"summarySpeakerLabels":{"1":"meeting:a:1","2":"meeting:a:1"}} -->\n\n요약'),/요약 메타데이터/);
});
