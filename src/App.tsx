import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, Modal, Text, View } from 'react-native';
import * as Sharing from 'expo-sharing';
import { answer, generateFollowup, health, judgeFollowup, loadSettings, saveSettings, summarize, type Health, type Settings } from './api';
import { createRecord, renameSpeaker, searchContext, type RecordData } from './records/core';
import { recordStore } from './records/expo';
import { analysisContext, resolveOriginalSources, searchOriginalAnswers } from './recordContext';
import { citationParts, validateConnection } from './workflow';
import { appendTypedFollowup, typedJudgeRequest, typedQuestionRequest } from './typedFollowup';
import { Button, Field, Notice, Page, styles } from './ui/base';
import { Details, Home } from './ui/Library';
import type { SupplementActions } from './ui/Supplement';
import { SearchPage, SettingsPage, type SearchResult } from './ui/SettingsSearch';
import { Voice, type VoiceOutcome } from './Voice';
import type { Mode } from './ui/Active';

type DetailRoute = {page: 'detail'; id: string; turnId?: string; from?: 'home'|'search'};
type Route = {page: 'home'|'settings'|'search'} | DetailRoute | {page: 'voice'; id: string; mode: Mode};
const home: Route = {page: 'home'};
const message = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;
const defaultTitle = (kind: RecordData['kind']) => kind === 'meeting' ? '회의' : '개인 대화';
const createId = () => 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);

