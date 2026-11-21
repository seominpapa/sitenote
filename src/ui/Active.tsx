import { useRef, type ComponentRef } from 'react';
import { Modal, ScrollView, Text, View } from 'react-native';
import type { Evidence, RecordData } from '../records/core';
import type { createVoiceSession } from '../session/session';
import { Button, color, Notice, styles } from './base';
import { EvidenceList, type Jump, RichText, TurnCard } from './Library';

export type Session = ReturnType<typeof createVoiceSession>;
export type Snapshot = ReturnType<Session['getSnapshot']>;
export type Mode = 'meeting'|'personal'|'followup';
const labels: Record<Snapshot['phase'], string> = {
  idle: '시작 대기', connecting: '연결 중', recording: '녹음·전사 중', question: 'AI가 듣는 중',
  processing: 'AI가 답을 준비하는 중', responding: 'AI가 응답하는 중', finishing: '남은 전사 저장 중',
  finished: '종료됨', disconnected: '연결 끊김', error: '오류',
};

export function Active({session, snapshot, mode, record, evidence, jump, finish, rename, warning, source, closeSource, openOriginal}: {
  session: Session; snapshot: Snapshot; mode: Mode; record: RecordData; evidence: Evidence[]; jump: Jump;
  finish: () => void; rename: (id: string) => void; warning?: string;
  source?: {record: RecordData; turnId?: string}; closeSource: () => void; openOriginal?: () => void;
}) {
  const list = useRef<ComponentRef<typeof ScrollView>>(null);
  const stick = useRef(true);
  const phase = snapshot.phase;
  const inAI = ['question', 'processing', 'responding'].includes(phase);
  const unavailable = phase === 'error' || phase === 'disconnected';
  const followup = mode === 'followup' ? snapshot.followupState : undefined;
  const followupStatus = followup === 'complete' ? '확인할 질문을 마쳤습니다. 대화 종료를 눌러 저장하세요.'
    : followup === 'judging' ? '방금 답변으로 확인할 내용이 충분한지 보고 있습니다.'
    : followup === 'waiting' ? '질문에 답해 주세요.' : undefined;
  const title = mode === 'meeting' ? '회의 전사' : mode === 'followup' ? '회의 후 보완 대화' : '개인 음성 대화';
  const stored = record.turns.filter(turn => mode === 'followup' ? turn.section === 'followup' : true).slice(-80);
  const shown = [...stored, ...snapshot.partials.filter(p => !stored.some(t => t.id === p.id))];
  const selected = source?.record.turns.find(turn => turn.id === source.turnId);
  return <>
    <View style={[styles.content, {paddingTop: 12, paddingBottom: 10, gap: 8}]}>
      <View style={{backgroundColor: color.dark, padding: 16, borderRadius: 20, gap: 7}}>
        <Text style={[styles.label, {color: color.accent}]}>{mode === 'followup' || inAI ? 'SONIOX + OPENAI' : 'SONIOX'}</Text>
        <Text accessibilityRole="header" style={[styles.title, {color: color.white}]}>{title}</Text>
        <Text accessibilityLiveRegion="polite" style={[styles.small, {color: color.accent}]}>
          {snapshot.paused ? '○ 마이크 일시정지' : !snapshot.capturing && (phase === 'recording' || inAI)
            ? '○ 마이크 준비 중' : inAI && !snapshot.liveReady ? '○ AI 음성 연결 중'
              : (snapshot.capturing ? '● ' : '○ ') + (followupStatus || labels[phase])}
          {snapshot.playback ? ' · AI 음성 재생 중' : ''}
        </Text>
        <Text style={[styles.small, {color: '#D9E8DD'}]}>{snapshot.saving ? '원문 저장 중…' : snapshot.saveError ? '원문 저장 재시도 필요' : '확정 원문은 기기에 저장됩니다'}</Text>
      </View>
      <View style={styles.row}>
        {mode !== 'followup' && (inAI ? <Button label="AI 질의응답 끝내기" onPress={() => session.leave()}/>
          : <Button label="AI에게 질문" variant="accent" disabled={phase !== 'recording' || !snapshot.capturing || snapshot.paused} onPress={() => session.ask()}/>)}
        {unavailable ? <Button label="다시 연결" onPress={() => session.reconnect()}/>
          : <Button label={snapshot.paused ? '마이크 다시 켜기' : '마이크 일시정지'} disabled={phase === 'finishing' || phase === 'finished'}
              onPress={() => snapshot.paused ? session.resume() : session.pause()}/>}
        {(mode === 'followup' || inAI) && <Button label="AI 음성 중단" disabled={!snapshot.playback && phase !== 'responding'}
          onPress={() => session.interrupt()}/>}
        {mode === 'followup' && <Button label="이 질문 건너뛰기" disabled={!snapshot.capturing || !snapshot.liveReady ||
          snapshot.paused || unavailable || phase === 'finishing' || followup === 'complete'} onPress={() => session.skip()}/>}
        {snapshot.saveError && <Button label="원문 다시 저장" onPress={() => { void session.retrySave(); }}/>}
        <Button label={phase === 'finishing' ? '종료 중…' : mode === 'meeting' ? '회의 종료' : '대화 종료'} variant="danger"
          disabled={phase === 'finishing'} onPress={finish}/>
      </View>
      {(warning || snapshot.error) && <Notice text={warning || snapshot.error!} danger/>}
      {snapshot.saveError && <Notice text={snapshot.saveError} danger/>}
    </View>
    <ScrollView ref={list} style={{flex: 1}} contentContainerStyle={styles.content} scrollEventThrottle={120}
      onScroll={event => {
        const {contentOffset, contentSize, layoutMeasurement} = event.nativeEvent;
        stick.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 90;
      }} onContentSizeChange={() => { if (stick.current) list.current?.scrollToEnd({animated: false}); }}>
      {mode === 'followup' && record.summary && <View style={styles.card}>
        <Text style={styles.heading}>회의 요약 초안</Text>
        <RichText value={record.summary} refs={new Map()}/>
      </View>}
      {shown.length === 0 && <Notice text={mode === 'meeting' ? '첫 발언이 들어오면 화자와 함께 표시합니다.' : '전사가 도착하면 대화가 여기에 표시됩니다.'}/>}
      {record.turns.length > 80 && <Text style={styles.small}>최근 발언 80개를 표시합니다. 전체 원문은 기록 상세에서 확인할 수 있습니다.</Text>}
      {shown.map(turn => <TurnCard key={turn.id} turn={turn} record={record} partial={snapshot.partials.includes(turn)}
        onRename={rename} sources={evidence} jump={jump}/>)}
      {phase === 'responding' && <EvidenceList items={evidence.filter(item => snapshot.references.includes(item.reference) &&
        !stored.some(turn => turn.sourceRefs?.includes(item.reference)))} jump={jump}/>}
    </ScrollView>
    <Modal visible={!!source} animationType="slide" onRequestClose={closeSource}>
      <View style={[styles.safe, {paddingTop: 32}]}><ScrollView contentContainerStyle={styles.content}>
        <View style={styles.row}><Button label="근거 닫기" onPress={closeSource}/></View>
        {source && <><Text style={styles.heading}>{source.record.title}</Text>{selected
          ? <TurnCard turn={selected} record={source.record} highlight openOriginal={openOriginal}/> : <Text style={styles.body}>{source.record.summary || '저장된 구간을 찾을 수 없습니다.'}</Text>}</>}
      </ScrollView></View>
    </Modal>
  </>;
}
