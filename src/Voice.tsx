import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, BackHandler } from 'react-native';
import { useKeepAwake } from 'expo-keep-awake';
import SiteAudio from '../modules/site-audio';
import { createVoiceSession } from './session/session';
import { applyTurn, searchContext, type RecordData } from './records/core';
import { recordStore } from './records/expo';
import { liveContext, resolveOriginalSources, searchPastOriginals } from './recordContext';
import { Active, type Mode } from './ui/Active';
import type { Connection } from './workflow';

export type VoiceOutcome = {flushed: boolean; saved: boolean};
export function Voice({mode, connection, keepAudio, record, getRecord, getRecords, save, onDone, rename}: {
  mode: Mode; connection: Connection; keepAudio: boolean; record: RecordData;
  getRecord: () => RecordData; getRecords: () => RecordData[]; save: (value: RecordData) => Promise<void>;
  onDone: (outcome: VoiceOutcome) => void; rename: (id: string) => void;
}) {
  useKeepAwake('sitenote-voice');
  const [source, setSource] = useState<{record: RecordData; turnId?: string}>();
  const [warning, setWarning] = useState<string>();
  const previousQuery = useRef('');
  const archivePart = useRef(0);
  const [session] = useState(() => createVoiceSession({
    baseUrl: connection.url, token: connection.token, mode,
    timeMs: () => Math.max(0, Date.now() - Date.parse(record.createdAt)),
    audio: {
      ...SiteAudio,
      startCapture: async (signal?: AbortSignal) => {
        let archive: string | undefined;
        if (keepAudio) {
          try { archive = recordStore.archiveUri(record.id, 'audio-' + Date.now() + '-' + ++archivePart.current + '.wav'); }
          catch { setWarning('음성 사본을 만들 수 없습니다. 전사는 계속 저장됩니다.'); }
        }
        await SiteAudio.startCapture(archive,signal,mode !== 'followup');
      },
    },
    persist: async turn => save(applyTurn(getRecord(), turn)),
    getContext: () => liveContext(getRecord(), mode === 'followup').context,
    search: async query => {
      const hits = searchPastOriginals(getRecords(), getRecord(), query, previousQuery.current);
      previousQuery.current = query;
      return searchContext(hits);
    },
  }));
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => {
    session.start();
    const back = BackHandler.addEventListener('hardwareBackPress', () => true);
    const state = AppState.addEventListener('change', next => { if (next === 'background') void session.backgrounded(); });
    const errors = SiteAudio.addListener('onError', event => { if (event.scope === 'archive') setWarning(event.message); });
    return () => { state.remove(); back.remove(); errors.remove(); session.dispose(); };
  }, [session]);
  const finish = async () => {
    setWarning(undefined);
    try {
      const result = await session.finish();
      if (result.saved) onDone(result);
      else setWarning('원문 저장에 실패했습니다. 저장 공간을 확인한 뒤 다시 저장해 주세요.');
    } catch {
      setWarning('종료 중 오류가 발생했습니다. 기기에 저장된 발언은 유지됩니다.');
    }
  };
  const allRecords = getRecords();
  const evidence = resolveOriginalSources(allRecords, record,
    record.turns.slice(-80).flatMap(turn => turn.sourceRefs ?? []).concat(snapshot.references));
  return <Active mode={mode} session={session} snapshot={snapshot} record={record} evidence={evidence} rename={rename}
    warning={warning} finish={() => { void finish(); }} source={source} closeSource={() => setSource(undefined)}
    jump={(id, turnId) => {
      const entry = getRecords().find(item => item.id === id);
      if (entry) setSource({record: entry, turnId});
    }}/>;
}
