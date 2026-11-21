import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { speakerGroups, speakerLabel as recordSpeakerLabel, summarySourceAnchor, summarySourceEvidence, type Evidence, type RecordData, type Turn } from '../records/core';
import { summaryWithSpeakerNames } from '../records/summary-speakers';
import { currentQuotedRefs } from '../recordContext';
import { citationParts } from '../workflow';
import { Button, color, Field, Header, Notice, styles } from './base';
import { Supplement, type SupplementActions } from './Supplement';

export type Jump = (id: string, turnId?: string) => void;

export const dateLabel = (value: string) =>
  new Date(value).toLocaleString('ko-KR', {year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
export function clock(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
}

export function Home({records, connected, start, open, goSearch, goSettings, status, addDocument, working}: {
  records: RecordData[]; connected: boolean; start: (kind: RecordData['kind'], project?: string) => void;
  open: Jump; goSearch: () => void; goSettings: () => void; status?: string;
  addDocument?: (project: string) => Promise<boolean>; working: boolean;
}) {
  const [choosing, setChoosing] = useState(false);
  const [project, setProject] = useState('');
  const [adding, setAdding] = useState(false);
  const [documentProject, setDocumentProject] = useState('');
  const projects = [...new Set(records.map(record => record.project).filter((name): name is string => !!name))];
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, {paddingTop: 16}]}>
    <View style={styles.between}>
      <View style={{gap: 1, flexShrink: 1}}>
        <Text style={styles.label}>VOICE NOTEBOOK</Text><Text accessibilityRole="header" style={styles.title}>Sitenote</Text>
      </View>
      <View style={styles.row}><Button label="검색" onPress={goSearch}/><Button label="설정" onPress={goSettings}/></View>
    </View>
    <View style={{backgroundColor: color.dark, borderRadius: 25, padding: 20, gap: 12}}>
      <View style={[styles.between, {flexWrap: 'wrap'}]}>
        <Text style={[styles.label, {color: color.accent}]}>나의 음성 기록</Text>
        <Text style={[styles.small, {color: color.accent}]}>{connected ? '● 서버 설정됨' : '○ 서버 설정 필요'}</Text>
      </View>
      <Text accessibilityRole="header" style={[styles.title, {color: color.white}]}>오늘의 대화가{ '\n' }다음 대화의 기억으로.</Text>
      <Text style={[styles.body, {color: '#D9E8DD'}]}>혼자 떠올린 생각과 함께 나눈 결정을 목소리로 남겨 보세요.</Text>
      <View style={[styles.row, {width:'100%'}]}>
        <Button label="개인 대화 시작" variant="accent" onPress={() => start('personal')}/>
        <Button label={choosing ? '회의 설정 닫기' : '회의 시작'} onPress={() => setChoosing(!choosing)}/>
      </View>
    </View>
    {choosing && <View style={styles.card}>
      <Text style={styles.heading}>회의 검색 범위</Text>
      <Text style={styles.small}>프로젝트를 선택하면 같은 프로젝트의 과거 기록을 참고합니다. 공유를 허용한 개인 기록만 회의에서 볼 수 있습니다.</Text>
      <Field label="프로젝트 (선택)" value={project} onChangeText={setProject} maxLength={100} placeholder="선택하지 않으면 전체 회의 검색"/>
      {!!projects.length && <View style={styles.row}>{projects.map(name =>
        <Button key={name} label={name} onPress={() => setProject(name)}/>)}</View>}
      <View style={styles.row}><Button label="회의 전사 시작" variant="primary" onPress={() => start('meeting', project.trim() || undefined)}/></View>
    </View>}
    {status && <Notice text={status} />}
    <View style={[styles.between, {marginTop: 3}]}>
      <Text accessibilityRole="header" style={styles.heading}>최근 노트</Text>
      <Text style={styles.small}>{records.length}개 · 이 기기</Text>
    </View>
    {addDocument && (!adding ? <Button label="노트 추가" variant="primary" disabled={working} onPress={() => setAdding(true)}/> : <View style={styles.card}>
      <Text style={styles.heading}>회의 문서 가져오기</Text>
      <Text style={styles.small}>MD, TXT, DOCX, HWP, HWPX, 텍스트 PDF를 기기에서 변환합니다. AI가 참고할 때 관련 문서의 일부가 답변 요청에 포함될 수 있습니다.</Text>
      <Field label="프로젝트 (선택)" value={documentProject} onChangeText={setDocumentProject} maxLength={120}/>
      <View style={styles.row}>
        <Button label={working ? '가져오는 중…' : '파일 선택'} variant="primary" disabled={working} onPress={() => {
          void addDocument(documentProject.trim()).then(added => {
            if (added) { setAdding(false); setDocumentProject(''); }
          });
        }}/>
        <Button label="취소" disabled={working} onPress={() => setAdding(false)}/>
      </View>
    </View>)}
    {records.length === 0 && <View style={styles.card}>
      <Text style={styles.body}>아직 기록이 없어요.</Text><Text style={styles.small}>첫 대화가 끝나면 원문과 요약이 여기에 모입니다.</Text>
    </View>}
    {records.map(record => <Pressable key={record.id} accessibilityRole="button" onPress={() => open(record.id)}
      style={({pressed}) => [styles.card, {opacity: pressed ? 0.65 : 1}]}>
      <Text style={styles.label}>{record.originalFilename ? '가져온 문서' : record.kind === 'meeting' ? '회의' : '개인 대화'}{record.project ? ' · ' + record.project : ''}</Text>
      <Text style={styles.heading}>{record.title}</Text>
      <Text style={styles.small}>{dateLabel(record.createdAt)} · {record.originalFilename ?? `${record.turns.length}개 발언`} · {record.summary ? '요약 있음' : '원문'}</Text>
    </Pressable>)}
  </ScrollView>;
}

