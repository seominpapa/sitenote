import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRecord, parseTranscript, speakerLabel, transcriptMarkdown, type Turn} from './core.ts';
import {correctMeetingSpeakers, undoMeetingSpeakerCorrection} from './speaker-correction.ts';

const first: Turn = {
  id:'soniox-a-1', role:'speaker', section:'meeting', text:'오늘 점검합니다.', correctedText:'오늘 점검을 합니다.',
  timeMs:2500, speakerId:'meeting:a:1',
};
const firstOther: Turn = {...first, id:'soniox-a-2', timeMs:5000};
const second: Turn = {...first, id:'soniox-b-1', timeMs:8000, speakerId:'meeting:b:2'};
const unassigned: Turn = {...first, id:'soniox-b-2', timeMs:11_000, speakerId:undefined};
const ai: Turn = {id:'ai-answer', role:'ai', section:'meeting-ai', text:'점검을 확인했습니다.', timeMs:15_000,
  sourceRefs:['[record:note1#soniox-a-1]']};
const followup: Turn = {...first, id:'soniox-c-1', section:'followup', speakerId:'followup:c:3', timeMs:18_000};
const record = {...createRecord({id:'note1',kind:'meeting'}), turns:[first,firstOther,second,unassigned,ai,followup],
  speakers:{[first.speakerId!]:'이 담당', [second.speakerId!]:'정 담당'}};

test('moves only selected utterances to a distinct new speaker and preserves anchors and text when reopened', () => {
  const result = correctMeetingSpeakers(record,[first,unassigned],{kind:'new',name:'  김 담당  '});
  assert(result.change);
  const saved = parseTranscript(transcriptMarkdown(result.record));
  assert.equal(speakerLabel(saved,saved.turns[0]),'김 담당 (화자 3)');
  assert.equal(saved.turns[3].speakerId,saved.turns[0].speakerId);
  assert.deepEqual({...saved.turns[0],speakerId:first.speakerId},first);
  assert.deepEqual(saved.turns[1],firstOther);
  assert.deepEqual(saved.turns[4],ai);
  assert.equal(record.turns[0],first);
});

test('moves to an existing meeting speaker, and undo keeps newer title, text and name edits', () => {
  const result = correctMeetingSpeakers(record,[first,unassigned],{kind:'existing',id:second.speakerId!});
  assert(result.change);
  const newer = {...result.record,title:'다른 탭에서 변경한 제목',
    speakers:{...result.record.speakers,[second.speakerId!]:'새 이름'},
    turns:result.record.turns.map(turn=>turn.id === first.id ? {...turn,correctedText:'새 보정'} : turn)};
  const restored = undoMeetingSpeakerCorrection(newer,result.change);
  assert.equal(restored.title,'다른 탭에서 변경한 제목');
  assert.equal(restored.turns[0].correctedText,'새 보정');
  assert.equal(restored.turns[0].speakerId,first.speakerId);
  assert.equal(restored.turns[3].speakerId,undefined);
  assert.equal(restored.speakers[second.speakerId!],'새 이름');
});

test('validates the entire selection and refuses stale moves or undo after a newer speaker edit', () => {
  assert.throws(()=>correctMeetingSpeakers(record,[first,ai],{kind:'new',name:''}));
  assert.throws(()=>correctMeetingSpeakers(record,[first,followup],{kind:'new',name:''}));
  assert.throws(()=>correctMeetingSpeakers({...record,originalFilename:'회의.pdf'},[first],{kind:'new',name:''}));
  assert.throws(()=>correctMeetingSpeakers(record,[first],{kind:'existing',id:followup.speakerId!}));
  const change = correctMeetingSpeakers(record,[first],{kind:'existing',id:second.speakerId!});
  assert(change.change);
  assert.throws(()=>correctMeetingSpeakers(change.record,[first],{kind:'new',name:''}),/다른 곳에서/);
  const newer = correctMeetingSpeakers(change.record,[change.record.turns[0]],{kind:'new',name:'박 과장'});
  assert.throws(()=>undoMeetingSpeakerCorrection(newer.record,change.change!),/다른 곳에서/);
});

test('undo removes the untouched added name but keeps one edited separately', () => {
  const result = correctMeetingSpeakers(record,[first],{kind:'new',name:'임 부장'});
  assert(result.change);
  const id = result.record.turns[0].speakerId!;
  const restored = undoMeetingSpeakerCorrection(result.record,result.change);
  assert(!Object.hasOwn(restored.speakers,id));
  const renamed = {...result.record,speakers:{...result.record.speakers,[id]:'직접 변경'}};
  assert.equal(undoMeetingSpeakerCorrection(renamed,result.change).speakers[id],'직접 변경');
  const untouched = correctMeetingSpeakers(record,[first],{kind:'existing',id:first.speakerId!});
  assert.equal(untouched.change,undefined);
  assert.equal(untouched.record,record);
});
