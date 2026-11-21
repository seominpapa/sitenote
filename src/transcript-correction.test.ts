import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTranscriptCorrections, canCorrectTranscript, requestTranscriptCorrections } from './transcript-correction.ts';
import { applyTurn, createRecord, type Turn } from './records/model.ts';
import { parseTranscript, transcriptMarkdown } from './records/markdown.ts';
import { readableTranscript } from './records/export.ts';
import { searchContext, searchHumanOriginals } from './records/search.ts';

const speech: Turn = {id:'soniox-one',section:'meeting',role:'speaker',speakerId:'meeting:one:1',timeMs:1000,text:'방수 맛을 점검합니다.'};
const record = applyTurn(createRecord({id:'record-one',kind:'meeting',title:'방수 공사'}),speech);

test('correction retains original text, source location and export while making corrected terms searchable', async () => {
  const edits = await requestTranscriptCorrections({...record,turns:[speech,{...speech,id:'typed',role:'user'},{...speech,id:'soniox-ai',role:'ai'}]}, async data => {
    assert.deepEqual(data.turns,[{id:speech.id,text:speech.text}]);
    return {corrections:[{id:'other',text:'Ignored'},{id:speech.id,text:'방수막을 점검합니다.'}]};
  });
  const corrected = applyTranscriptCorrections(record,edits);
  const reopened = parseTranscript(transcriptMarkdown(corrected));
  assert.deepEqual(reopened.turns,[{...speech,correctedText:'방수막을 점검합니다.'}]);
  const evidence = searchHumanOriginals([reopened],'방수막');
  assert.deepEqual(evidence.map(item => [item.reference,item.text]),[['[record:record-one#soniox-one]',speech.text]]);
  assert.match(searchContext(evidence),/"correctedText":"방수막을 점검합니다."/u);
  assert.match(readableTranscript(reopened),/방수 맛을 점검합니다./u);
  assert.doesNotMatch(readableTranscript(reopened),/방수막을 점검/u);
  assert.equal(applyTurn(reopened,speech),reopened);
  const newer = applyTurn(reopened,{...speech,text:'방수 맛을 더 확인합니다.'});
  assert.equal(newer.turns[0].correctedText,undefined);
  assert.equal(applyTranscriptCorrections(newer,edits),newer);
});

test('long records send bounded chronological batches; rejects duplicate model edits', async () => {
  const long = {...record,turns:Array.from({length:43},(_,i) => ({...speech,id:`soniox-${i}`,timeMs:i}))};
  const ids: string[] = [];
  const edits = await requestTranscriptCorrections(long, async data => {
    assert.ok(data.turns.length <= 40);
    ids.push(...data.turns.map(row => row.id));
    const edit = {id:data.turns[0].id,text:'방수막을 점검합니다.'};
    return {corrections:[edit,edit]};
  });
  assert.deepEqual(ids,long.turns.map(row => row.id));
  assert.deepEqual(edits,[]);
  assert.equal(canCorrectTranscript({...long,originalFilename:'회의.docx'}),false);
});