export function speakerLabel(turn: Turn, record: RecordData) {
  return recordSpeakerLabel(record,turn);
}

export function RichText({value, refs, jump}: {value: string; refs: Map<string, () => void>; jump?: (reference: string) => void}) {
  return <View style={{gap: 3}}>
    {value.split('\n').map((line, index) => {
      const heading = /^#{1,6}\s+/.test(line);
      const text = line.replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, '• ');
      if (!text) return <View key={index} style={{height: 6}}/>;
      return <Text accessibilityRole={heading ? 'header' : undefined} key={index} style={heading ? styles.heading : styles.body}>
        {citationParts(text, refs).map((part, position) => part.reference
          ? <Text key={position} accessibilityRole="link" accessibilityLabel="근거 원문 열기"
              onPress={jump ? () => jump(part.reference!) : refs.get(part.reference)}
              style={{color: color.primary, fontWeight: '800', textDecorationLine: 'underline'}}> 인용 ↗ </Text>
          : <Text key={position}>{part.text.replace(/\*\*([^*]+)\*\*/g, '$1')}</Text>)}
      </Text>;
    })}
  </View>;
}

export function evidenceRefs(evidence: readonly Evidence[], jump: Jump) {
  return new Map(evidence.map(item => [item.reference, () => jump(item.recordId, item.targetId ?? item.turnId)]));
}

function SourceList({items, jump, title}: {items: Evidence[]; jump: Jump; title: string}) {
  if (!items.length) return null;
  return <View style={styles.card}>
    <Text accessibilityRole="header" style={styles.heading}>{title}</Text>
    {items.map(item => <Pressable key={item.reference} accessibilityRole="link"
      onPress={() => jump(item.recordId, item.targetId ?? item.turnId)} style={{paddingVertical: 10, minHeight: 48}}>
      <Text style={[styles.body, {color: color.primary, fontWeight: '800'}]}>{item.title} ↗</Text>
      <Text style={styles.small}>{dateLabel(item.createdAt)}{item.originalFilename ? ' · 가져온 문서' : item.timeMs !== undefined ? ' · ' + clock(item.timeMs) : ' · 요약'}</Text>
      <Text numberOfLines={2} style={styles.small}>{item.text}</Text>
    </Pressable>)}
  </View>;
}

