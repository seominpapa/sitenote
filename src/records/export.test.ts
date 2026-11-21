import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNoteExport, buildNotesExport, noteFolderName, readableTranscript } from './export.ts';
import { createRecord, type RecordData } from './model.ts';

function files(bytes: Uint8Array) {
  const data = Buffer.from(bytes);
  const entries = new Map<string,string>();
  let index = 0;
  while (data.readUInt32LE(index) === 0x04034b50) {
    const size = data.readUInt32LE(index + 18);
    const nameLength = data.readUInt16LE(index + 26);
    const extraLength = data.readUInt16LE(index + 28);
    const name = data.toString('utf8',index + 30,index + 30 + nameLength);
    index += 30 + nameLength + extraLength;
    entries.set(name,data.toString('utf8',index,index + size));
    index += size;
  }
  assert.equal(data.readUInt32LE(index),0x02014b50);
  return entries;
}

function note(id: string, day: number, title: string): RecordData {
  const now = new Date(2026,10,day,0,15).toISOString();
  return createRecord({id, kind:'meeting', title, now, project:'내보내지 않을 프로젝트'});
}

test('export splits readable original and summary, drops private storage tags and uses local note dates', () => {
  const first: RecordData = {
    ...note('secret-record-id',2,'공급 일정'),
    speakers:{'meeting:secret-session:1':'예시담당자'},
    turns:[
      {id:'secret-turn',section:'meeting',role:'speaker',speakerId:'meeting:secret-session:1',timeMs:1_000,text:'수요일에 공급합니다.\n수량은 3개입니다.'},
      {id:'other-turn',section:'meeting',role:'speaker',speakerId:'secret-speaker',timeMs:2_000,text:'세부 조건은 A < B & C.'},
      {id:'third-turn',section:'meeting',role:'speaker',speakerId:'meeting:secret-session:3',timeMs:3_000,text:'맞습니다.'},
      {id:'ai-turn',section:'meeting-ai',role:'ai',timeMs:5_000,text:'기존 일정과 같습니다.',sourceRefs:['[record:secret-record-id#secret-turn]']},
    ],
    summary:'<!-- sitenote-summary {"questions":["private"]} -->\n## 결정\n- 화자 1이 수요일 공급을 확정함. [record:secret-record-id#secret-turn]',
    questions:['private'],
  };
  const second: RecordData = {
    ...note('second',21,'후속 회의'),
    turns:[{id:'followup',section:'followup',role:'user',entry:'typed-answer',timeMs:0,text:'승인했습니다.'}],
  };
  const archive = buildNotesExport([second, first]);
  const stem = 'sitenote_(2026-11-02~2026-11-21)';
  assert.equal(archive.filename,stem + '.zip');
  const unpacked = files(archive.bytes);
  assert.deepEqual([...unpacked.keys()],[stem+'_원문.md',stem+'_요약.md']);
  const raw = unpacked.get(stem+'_원문.md')!;
  const summary = unpacked.get(stem+'_요약.md')!;
  assert.match(raw, /# 공급 일정[\s\S]*예시담당자[\s\S]*> 수요일에 공급합니다\.\n> 수량은 3개입니다\.[\s\S]*기존 일정과 같습니다\.[\s\S]*# 후속 회의[\s\S]*승인했습니다\./);
  assert.match(raw, /발언자 미확인[\s\S]*A &lt; B &amp; C\.[\s\S]*화자 3/);
  assert.match(summary,/공급 일정[\s\S]*예시담당자가 수요일 공급을 확정함\./);
  assert.doesNotMatch(summary,/후속 회의|기존 일정과 같습니다/);
  for (const text of unpacked.values()) {
    assert.doesNotMatch(text,/sitenote-(?:record|turn|summary)|secret-(?:record-id|turn|session|speaker)|<a |내보내지 않을 프로젝트|private/);
  }
});

test('one day uses one date and a missing summary still yields an independent Markdown file', () => {
  const archive = buildNotesExport([note('one',3,'제목')]);
  assert.equal(archive.filename,'sitenote_(2026-11-03).zip');
  assert.equal(files(archive.bytes).get('sitenote_(2026-11-03)_요약.md'),'저장된 요약이 없습니다.\n');
  assert.throws(() => buildNotesExport([]), /내보낼/);
});

test('single-note Markdown and folder name use the local date and readable title', () => {
  const record: RecordData = {
    ...note('private-record-001', 3, '회의: 현장/작업?'),
    speakers:{'meeting:private-session:1':'테스트 화자'},
    turns:[
      {id:'private-turn',section:'meeting',role:'speaker',speakerId:'meeting:private-session:1',timeMs:4000,
        text:'안전 점검을 했습니다. [record:private-record-001#private-turn]\n<!-- sitenote-turn {"id":"secret"} -->'},
    ],
    summary:'## 요약\n- 점검 완료. [record:private-record-001#private-turn]',
  };
  const {filename, markdown} = buildNoteExport(record);
  assert.equal(filename, '20261103_회의 현장 작업.md');
  assert.equal(noteFolderName(record), '20261103_회의 현장 작업');
  assert.match(markdown, /### 00:00:04 · 테스트 화자 \\\(화자 1\\\)/u);
  assert.match(markdown, /점검 완료/u);
  assert.doesNotMatch(markdown, /sitenote-turn|private-|<a |기록 ID/u);
  assert.ok(Buffer.byteLength(noteFolderName({...record, title:'회의😀'.repeat(100)})) <= 180);
});

test('imported document transcript is the Markdown body with its existing headings', () => {
  const record: RecordData = {
    ...note('imported', 3, '업로드 파일'), originalFilename:'업로드 파일.docx',
    turns:[{id:'import-1',section:'meeting',role:'speaker',timeMs:0,text:'# 원래 제목\n\n내용 A'},
      {id:'import-2',section:'meeting',role:'speaker',timeMs:1,text:'내용 B'}],
  };
  assert.equal(readableTranscript(record), '# 원래 제목\n\n내용 A\n\n내용 B');
  assert.doesNotMatch(buildNoteExport(record).markdown, /화자|### 00:/u);
});