export default function App() {
  const [route, setRoute] = useState<Route>(home);
  const [booting, setBooting] = useState(true);
  const [settings, setSettings] = useState<Settings>({});
  const [records, setRecords] = useState<RecordData[]>([]);
  const [status, setStatus] = useState<string>();
  const [result, setResult] = useState<SearchResult>();
  const [connectionHealth, setHealth] = useState<Health>();
  const [working, setWorking] = useState(false);
  const [speaker, setSpeaker] = useState<{id: string; name: string}>();
  const [renameBusy, setRenameBusy] = useState(false);
  const list = useRef<RecordData[]>([]);
  const busy = useRef(false);
  const connection = settings.url && settings.token ? {url: settings.url, token: settings.token} : undefined;
  const current = 'id' in route ? records.find(record => record.id === route.id) : undefined;

  useEffect(() => {
    let issue = false;
    void Promise.allSettled([loadSettings(), recordStore.list(() => { issue = true; })]).then(([storedSettings, storedRecords]) => {
      if (storedSettings.status === 'fulfilled') setSettings(storedSettings.value);
      if (storedRecords.status === 'fulfilled') { list.current = storedRecords.value; setRecords(storedRecords.value); }
      if (storedRecords.status === 'rejected' || storedSettings.status === 'rejected') {
        setStatus('이 기기의 저장소를 일부 읽지 못했습니다. 앱을 다시 열어 주세요.');
      } else if (issue) {
        setStatus('일부 기록 또는 요약을 열 수 없어, 읽을 수 있는 기록만 표시했습니다.');
      }
      setBooting(false);
    });
  }, []);

  const navigate = (next: Route) => { setStatus(undefined); setRoute(next); };
  const back = () => navigate(route.page === 'detail' && route.from === 'search' ? {page: 'search'} : home);
  useEffect(() => {
    if (route.page === 'home' || route.page === 'voice') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!busy.current) back();
      return true;
    });
    return () => subscription.remove();
  }, [route]);

  const publish = (value: RecordData) => {
    list.current = [value, ...list.current.filter(item => item.id !== value.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    setRecords(list.current);
  };

  async function action(task: () => Promise<void>, fallback: string) {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    try { await task(); }
    catch (error) { setStatus(message(error, fallback)); }
    finally { busy.current = false; setWorking(false); }
  }

  async function supplementAction<T>(task: () => Promise<T>): Promise<T> {
    if (busy.current) throw new Error('기록 처리 중입니다. 잠시 뒤 다시 시도해 주세요.');
    busy.current = true;
    setWorking(true);
    setStatus(undefined);
    try { return await task(); }
    finally { busy.current = false; setWorking(false); }
  }

  function supplement(record: RecordData): SupplementActions {
    const latest = () => {
      const value = list.current.find(item => item.id === record.id);
      if (!value) throw new Error('기록을 찾을 수 없습니다.');
      return value;
    };
    const canGenerate = connection && typedQuestionRequest(record);
    return {
      save: pair => supplementAction(async () => {
        const next = appendTypedFollowup(latest(), {...pair, id:createId()});
        await recordStore.save(next);
        publish(next);
        setResult(undefined);
      }),
      generate: connection && canGenerate ? () => supplementAction(async () => {
        const request = typedQuestionRequest(latest());
        if (!request) throw new Error('AI 질문을 만들 회의 내용이 없습니다.');
        return generateFollowup(connection, request);
      }) : undefined,
      judge: connection ? (question, answer, remaining) =>
        supplementAction(() => judgeFollowup(connection, typedJudgeRequest(question, answer, remaining))) : undefined,
    };
  }

  function withConnection() {
    if (!connection) {
      navigate({page: 'settings'});
      setStatus('서버 주소와 접근 토큰을 저장한 뒤 시작해 주세요.');
    }
    return connection;
  }

  async function connect(address: string, token: string, keepAudio: boolean) {
    await action(async () => {
      setHealth(undefined);
      const credentials = validateConnection(address, token);
      const check = await health(credentials);
      await saveSettings({...credentials, keepAudio});
      setSettings({...credentials, keepAudio});
      setHealth(check);
      setStatus('서버에 연결했고 이 기기에 설정을 저장했습니다.');
    }, '서버에 연결하지 못했습니다.');
  }

  async function start(kind: RecordData['kind'], project?: string) {
    if (!withConnection()) return;
    await action(async () => {
      const value = createRecord({id: createId(), kind, project});
      await recordStore.save(value);
      publish(value);
      navigate({page: 'voice', id: value.id, mode: kind});
    }, '기록을 시작하기 전에 원문 파일을 만들 수 없었습니다.');
  }

  async function makeSummary(record: RecordData, savedNotice: string) {
    if (!record.turns.length) { setStatus(savedNotice + ' 요약할 발언이 없습니다.'); return; }
    if (!connection) { setStatus(savedNotice + ' 설정에서 서버를 연결하면 요약을 만들 수 있습니다.'); return; }
    setStatus(savedNotice + ' 요약 만드는 중…');
    await action(async () => {
      try {
        const related = searchContext(resolveOriginalSources(list.current, record, record.turns.flatMap(turn => turn.sourceRefs ?? [])));
        const draft = await summarize(connection, record.kind, analysisContext(record), related);
        await recordStore.saveSummary(record.id, draft.markdown, draft.questions);
        const latest = list.current.find(item => item.id === record.id) || record;
        const heading = draft.markdown.match(/^#\s+([^\n]+)$/m)?.[1]?.trim();
        const name = latest.title === defaultTitle(record.kind) && heading ? heading.slice(0, 120) : latest.title;
        const next = {...latest, title: name, summary: draft.markdown, questions: draft.questions};
        if (name !== latest.title) {
          try { await recordStore.save(next); }
          catch {
            publish({...next, title: latest.title});
            setStatus(savedNotice + ' 요약을 저장했지만 기록 제목을 바꾸지 못했습니다.');
            return;
          }
        }
        publish(next);
        setStatus(savedNotice + ' 요약을 저장했습니다.');
      } catch (error) {
        setStatus(savedNotice + ' 요약 실패: ' + message(error, '요약을 다시 만들 수 있습니다.'));
      }
    }, '요약하지 못했습니다.');
  }

  function finish(outcome: VoiceOutcome) {
    if (route.page !== 'voice' || !current) return;
    const value = list.current.find(item => item.id === current.id) || current;
    const note = '원문이 기기에 저장되었습니다.' + (!outcome.flushed ? ' 연결이 끊겨 마지막 전사 일부는 도착하지 않았을 수 있습니다.' : '');
    setRoute({page: 'detail', id: value.id});
    void makeSummary(value, note);
  }

  function jump(id: string, turnId?: string) {
    if (busy.current) return;
    if (list.current.some(item => item.id === id)) navigate({page: 'detail', id, turnId, from: route.page === 'search' ? 'search' :
      route.page === 'detail' ? route.from : 'home'});
  }

  async function runSearch(question: string) {
    const credentials = withConnection();
    if (!credentials) return;
    setStatus(undefined);
    setResult(undefined);
    await action(async () => {
      let evidence;
      try { evidence = searchOriginalAnswers(list.current, question, result?.question); }
      catch { setStatus('이 기기의 검색에 실패했습니다. 다시 시도해 주세요.'); return; }
      const context = evidence.length ? searchContext(evidence) : '검색은 성공했지만 관련 기록을 찾지 못했습니다.';
      const generated = await answer(credentials, question, context, result ? '이전 질문: ' + result.question : undefined);
      const cited = new Set(citationParts(generated.answer, new Set(evidence.map(item => item.reference)))
        .flatMap(part => part.reference ? [part.reference] : []));
      setResult({question, answer: generated.answer, evidence, cited});
      if (!evidence.length) setStatus('관련 기록을 찾지 못했습니다. 아래 답변에는 기록 근거가 없습니다.');
    }, '기록 답변을 만들 수 없습니다.');
  }

  function editSpeaker(id: string) {
    if (current?.turns.some(turn => turn.speakerId === id)) setSpeaker({id, name: current.speakers[id] || ''});
  }

  async function persistSpeaker() {
    if (!speaker || !current || renameBusy) return;
    setRenameBusy(true);
    try {
      const latest = list.current.find(item => item.id === current.id) || current;
      const next = renameSpeaker(latest, speaker.id, speaker.name);
      await recordStore.save(next);
      publish(next);
      setSpeaker(undefined);
    } catch (error) { Alert.alert('화자 이름을 저장하지 못했습니다', message(error, '저장 공간을 확인해 주세요.')); }
    finally { setRenameBusy(false); }
  }

  function confirmRemoval(record: RecordData) {
    Alert.alert('기록을 삭제할까요?', '원문, 요약, 저장된 음성 사본이 이 기기에서 삭제됩니다.', [
      {text: '취소', style: 'cancel'},
      {text: '삭제', style: 'destructive', onPress: () => { void action(async () => {
        await recordStore.delete(record.id);
        list.current = list.current.filter(item => item.id !== record.id);
        setRecords(list.current);
        setResult(undefined);
        back();
      }, '기록을 삭제하지 못했습니다.'); }},
    ]);
  }

  const exportRecords = (selection: RecordData[] | RecordData) =>
    { void action(() => recordStore.export(selection), '파일을 내보내지 못했습니다.'); };

  const detailReferences = (record: RecordData) => {
    const map = new Map<string, () => void>();
    for (const turn of record.turns) map.set('[record:' + record.id + '#' + turn.id + ']', () => jump(record.id, turn.id));
    for (const source of answerSources(record)) map.set(source.reference, () => jump(source.recordId, source.turnId));
    return map;
  };
  const answerSources = (record: RecordData) =>
    resolveOriginalSources(records, record, record.turns.flatMap(turn => turn.sourceRefs ?? []));

  const voice = route.page === 'voice' && current && connection ?
    <Voice key={route.id + route.mode} mode={route.mode} connection={connection} keepAudio={!!settings.keepAudio}
      record={current} rename={editSpeaker} onDone={finish}
      getRecord={() => list.current.find(item => item.id === current.id) || current} getRecords={() => list.current}
      save={async next => { publish(next); await recordStore.save(next); }}/> : null;

  return <Page>
    {booting ? <View style={[styles.content, {paddingTop: 40}]}><ActivityIndicator /><Text style={styles.body}>기록을 여는 중…</Text></View>
      : voice || (route.page === 'settings' ? <SettingsPage settings={settings} back={back} connect={connect}
        setAudioPreference={keepAudio => { void action(async () => {
          const next = {...settings, keepAudio};
          await saveSettings(next);
          setSettings(next);
          setStatus('음성 사본 설정을 저장했습니다.');
        }, '음성 사본 설정을 저장하지 못했습니다.'); }}
        exportAll={() => exportRecords(records)} status={status} result={connectionHealth} working={working}/>
      : route.page === 'search' ? <SearchPage back={back} jump={jump} run={runSearch} result={result} working={working} status={status}/>
      : route.page === 'detail' && current ? <Details key={current.id} record={current} focus={route.turnId}
        back={() => { if (!busy.current) back(); }} refs={detailReferences(current)} rename={editSpeaker}
        working={working} status={status} sources={answerSources(current)} jump={jump} update={async fields => {
          const value = {...current, ...fields, updatedAt: new Date().toISOString()};
          try { await recordStore.save(value); publish(value); setResult(undefined); setStatus('기록을 수정했습니다.'); }
          catch (error) { setStatus(message(error, '기록을 수정하지 못했습니다.')); throw error; }
        }} remove={() => confirmRemoval(current)} exportOne={() => exportRecords(current)}
        audioFiles={() => recordStore.audioFiles(current.id)}
        exportAudio={uri => { void action(() => Sharing.shareAsync(uri, {mimeType: 'audio/wav'}), '음성 사본을 내보내지 못했습니다.'); }}
        summary={() => { void makeSummary(current, '원문이 기기에 보관되어 있습니다.'); }}
        supplement={supplement(current)}
        followup={() => { if (withConnection()) navigate({page: 'voice', id: current.id, mode: 'followup'}); }}/>
      : <Home records={records} connected={!!connection} start={start} open={jump} status={status}
          goSearch={() => navigate({page: 'search'})} goSettings={() => navigate({page: 'settings'})}/>)}
    <Modal visible={!!speaker} animationType="slide" transparent onRequestClose={() => { if (!renameBusy) setSpeaker(undefined); }}>
      <View style={{flex: 1, backgroundColor: '#10282078', justifyContent: 'center', paddingHorizontal: 20}}>
        {speaker && <View style={styles.card}>
          <Text style={styles.heading}>화자 이름 지정</Text>
          <Notice text="누가 말했는지 직접 입력해 주세요. 원래 화자 ID는 유지됩니다."/>
          <Field label="이름 (비우면 미확인)" maxLength={100} value={speaker.name}
            onChangeText={name => setSpeaker({...speaker, name})}/>
          <View style={styles.row}><Button label="취소" disabled={renameBusy} onPress={() => setSpeaker(undefined)}/>
            <Button label="이름 저장" variant="primary" disabled={renameBusy} onPress={() => { void persistSpeaker(); }}/></View>
        </View>}
      </View>
    </Modal>
  </Page>;
}