export function EvidenceList({items, jump, title = '답변에 제공한 원문'}: {items: Evidence[]; jump: Jump; title?: string}) {
  return <>
    <SourceList items={items.filter(item => !item.summaryOnly)} jump={jump} title={title}/>
    <SourceList items={items.filter(item => item.summaryOnly)} jump={jump} title="요약에만 있는 내용"/>
  </>;
}

export function AnswerSources({items, quoted, jump}: {items: Evidence[]; quoted: ReadonlySet<string>; jump: Jump}) {
  return <>
    <SourceList items={items.filter(item => !item.summaryOnly && quoted.has(item.reference))} jump={jump} title="답변이 직접 인용한 원문"/>
    <EvidenceList items={items.filter(item => item.summaryOnly || !quoted.has(item.reference))} jump={jump}/>
  </>;
}

export function TurnCard({turn, record, highlight = false, partial = false, onRename, sources = [], jump, openOriginal}: {
  turn: Turn; record: RecordData; highlight?: boolean; partial?: boolean;
  onRename?: (id: string) => void; sources?: Evidence[]; jump?: Jump; openOriginal?: () => void;
}) {
  const speaker = speakerLabel(turn, record);
  const document = record.originalFilename && turn.id.startsWith('import-');
  const attached = sources.filter(source => turn.sourceRefs?.includes(source.reference));
  const quoted = new Set(currentQuotedRefs(turn,attached));
  const corrected = !partial && turn.role !== 'ai' && turn.correctedText !== turn.text ? turn.correctedText : undefined;
  const [showRaw, setShowRaw] = useState(highlight);
  useEffect(() => { if (highlight) setShowRaw(true); }, [highlight]);
  return <View style={[styles.card, turn.role === 'ai' && {backgroundColor: '#EEF5DF'},
      highlight && {borderColor: color.primary, borderWidth: 2}, partial && {opacity: 0.7}]}>
    <View style={[styles.between, {flexWrap: 'wrap'}]}>
      <Text style={styles.label}>{speaker}{document ? '' : ' · ' + clock(turn.timeMs)}{partial ? ' · 전사 중' : ''}{turn.interrupted ? ' · 중단됨' : ''}{corrected ? ' · AI 보정' : ''}</Text>
      {onRename && turn.speakerId && <Button label="화자 이름" onPress={() => onRename(turn.speakerId!)}/>}
    </View>
    {turn.role === 'ai' ? <>
      <RichText value={turn.text} refs={jump ? evidenceRefs(attached.filter(item => quoted.has(item.reference)), jump) : new Map()}/>
      {jump && attached.length > 0 && <AnswerSources items={attached} quoted={quoted} jump={jump}/>}
    </> : <Text selectable style={styles.body}>{corrected || turn.text}</Text>}
    {corrected && <>
      <Pressable accessibilityRole="button" accessibilityState={{expanded:showRaw}} onPress={() => setShowRaw(value => !value)}
        style={{alignSelf:'flex-start',minHeight:44,justifyContent:'center'}}>
        <Text style={[styles.label,{textDecorationLine:'underline'}]}>{showRaw ? '보정 전 원문 닫기' : '보정 전 원문 보기'}</Text>
      </Pressable>
      {showRaw && <Text selectable style={styles.body}>{turn.text}</Text>}
    </>}
    {document && openOriginal && <Button label="원본 파일 열기" onPress={openOriginal}/>}
  </View>;
}

function SpeakerNames({record, working, rename}: {record: RecordData; working: boolean; rename(id: string): void}) {
  const [expanded, setExpanded] = useState(false);
  const groups = speakerGroups(record);
  if (!groups.length) return null;
  return <View style={styles.card}>
    <Button label={expanded ? '화자 이름 관리 닫기' : `화자 이름 관리 · ${groups.length}개 그룹`}
      onPress={() => setExpanded(!expanded)} disabled={working}/>
    {expanded && <>
      <Text style={styles.small}>한 그룹의 모든 발언에 이름을 적용합니다. 녹음 연결이 달라지면 같은 번호라도 동일인인지 확인할 수 없습니다.</Text>
      {(['meeting','followup'] as const).map(area => {
        const speakers = groups.filter(group => group.area === area);
        return speakers.length ? <View key={area} style={{gap:8}}>
          <Text accessibilityRole="header" style={styles.heading}>{area === 'followup' ? '회의 후 보충 대화' : '회의 원문'}</Text>
          {speakers.map(({id,label,name,firstTurn,count}) => <View key={id} style={{gap:3}}>
            <Button label={`${label} · ${name || '발언자 미확인'} 이름 수정`} onPress={() => rename(id)} disabled={working}/>
            <Text style={styles.small}>첫 발언 {clock(firstTurn.timeMs)} · {count}개 발언</Text>
            <Text style={styles.small} numberOfLines={2}>{firstTurn.text}</Text>
          </View>)}
        </View> : null;
      })}
    </>}
  </View>;
}

