import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTurn, createRecord, isOriginalSourceRef, isOriginalTurn, parseCategoryPath, parseTranscript, renameSpeaker, searchContext, searchRecords, speakerGroups, speakerLabel, transcriptMarkdown, turnEvidence, type RecordData, type Turn } from './core.ts';
import { parseSummary, summaryMarkdown } from './markdown.ts';
import { currentQuotedRefs, resolveOriginalSources, searchOriginalAnswers, searchPastOriginals } from '../recordContext.ts';

const date = '2026-11-20T01:02:03.000Z';
const make = (id: string, kind: RecordData['kind'] = 'meeting', title = id, project?: string) =>
  createRecord({ id, kind, title, project, now: date });
const turn = (id: string, text: string, extras: Partial<Turn> = {}): Turn =>
  ({ id, text, timeMs: 300, section: 'meeting', role: 'speaker', speakerId: '1', ...extras });

test('progressive updates replace versions and preserve roles, order, interruption and original time', () => {
  const base = make('r');
  const first = applyTurn(base, turn('speech', '초기'), date);
  const second = applyTurn(first, turn('speech', '수정'), date);
  const final = applyTurn(second, turn('answer', '제안합니다', { section: 'meeting-ai', role: 'ai', speakerId: undefined, interrupted: true, timeMs: 350 }), date);
  assert.deepEqual(final.turns.map(({ text, timeMs, interrupted }) => [text, timeMs, interrupted]), [['수정', 300, undefined], ['제안합니다', 350, true]]);
  assert.equal(first.turns[0]?.text, '초기');
  assert.equal(applyTurn(final, { ...final.turns[0]! }, date), final);
});

test('Markdown is the source: editable text round-trips with stable speaker and turn IDs', () => {
  const first = applyTurn(make('r', 'meeting', '회의 "</script>"'), turn('speech', '첫 줄\n\n> # **둘째 줄**\n<!-- sitenote-turn -->'), date);
  const renamed = renameSpeaker(first, '1', '김 담당', date);
  const followup = applyTurn(renamed, turn('followup', '개인적으로 설명합니다', { section: 'followup', role: 'user', speakerId: undefined, timeMs: 400 }), date);
  const markdown = transcriptMarkdown(followup);
  assert.match(markdown, /회의 후 보완 대화/);
  assert.match(markdown, /김 담당/);
  assert.match(markdown, /id="speech"/);
  assert.deepEqual(parseTranscript(markdown), followup);
  assert.equal(parseTranscript(markdown.replace('첫 줄', '외부에서 고침')).turns[0]?.text.split('\n')[0], '외부에서 고침');
  assert.equal(renameSpeaker(renamed, '1', '', date).speakers['1'], undefined);
  assert.equal(renamed.turns[0]?.speakerId, '1');
});

test('personal user and AI text persist separately without summary replacing either original', () => {
  const record = applyTurn(applyTurn(make('personal', 'personal'), turn('input', '내 아이디어', { section: 'personal', role: 'user', speakerId: undefined }), date), turn('output', 'AI 제안', { section: 'personal', role: 'ai', speakerId: undefined, timeMs: 500 }), date);
  assert.deepEqual(parseTranscript(transcriptMarkdown({ ...record, summary: 'summary' })).turns.map(({ role }) => role), ['user', 'ai']);
  const questions = ['담당자는 누구인가요?', '<!-- marker -->'];
  assert.deepEqual(parseSummary(summaryMarkdown('## 결정\n- 미정', questions)), { summary: '## 결정\n- 미정', questions });
  assert.deepEqual(parseSummary('## 직접 편집한 정리\n'), { summary: '## 직접 편집한 정리', questions: [] });
});

