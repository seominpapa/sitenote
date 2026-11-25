import {speakerDisplayId, speakerGroups, type RecordData, type Turn} from './model.ts';

type Selection = Pick<Turn,'id'|'speakerId'>;
export type SpeakerTarget = {kind:'existing'; id:string} | {kind:'new'; name:string};
export type SpeakerCorrectionChange = {
  recordId: string;
  previous: readonly Selection[];
  targetId: string;
  addedName?: string;
};

export function canCorrectMeetingSpeaker(record:RecordData, turn:Turn): boolean {
  return record.kind === 'meeting' && !record.originalFilename &&
    turn.role === 'speaker' && turn.section === 'meeting' && !turn.entry && !turn.id.startsWith('import-') && Boolean(turn.text.trim());
}

function checkedTurns(record:RecordData, selection:readonly Selection[], expectedTarget?:string): Turn[] {
  const byId = new Map(record.turns.map(turn => [turn.id,turn]));
  const ids = new Set(selection.map(item => item.id));
  if (!ids.size || ids.size !== selection.length) throw Error('옮길 발언을 선택해 주세요.');
  return selection.map(item => {
    const turn = byId.get(item.id);
    if (!turn || !canCorrectMeetingSpeaker(record,turn)) throw Error('회의 원문에서 녹음된 발언만 선택할 수 있습니다.');
    if (turn.speakerId !== (expectedTarget ?? item.speakerId)) {
      throw Error('다른 곳에서 화자가 변경됐습니다. 현재 화자를 확인한 뒤 다시 시도해 주세요.');
    }
    return turn;
  });
}

export function meetingSpeakerTargets(record:RecordData) {
  const available = new Set(record.turns.filter(turn => canCorrectMeetingSpeaker(record,turn)).map(turn => turn.speakerId));
  return speakerGroups(record).filter(group => available.has(group.id));
}

function newSpeakerId(record:RecordData): string {
  const used = new Set([...Object.keys(record.speakers), ...record.turns.flatMap(turn => turn.speakerId ? [turn.speakerId] : [])]
    .filter(id => !id.startsWith('followup:')).map(speakerDisplayId));
  let number = 1;
  while (used.has(String(number))) number++;
  return `meeting:manual:${number}`;
}

export function correctMeetingSpeakers(record:RecordData, selection:readonly Selection[], target:SpeakerTarget): {
  record: RecordData;
  change?: SpeakerCorrectionChange;
} {
  const selected = checkedTurns(record,selection);
  if (target.kind === 'existing' && !meetingSpeakerTargets(record).some(group => group.id === target.id)) {
    throw Error('이 회의 원문에 있는 화자를 선택해 주세요.');
  }
  const name = target.kind === 'new' ? target.name.trim() : '';
  if (name.length > 100) throw Error('이름은 100자 이하로 입력해 주세요.');
  const targetId = target.kind === 'new' ? newSpeakerId(record) : target.id;
  const changed = selected.filter(turn => turn.speakerId !== targetId);
  if (!changed.length) return {record};
  const ids = new Set(changed.map(turn => turn.id));
  return {
    record:{...record, updatedAt:new Date().toISOString(), ...(record.summary && {summaryNeedsSpeakerRefresh:true}),
      ...(name && {speakers:{...record.speakers,[targetId]:name}}),
      turns:record.turns.map(turn => ids.has(turn.id) ? {...turn,speakerId:targetId} : turn)},
    change:{recordId:record.id, previous:changed.map(({id,speakerId}) => ({id,speakerId})), targetId,
      ...(name && {addedName:name})},
  };
}

export function undoMeetingSpeakerCorrection(record:RecordData, change:SpeakerCorrectionChange): RecordData {
  if (record.id !== change.recordId) throw Error('이 회의의 화자 변경만 되돌릴 수 있습니다.');
  checkedTurns(record,change.previous,change.targetId);
  const previous = new Map(change.previous.map(turn => [turn.id,turn.speakerId]));
  const turns = record.turns.map((turn): Turn => {
    if (!previous.has(turn.id)) return turn;
    const speakerId = previous.get(turn.id);
    if (speakerId !== undefined) return {...turn,speakerId};
    const {speakerId:_removed,...unassigned} = turn;
    return unassigned;
  });
  const removeName = change.addedName !== undefined && record.speakers[change.targetId] === change.addedName &&
    !turns.some(turn => turn.speakerId === change.targetId);
  return {...record, updatedAt:new Date().toISOString(), turns, ...(record.summary && {summaryNeedsSpeakerRefresh:true}), ...(removeName && {
    speakers:Object.fromEntries(Object.entries(record.speakers).filter(([id]) => id !== change.targetId)),
  })};
}