const sections = {personal: '개인 대화', meeting: '회의 원문', 'meeting-ai': '회의 중 AI 질의응답', followup: '회의 후 보완 대화'};

export function Details({record, focus, back, update, remove, exportOne, audioFiles, exportAudio, rename, summary,
  correctTranscript, followup, supplement, refs, sources, jump, working, status, openOriginal}: {
  record: RecordData; focus?: string; back: () => void;
  update: (fields: Pick<RecordData, 'title'|'project'|'allowInMeetings'>) => Promise<void>;
  remove: () => void; exportOne: () => void; rename: (id: string) => void; summary: () => void;
  correctTranscript?: () => void;
  followup: () => void; supplement: SupplementActions; refs: Map<string, () => void>; working: boolean; status?: string;
  sources: Evidence[]; jump: Jump;
  openOriginal: () => void;
  audioFiles: () => {name: string; uri: string}[]; exportAudio: (uri: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(record.title);
  const [project, setProject] = useState(record.project || '');
  const [excludedFromMeetings, setExcludedFromMeetings] = useState(!record.allowInMeetings);
  const summaryTarget = focus && (focus === 'summary' || summarySourceAnchor.test(focus));
  const [tab, setTab] = useState<'summary'|'transcript'|'followup'>(focus && !summaryTarget ? 'transcript' : 'summary');
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const [showAudio, setShowAudio] = useState(false);
  const positions = useRef<Record<string, number>>({});
  useEffect(() => {
    if (focus && !summaryTarget) {
      setTab('transcript');
      if (positions.current[focus] !== undefined) scroll.current?.scrollTo({y: positions.current[focus], animated: true});
    } else setTab('summary');
  }, [record.id, focus, summaryTarget]);
  const visible = tab === 'followup' ? record.turns.filter(turn => turn.section === 'followup') : record.turns;
  const meeting = record.kind === 'meeting' && !record.originalFilename;
  return <>
    <Header title={record.title} sub={record.originalFilename || (meeting ? '회의 기록' : '개인 기록')} onBack={back}/>
    <ScrollView ref={scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets>
      <Text style={styles.small}>{dateLabel(record.createdAt)}{record.project ? ' · ' + record.project : ''}</Text>
      <View style={styles.row}>
        <Button label="요약" variant={tab === 'summary' ? 'primary' : 'outline'} onPress={() => setTab('summary')} disabled={working}/>
        <Button label="원문" variant={tab === 'transcript' ? 'primary' : 'outline'} onPress={() => setTab('transcript')} disabled={working}/>
        {meeting && <Button label="보완 대화" variant={tab === 'followup' ? 'primary' : 'outline'} onPress={() => setTab('followup')} disabled={working}/>}
      </View>
      {correctTranscript && <View style={styles.card}>
        <Button label="전사 보정" onPress={() => {setTab('transcript'); correctTranscript();}} disabled={working}/>
        <Text style={styles.small}>전사 보정을 누르면 이 기록의 발언을 OpenAI에 보냅니다. 보정 전 원문은 그대로 보관합니다.</Text>
      </View>}
      {meeting && <View style={tab === 'followup' ? undefined : {display:'none'}}>
        <Supplement record={record} actions={supplement} working={working}/>
      </View>}
      {status && <Notice text={status}/>}
      <SpeakerNames record={record} working={working} rename={rename}/>
      {tab === 'summary' ? <View style={styles.card}>
        {focus && summarySourceEvidence(record,focus) && <Text style={styles.label}>요약에만 있는 내용 · 원문에서 확인되지 않았습니다.</Text>}
        {record.summary ? <RichText value={summaryWithSpeakerNames(record) ?? record.summary} refs={refs}/> : <Text style={styles.body}>저장된 요약이 없습니다.</Text>}
        {!!record.questions?.length && <><Text style={styles.heading}>확인할 사항</Text>{record.questions.map((question, index) =>
          <Text key={index} style={styles.body}>• {question}</Text>)}</>}
        <View style={styles.row}>
          <Button label={working ? '요약 생성 중…' : record.summary ? '요약 다시 만들기' : '요약 만들기'}
            onPress={summary} disabled={working || !record.turns.length}/>
          {meeting && <Button label="음성으로 보완하기" variant="primary" onPress={followup}
            disabled={working || !record.summary}/>}
          {meeting && <Button label="글로 보완하기" onPress={() => setTab('followup')} disabled={working}/>}
          {record.originalFilename && <Button label="원본 파일 열기" onPress={openOriginal} disabled={working}/>}
        </View>
      </View> : visible.length ? visible.map((turn, index) =>
        <View key={turn.id} onLayout={event => {
          const y = event.nativeEvent.layout.y;
          positions.current[turn.id] = y;
          if (focus === turn.id) scroll.current?.scrollTo({y, animated: false});
        }} style={{gap: 6}}>
          {turn.section !== visible[index - 1]?.section && <Text accessibilityRole="header" style={styles.heading}>{record.originalFilename ? '문서 본문' : sections[turn.section]}</Text>}
          <TurnCard turn={turn} record={record} highlight={focus === turn.id} sources={sources} jump={jump}
            openOriginal={focus === turn.id || (!focus && index === 0) ? openOriginal : undefined}/>
        </View>) : <Notice text="이 구간에는 저장된 발언이 없습니다."/>}
      {editing && <View style={styles.card}>
        <Field label="기록 제목" value={title} onChangeText={setTitle} maxLength={120}/>
        <Field label="프로젝트" value={project} onChangeText={setProject} maxLength={100}/>
        {record.kind === 'personal' && <View style={styles.between}>
          <Text style={[styles.body, {flexShrink: 1}]}>회의에서 이 개인 기록 참고하지 않음</Text>
          <Switch accessibilityLabel="회의에서 이 개인 기록 참고하지 않음" value={excludedFromMeetings} onValueChange={setExcludedFromMeetings}/>
        </View>}
        <View style={styles.row}><Button label="수정 저장" variant="primary" disabled={!title.trim() || working} onPress={() => {
          void update({title: title.trim(), project: project.trim() || undefined, allowInMeetings: !excludedFromMeetings})
            .then(() => setEditing(false)).catch(() => {});
        }}/></View>
      </View>}
      <View style={styles.row}>
        <Button label={editing ? '수정 닫기' : '기록 수정'} onPress={() => setEditing(!editing)} disabled={working}/>
        <Button label="파일 내보내기" onPress={exportOne} disabled={working}/>
        {!record.originalFilename && <Button label={showAudio ? '음성 사본 접기' : '음성 사본 보기'} onPress={() => setShowAudio(!showAudio)} disabled={working}/>}
        <Button label="기록 삭제" variant="danger" onPress={remove} disabled={working}/>
      </View>
      {showAudio && <AudioList files={audioFiles} exportAudio={exportAudio}/>}
    </ScrollView>
  </>;
}

function AudioList({files, exportAudio}: {files: () => {name: string; uri: string}[]; exportAudio: (uri: string) => void}) {
  try {
    const clips = files();
    if (!clips.length) return <Notice text="저장된 음성 사본이 없습니다."/>;
    return <View style={styles.card}><Text style={styles.heading}>음성 사본</Text>
      {clips.map((file, index) => <Button key={file.uri} label={`음성 사본 ${index + 1} 공유`} onPress={() => exportAudio(file.uri)}/>)}
    </View>;
  } catch {
    return <Notice text="음성 사본 목록을 읽지 못했습니다." danger/>;
  }
}