test('followup speakers are labeled by provider number without reusing meeting speaker names', () => {
  const meeting = turn('speaker', '회의 발언');
  const answer = turn('answer', '보충 답변', {section:'followup', speakerId:'followup:stream-a:1'});
  const record = renameSpeaker(applyTurn(applyTurn(make('r'), meeting), answer), '1', '회의 참가자');
  assert.equal(speakerLabel(record, answer), '발언자 미확인 (화자 1)');
  const renamed = renameSpeaker(record, 'followup:stream-a:1', '보충 참가자');
  assert.equal(speakerLabel(renamed, answer), '보충 참가자 (화자 1)');
  assert.equal(speakerLabel(renamed, meeting), '회의 참가자 (화자 1)');
  assert.deepEqual(parseTranscript(transcriptMarkdown(renamed)), renamed);
});

test('meeting speaker names remain scoped to their own connection and legacy labels still render', () => {
  const old = turn('old', '기존 발언');
  const before = turn('before', '먼저 들었습니다.', {speakerId:'meeting:stream-a:1'});
  const after = turn('after', '다시 연결했습니다.', {section:'meeting-ai',speakerId:'meeting:stream-b:1'});
  const initial = [old,before,after].reduce((record,item) => applyTurn(record,item,date),make('r'));
  const record = renameSpeaker(renameSpeaker(initial, '1', '기존 이름'), 'meeting:stream-a:1', '김 담당');
  assert.equal(speakerLabel(record, old), '기존 이름 (화자 1)');
  assert.equal(speakerLabel(record, before), '김 담당 (화자 1)');
  assert.equal(speakerLabel(record, after), '발언자 미확인 (화자 1)');
  assert.deepEqual(parseTranscript(transcriptMarkdown(record)),record);
});

test('speaker management groups each connection, distinguishes matching numbers, and renames all its archived turns', () => {
  const turns = [
    turn('m1', '첫 원문입니다.', {speakerId:'meeting:a:1', timeMs:300}),
    turn('m2', '다음 원문입니다.', {speakerId:'meeting:a:1', section:'meeting-ai', timeMs:350}),
    turn('m3', '재연결 뒤 발언입니다.', {speakerId:'meeting:b:1', timeMs:400}),
    turn('f1', '보충 답변 원문입니다.', {speakerId:'followup:c:1', section:'followup', timeMs:500}),
    turn('f2', '추가 보충 답변입니다.', {speakerId:'followup:c:1', section:'followup', timeMs:550}),
    turn('unknown', '화자 미확인 발언입니다.', {speakerId:undefined, timeMs:600}),
    turn('ai', 'AI 발언입니다.', {role:'ai', speakerId:undefined, timeMs:650}),
  ];
  const original = turns.reduce((record,item) => applyTurn(record,item,date),make('r'));
  assert.deepEqual(speakerGroups(original).map(({id, area, label, firstTurn, count}) => [id, area, label, firstTurn.id,count]), [
    ['meeting:a:1','meeting','화자 1 · 구분 1','m1',2],
    ['meeting:b:1','meeting','화자 1 · 구분 2','m3',1],
    ['followup:c:1','followup','화자 1','f1',2],
  ]);
  const renamed = renameSpeaker(renameSpeaker(original, 'meeting:a:1', ' 김 담당 ', date), 'followup:c:1', '이 참가자', date);
  const labels = renamed.turns.map(item => speakerLabel(renamed,item));
  assert.deepEqual(labels.slice(0, 5), ['김 담당 (화자 1)','김 담당 (화자 1)','발언자 미확인 (화자 1)','이 참가자 (화자 1)','이 참가자 (화자 1)']);
  assert.equal(turnEvidence(renamed,renamed.turns[4]!).speaker, '이 참가자 (화자 1)');
  assert.deepEqual(speakerGroups(renamed).map(({name}) => name), ['김 담당','','이 참가자']);
  const exported = transcriptMarkdown(renamed);
  assert.match(exported, /### .*김 담당/);
  assert.match(exported, /### .*이 참가자/);
  assert.deepEqual(parseTranscript(exported).turns, original.turns);
});

test('typed followup prompts and answers retain labels in Markdown; only answers can be original evidence', () => {
  const question = turn('question', '준공 날짜는?', {section:'followup', role:'user', speakerId:undefined, entry:'typed-question'});
  const answer = turn('answer', '준공 날짜는 9월 1일입니다.', {section:'followup', role:'user', speakerId:undefined, entry:'typed-answer', timeMs:350});
  const aiQuestion = {...question,id:'model-question',role:'ai' as const};
  const record = [question,answer,aiQuestion].reduce((previous,item) => applyTurn(previous,item,date),make('r'));
  const changed = applyTurn(record, {...answer, entry:undefined, text:'9월 2일입니다.'},date);
  assert.equal(changed.turns.find(item => item.id === answer.id)?.entry, 'typed-answer');
  assert.equal(isOriginalTurn(question), false);
  assert.equal(isOriginalTurn(answer), true);
  assert.equal(speakerLabel(record,question), '직접 입력한 질문');
  assert.equal(speakerLabel(record,answer), '직접 입력한 답변');
  assert.equal(speakerLabel(record,aiQuestion), 'AI 질문');
  assert.deepEqual(parseTranscript(transcriptMarkdown(changed)),changed);
  assert.throws(() => applyTurn(record,{...question,section:'meeting'}));
  assert.throws(() => applyTurn(record,{...answer,role:'ai'}));
  assert.throws(() => applyTurn(record,{...answer,role:'speaker'}));
  assert.throws(() => applyTurn(record,{...answer,entry:'manual' as Turn['entry']}));
});

test('the shared category path round-trips and library search finds either category level', () => {
  const record = {
    ...make('r', 'meeting', '현장 브리핑', '한강 제방'),
    category: parseCategoryPath('  업무 / 안전 관리  '),
  };
  assert.deepEqual(record.category, ['업무', '안전 관리']);
  assert.equal(parseCategoryPath(' '), undefined);
  assert.throws(() => parseCategoryPath('업무//회의'));
  assert.throws(() => parseCategoryPath('a/b/c/d'));
  assert.throws(() => parseCategoryPath('x'.repeat(46)));
  const exported = transcriptMarkdown(record);
  assert.deepEqual(parseTranscript(exported), record);
  assert.match(exported, /- 분류: 업무 \/ 안전 관리/);
  for (const query of ['안전 관리', '업무', '한강 제방', '브리핑']) {
    const [hit] = searchRecords([record], query, undefined, {library: true});
    assert.equal(hit?.recordId, record.id);
  }
  assert.equal(searchRecords([record], '안전 관리').length, 0);
});

test('unsafe IDs and corrupt metadata fail without treating an empty transcript as saved', () => {
  assert.throws(() => make('../unsafe'), /ID/);
  assert.throws(() => applyTurn(make('r'), turn('wrong#id', '새 값'), date), /ID/);
  assert.throws(() => parseTranscript('# No record metadata'), /메타데이터/);
  assert.throws(() => parseTranscript(transcriptMarkdown(make('r')).replace('2026-11-20T01:02:03.000Z', '???')), /시각/);
});

test('retrieval is scoped, searches original Korean and summaries, and links exact excerpts', () => {
  const baseline = applyTurn(make('r1', 'meeting', '변경 회의', 'A'), turn('a', '자재 공급이 밀려 배송일을 연기했다. 오너는 이미나.'), date);
  const update = applyTurn(make('r2', 'meeting', '후속 회의', 'A'), turn('b', '배송일을 다시 조정했다.'), date);
  const hidden = applyTurn({...make('private', 'personal', '개인', 'A'), allowInMeetings: false}, turn('secret', '배송일 변경 겸 비밀', { section: 'personal', role: 'user' }), date);
  const other = applyTurn(make('other', 'meeting', '다른 회의', 'B'), turn('x', '배송일을 연기했다.'), date);
  const fromSummary = { ...make('summarized', 'meeting', '특이사항', 'A'), summary: '## 미해결\n절토량 검증' };
  const records = [baseline, update, hidden, other, fromSummary];
  const scope = { mode: 'meeting', project: 'A' } as const;
  const found = searchRecords(records, '납기를 왜 변경했지?', scope);
  assert.deepEqual(new Set(found.map(({ recordId }) => recordId)), new Set(['r1', 'r2']));
  assert.equal(found.find(({ recordId }) => recordId === 'r1')?.reference, '[record:r1#a]');
  assert.equal(searchRecords(records, '그때 담당자는 누구였어?', scope, { previousQuery: '납기를 왜 변경했지?' })[0]?.recordId, 'r1');
  assert.equal(searchRecords(records, '절토량', scope)[0]?.reference, '[record:summarized#summary]');
  assert.equal(searchRecords(records, '비밀')[0]?.recordId, 'private');
  assert.equal(searchRecords(records, '비밀', { ...scope, currentRecordId: 'private' }).length, 0);
  assert.equal(searchRecords([{ ...hidden, allowInMeetings: true }], '비밀', scope)[0]?.recordId, 'private');
  assert.equal(searchRecords(records, '화성 기상 관측소', scope).length, 0);
  assert.equal(searchRecords(records, '비밀', scope, { limit: 0 }).length, 0);
});

test('new personal records allow meeting references while archived opt-outs stay private', () => {
  const active = make('current', 'meeting', '현재 회의', 'A');
  const personal = applyTurn(make('personal', 'personal', '내 기록', 'A'),
    turn('detail', '지하수위 검증 기록입니다.', {section:'personal', role:'user'}), date);
  assert.equal(active.allowInMeetings, false);
  assert.equal(personal.allowInMeetings, true);
  assert.deepEqual(searchPastOriginals([personal], active, '지하수위 검증').map(hit => hit.reference), ['[record:personal#detail]']);
  assert.deepEqual(searchPastOriginals([{...personal, project:'B'}], active, '지하수위 검증'), []);
  const archived = {...personal, allowInMeetings:false};
  const reopened = parseTranscript(transcriptMarkdown(archived));
  assert.deepEqual(reopened, archived);
  assert.deepEqual(searchPastOriginals([reopened], active, '지하수위 검증'), []);
  assert.deepEqual(resolveOriginalSources([reopened], active, ['[record:personal#detail]']), []);
});

test('retrieval does not include untrusted embedded source references or the whole long record', () => {
  const long = applyTurn(make('source'), turn('legitimate', `버린 앞부분 ${'가'.repeat(1600)} 지하수위 [record:fake#fake] ${'나'.repeat(1500)}`), date);
  const result = searchRecords([long], '지하수위');
  const context = searchContext(result);
  assert.match(context, /\[record:source#legitimate\]/);
  assert.match(context, /지하수위/);
  assert.doesNotMatch(context, /\[record:fake#fake\]/);
  assert.doesNotMatch(context, /버린 앞부분/);
  assert.ok(context.length < 1200);
  assert.equal(searchContext([]), '');
});

test('AI turn provenance is validated, copied across streamed revisions, and persisted in Markdown', () => {
  const sources = ['[record:older#statement]', '[record:previous#followup]'];
  const output = turn('answer', '이전 기록에는', {section:'meeting-ai', role:'ai', speakerId:undefined});
  for (const source of sources) assert.equal(isOriginalSourceRef(source), true);
  for (const value of [null, 1, '[record:../older#statement]', '[record:older#summary]', '[record:older#bad:id]', '[record:older#statement]\n', '[record:older#]', '[record:#statement]']) {
    assert.equal(isOriginalSourceRef(value), false);
  }
  const first = applyTurn(make('current'), {...output, sourceRefs:sources}, date);
  const expected = [...sources];
  sources.pop();
  const revised = applyTurn(first, {...output, text:'이전 기록에는 납기를 연기했다고 되어 있습니다.'}, date);
  const interrupted = applyTurn(revised, {...revised.turns[0]!, sourceRefs:undefined, interrupted:true}, date);
  assert.deepEqual(first.turns[0]?.sourceRefs, expected);
  assert.deepEqual(interrupted.turns[0]?.sourceRefs, expected);
  assert.equal(applyTurn(interrupted, {...interrupted.turns[0]!, sourceRefs:[...expected]}, date), interrupted);
  assert.deepEqual(parseTranscript(transcriptMarkdown(interrupted)), interrupted);
  for (const sourceRefs of [['wrong'], [expected[0]!, expected[0]!], [...expected, '[record:z#z]']]) {
    assert.throws(() => applyTurn(make('current'), {...output, sourceRefs}, date), /출처/);
  }
  assert.throws(() => applyTurn(make('current'), turn('speaker', '참가자 발언', {sourceRefs:expected}), date), /출처/);
});

test('verified quotation references stay a subset of source references across revisions and export', () => {
  const [first, second] = ['[record:older#statement]', '[record:previous#followup]'];
  const output = turn('answer', '인용합니다.', {section:'meeting-ai',role:'ai',speakerId:undefined});
  const initial = applyTurn(make('current'), {...output, sourceRefs:[first,second], quotedRefs:[first]}, date);
  const updated = applyTurn(initial, {...output, text:'인용 두 개입니다.',sourceRefs:[first,second],quotedRefs:[second]}, date);
  const interrupted = applyTurn(updated,{...output,text:'인용 두 개입니다.',interrupted:true},date);
  assert.deepEqual(interrupted.turns[0]?.quotedRefs,[first,second]);
  assert.deepEqual(parseTranscript(transcriptMarkdown(interrupted)),interrupted);
  const narrowed = applyTurn(interrupted, {...output,sourceRefs:[second]}, date);
  assert.deepEqual(narrowed.turns[0]?.quotedRefs,[second]);
  for (const quotedRefs of [[second], [first,first], ['not-a-ref']]) {
    assert.throws(() => applyTurn(make('current'), {...output,sourceRefs:[first],quotedRefs}, date), /출처/);
  }
});

test('past original search checks age, visibility and actual human wording rather than titles or generated notes', () => {
  const active = applyTurn(make('active', 'meeting', '현재', 'A'), turn('active-turn', '배송일을 연기했다.'), date);
  const approvedSource = { ...applyTurn(make('mutual', 'personal', '공유', ' a '), turn('human', '배송일을 연기했다.', {section:'personal', role:'user'}), date), allowInMeetings:true };
  const privateSource = {...approvedSource, id:'private', allowInMeetings:false};
  const future = {...approvedSource, id:'future', createdAt:'2026-11-21T01:02:03.000Z'};
  const otherProject = {...approvedSource, id:'other', project:'B'};
  const generated = applyTurn({...make('generated', 'meeting', '배송일 연기', 'A'), summary:'배송일을 연기했다.'}, turn('ai', '배송일을 연기했다.', {role:'ai'}), date);
  const speakerName = renameSpeaker(applyTurn(make('speaker', 'meeting', '일반 회의', 'A'), turn('notes', '확인했습니다.'), date), '1', '배송일 연기');
  const unrelated = applyTurn(make('unrelated', 'meeting', '배송일 연기', 'A'), turn('statement', '일정표를 출력했다.'), date);
  const found = searchPastOriginals([active, approvedSource, privateSource, future, otherProject, generated, speakerName, unrelated], active, '납기를 왜 변경했나요?');
  assert.deepEqual(found.map(item => item.reference), ['[record:mutual#human]']);
  assert.equal(searchPastOriginals([privateSource], make('mine', 'personal'), '납기 변경')[0]?.recordId, 'private');
  assert.equal(searchRecords([generated], '배송일 연기').length >= 1, true);
});

test('past original search requires more than one matching topic for detailed queries and uses genuine follow-up context', () => {
  const source = applyTurn(make('older'), turn('details', '지하수위 검증 책임자는 이대리이며 배송일을 조정했다.'), date);
  const other = applyTurn(make('other'), turn('details', '안전 검토 책임자는 박대리입니다.'), date);
  const active = make('active');
  assert.deepEqual(searchPastOriginals([source,other], active, '외벽 마감재 안전 검증'), []);
  assert.equal(searchPastOriginals([source,other], active, '지하수위 검증 담당자는 누구였어?')[0]?.recordId, 'older');
  assert.deepEqual(searchPastOriginals([other,source], active, '그때 담당자는 누구였어?', '지하수위 검증').map(hit => hit.recordId), ['older']);
  assert.deepEqual(searchPastOriginals([other,source], active, '그때 왜?', '지하수위 검증').map(hit => hit.recordId), ['older']);
});

test('explicit latest-meeting questions restrict to the last scoped meeting without changing normal topic ranking', () => {
  const at = (entry: RecordData, day: string) => ({...entry, createdAt: `2026-11-${day}T00:00:00.000Z`});
  const active = make('active', 'meeting', '현재', 'A');
  const latest = at(applyTurn(
    applyTurn(make('latest', 'meeting', '최근 회의', ' A '), turn('new', '배송일 조정 사유는 공급 지연입니다.')),
    turn('after', '나중에 확인한 장비 담당은 이미나입니다.', {section:'followup', timeMs:500})), '17');
  const old = at(applyTurn(make('old', 'meeting', '이전 회의', 'A'), turn('old', '납기 변경 사유는 허가 지연입니다.')), '10');
  const personal = at(applyTurn(make('personal', 'personal', '개인 기록', 'A'),
    turn('memo', '납기 변경 사유는 외부 발주입니다.', {role:'user', section:'personal'})), '18');
  const otherProject = at({...latest, id:'other', project:'B'}, '19');
  const empty = at(make('empty', 'meeting', '잘못 시작한 녹음', 'A'), '18');
  const future = {...latest, id:'future', createdAt:'2026-11-21T00:00:00.000Z'};
  const records = [old, otherProject, latest, empty, personal, future];
  assert.deepEqual(searchPastOriginals(records, active, '납기 변경').map(hit => hit.recordId), ['personal','old']);
  for (const question of ['최근 회의에서 뭐였지?', '지난 회의에서 납기 변경', '직전 회의에서 뭐라고 했지?', 'what happened at the last meeting?']) {
    assert.deepEqual(searchPastOriginals(records, active, question).map(hit => hit.reference), ['[record:latest#new]'], question);
  }
  assert.deepEqual(searchPastOriginals(records, active, '지난 회의에서 허가 지연은 왜?'), []);
  assert.deepEqual(searchPastOriginals(records, active, '지난 회의에서 장비 담당'), []);
  assert.deepEqual(searchPastOriginals(records, {...active, project:undefined}, '마지막 회의에서 뭐였지?').map(hit => hit.recordId), ['other']);
});

test('original search matches Korean particles on both sides and drops common spoken question scaffolding', () => {
  const source = applyTurn(make('original'), turn('said', '김민수는 현장소장입니다.'));
  const unrelated = applyTurn(make('other'), turn('different', '김민서와 현장소장실을 확인했습니다.'));
  const active = make('active');
  for (const question of ['김민수가 누구였지?', '현장소장이 누구야?', '혹시 김민수가 뭐라고 했지?']) {
    assert.deepEqual(searchPastOriginals([unrelated,source], active, question).map(hit => hit.reference), ['[record:original#said]'], question);
  }
  assert.deepEqual(searchPastOriginals([unrelated], active, '현장소장'), []);
});

test('standalone AI search returns original evidence only, including an owned personal record', () => {
  const generated = applyTurn({...make('generated'), summary:'현장소장입니다.'}, turn('ai', '현장소장입니다.', {role:'ai'}));
  const own = applyTurn({...make('own', 'personal'), allowInMeetings:false},
    turn('memo', '김민수는 현장소장입니다.', {role:'user', section:'personal'}));
  assert.deepEqual(searchOriginalAnswers([generated,own], '현장소장이 누구야?').map(hit => hit.reference), ['[record:own#memo]']);
  assert.deepEqual(searchOriginalAnswers([generated], '현장소장'), []);
});

test('stored citations resolve unique allowed human turns in order, with full original and no stale fallback', () => {
  const active = make('active', 'meeting', '현재', 'X');
  const text = `원문 그대로 ${'가'.repeat(850)}`;
  const meeting = applyTurn(applyTurn(make('older', 'meeting', '과거', 'X'), turn('human', text), date), turn('ai', '출처가 아닙니다.', {role:'ai'}), date);
  const personal = {...applyTurn(make('private', 'personal', '개인', 'X'), turn('human', '개인 원문', {role:'user'}), date), allowInMeetings:true};
  const activeWithTurn = applyTurn(active, turn('human', '회의 중'), date);
  const future = {...meeting, id:'future', createdAt:'2026-11-21T01:02:03.000Z'};
  const records = [activeWithTurn, meeting, personal, future, {...meeting,id:'other',project:'Y'}];
  const links = ['[record:older#summary]', '[record:older#ai]', '[record:active#human]', '[record:private#human]', '[record:older#deleted]', '[record:older#human]', '[record:older#human]', '[record:future#human]', '[record:other#human]', 'forged'];
  assert.deepEqual(resolveOriginalSources(records, active, links).map(hit => [hit.reference, hit.text]), [
    ['[record:private#human]', '개인 원문'], ['[record:older#human]', text],
  ]);
  assert.deepEqual(resolveOriginalSources([meeting,{...personal,allowInMeetings:false}], active, links).map(hit => hit.recordId), ['older']);
});

test('saved direct quotations must still match a unique currently available original', () => {
  const first = '[record:review-a#spoken]';
  const second = '[record:review-b#spoken]';
  const otherAnswer = '[record:review-c#spoken]';
  const quote = '방수막 재시험은 목요일 열 시입니다.';
  const unrelated = '안전 점검표는 회의실에서 받습니다.';
  const original = applyTurn(make('review-a'), turn('spoken', quote));
  const alternative = applyTurn(make('review-b'), turn('spoken', unrelated));
  const other = applyTurn(make('review-c'), turn('spoken', quote));
  const reply = turn('answer', '“방수막 재시험은 목요일  열 시입니다.” 「' + unrelated + '」', {
    role:'ai', sourceRefs:[first,second], quotedRefs:[first],
  });
  const active = applyTurn(make('current-review'), reply);
  const resolve = (...records: RecordData[]) =>
    resolveOriginalSources(records, active, [first, second, otherAnswer]);
  const intact = resolve(original, alternative, other);
  assert.deepEqual(currentQuotedRefs(reply, intact), [first], 'never upgrades a provided-only source, nor considers another answer’s sources');

  const corrected = applyTurn(original, turn('spoken', '방수막 재시험은 금요일 열두 시입니다.'));
  const current = resolve(corrected, alternative, other);
  assert.deepEqual(currentQuotedRefs(reply, current), []);
  assert.ok(current.some(({reference}) => reference === first), 'the corrected note remains a provided source');
  assert.deepEqual(currentQuotedRefs(reply, resolve(alternative)), [], 'a former quote cannot survive source removal');
  assert.deepEqual(currentQuotedRefs(reply, resolve(original, applyTurn(alternative, turn('spoken', quote)))), [],
    'an updated duplicate must not support an unambiguous direct attribution');
  assert.deepEqual(currentQuotedRefs({...reply, quotedRefs:undefined}, intact), []);
});
