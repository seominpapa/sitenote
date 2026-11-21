import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { applyTurn, createRecord, isCategoryPath, parseCategoryPath, renameSpeaker, safeId, searchContext, type RecordData } from '../src/records/core.ts';
import { analysisContext, liveContext, lookupPastOriginals, resolveOriginalSources, searchOriginalAnswers } from '../src/recordContext.ts';
import { buildMeetingRecap, meetingQuestionHistory } from '../src/meeting-history.ts';
import { importedRecord } from '../src/records/import.ts';
import { createVoiceSession, type Mode, type Snapshot } from '../src/session/session.ts';
import { appendTypedFollowup, type TypedPair } from '../src/typedFollowup.ts';
import { answer, classifyRecords, correctTranscription, health, saveKeys, summarize, type Health, type ProviderKeys } from './api.ts';
import { applyTranscriptCorrections, canCorrectTranscript, requestTranscriptCorrections } from '../src/transcript-correction.ts';
import { createWebAudio } from './audio.ts';
import { DesktopUpdate } from './desktop-update.tsx';
import { noteFiles, type NoteFolder } from './note-files.ts';
import { Icon, type Jump } from './ui.tsx';
import { categoryBatchLimit, Detail, RecordList, Search, Settings, StartCards, type LibraryView, Voice } from './views.tsx';
import { applyCategories, chooseNoteFolder, deleteRecords, exportRecords, loadCategoryUndo, loadFolders, noteFileError, records,
  refreshNoteFiles, sameCategory, saveFolders, saveImportedRecord, undoCategories, watchLibrary, type CategoryUndoEntry } from './store.ts';
import { prepareVoiceConsent, type ConsentAudio } from './voice-consent.ts';
import { loadAiVoice, saveAiVoice } from './voice-settings.tsx';
import './style.css';

type Session = ReturnType<typeof createVoiceSession>;
type Active = { session: Session; audio: ReturnType<typeof createWebAudio>; id: string; mode: Mode };
type Page = { name: 'home' | 'search' | 'settings' } | { name: 'detail'; id: string; part?: string; offerFollowup?: boolean; consentAudio?: ConsentAudio; typedFollowup?: boolean };
type RecordInfo = { title: string; project?: string };
const idle: Snapshot = { phase: 'idle', paused: false, transcriptionPaused: false, micMuted: false, capturing: false,
  playback: false, liveReady: false, sonioxReady: false, partials: [], references: [], saving: false };
const inactive = () => idle;
const noSubscribe = () => () => {};
const voiceProviders = { personal: ['soniox'], meeting: ['soniox'], followup: ['live', 'soniox'] } as const;

function missingVoiceKeys(mode: Mode, providers: Health['providers']) {
  return voiceProviders[mode].filter(key => !providers[key]).map(key => key === 'live' ? 'OpenAI' : 'Soniox').join(' 및 ');
}

function answerSources(records: readonly RecordData[], record: RecordData) {
  return resolveOriginalSources(records, record, record.turns.flatMap(turn => turn.sourceRefs ?? []));
}

function sourcePage(): Page {
  try {
    const parts = /^#record:([^#]+)#([^#]+)$/.exec(location.hash);
    if (parts) {
      const [id, part] = parts.slice(1).map(decodeURIComponent);
      if (safeId.test(id) && safeId.test(part)) return {name:'detail', id, part};
    }
  } catch { /* Invalid links open the library. */ }
  return {name:'home'};
}

async function lookupAnswer(question: string) {
  const evidence = searchOriginalAnswers(await records.list(), question);
  if (!evidence.length) return {answer:'관련 있는 원문이나 요약을 찾지 못했습니다.', evidence:[]};
  return {...await answer(question, searchContext(evidence)), evidence};
}

function App() {
  const [page, setPage] = useState<Page>(sourcePage);
  const [list, setList] = useState<RecordData[]>([]);
  const [folders, setFolders] = useState<string[][]>([]);
  const [categoryUndo, setCategoryUndo] = useState<CategoryUndoEntry[]>([]);
  const [libraryView, setLibraryView] = useState<LibraryView>('date');
  const [aiVoice, setAiVoice] = useState(loadAiVoice);
  const [editorVersion, setEditorVersion] = useState(0);
  const [noteFolder, setNoteFolder] = useState<NoteFolder>();
  const [documentImportError, setDocumentImportError] = useState('');
  const current = useRef<RecordData[]>([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState<Health>();
  const [checked, setChecked] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const summaries = useRef(new Map<string, symbol>());
  const [active, setActive] = useState<Active>();
  const [queuedFollowup, setQueuedFollowup] = useState<{ id: string; audio?: ConsentAudio }>();
  const snapshot = useSyncExternalStore(active?.session.subscribe ?? noSubscribe, active?.session.getSnapshot ?? inactive);
  const consentAudio = page.name === 'detail' ? page.consentAudio : undefined;

  useEffect(() => {
    if (!consentAudio) return;
    window.addEventListener('pagehide', consentAudio.dispose);
    return () => {
      window.removeEventListener('pagehide', consentAudio.dispose);
      consentAudio.dispose();
    };
  }, [consentAudio]);

  function publish(record: RecordData) {
    publishMany([record]);
  }

  function publishMany(updated: readonly RecordData[]) {
    if (!updated.length) return;
    const changed = new Set(updated.map(item => item.id));
    current.current = [...updated, ...current.current.filter(item => !changed.has(item.id))]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    setList(current.current);
  }

  function forgetRecord(id: string) {
    current.current = current.current.filter(item => item.id !== id);
    setList(current.current);
  }

  async function editRecord(id: string, edit: (latest: RecordData) => RecordData) {
    const updated = await records.update(id, edit);
    if (!updated) {
      forgetRecord(id);
      setPage({name:'home'});
      throw Error('다른 탭에서 기록이 삭제되었습니다.');
    }
    publish(updated);
  }

  async function refresh() {
    setChecked(false);
    try { setConnected(await health()); }
    catch { setConnected(undefined); }
    finally { setChecked(true); }
  }

  useEffect(() => {
    void refresh();
    try { setFolders(loadFolders()); }
    catch { setNotice('이 브라우저에서 만든 폴더를 읽지 못했습니다.'); }
    void loadCategoryUndo().then(setCategoryUndo).catch(() => setNotice('AI 분류를 되돌릴 정보를 읽지 못했습니다.'));
    const issues = new Set<string>();
    void records.list(issue => issues.add(issue.id)).then(values => {
      current.current = values;
      setList(values);
      if (issues.size) setNotice(`기록 ${issues.size}개의 원문 또는 요약을 읽지 못했습니다. 읽을 수 있는 기록은 계속 표시합니다.`);
      else {
        const linked = sourcePage();
        if (linked.name === 'detail' && !values.some(record => record.id === linked.id)) setNotice('이 브라우저에서 연결된 원문 기록을 찾을 수 없습니다.');
      }
    }).catch(() => setNotice('브라우저 저장소를 읽을 수 없습니다. 저장소 설정을 확인하세요.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const desktop = noteFiles();
    if (!desktop) return;
    const reportFilesError = () => setNotice('저장 폴더를 갱신하지 못했습니다. 폴더 연결과 쓰기 권한을 확인해 주세요.');
    const onFileError = (event: Event) => (event as CustomEvent).detail === 'delete'
      ? setNotice('앱에서 노트를 삭제했지만 저장 폴더의 Markdown 파일은 삭제하지 못했습니다. 폴더가 연결되면 앱을 다시 열어 주세요.')
      : reportFilesError();
    window.addEventListener(noteFileError, onFileError);
    void desktop.status().then(setNoteFolder, reportFilesError);
    void refreshNoteFiles().catch(reportFilesError);
    return () => window.removeEventListener(noteFileError, onFileError);
  }, []);

  useEffect(() => {
    if (loading) return;
    let alive = true;
    let wanted = false;
    let refreshing = false;
    async function sync() {
      refreshing = true;
      try {
        while (alive && wanted) {
          wanted = false;
          const before = current.current;
          const [fresh, undo] = await Promise.all([records.list(), loadCategoryUndo().catch(() => undefined)]);
          if (!alive) return;
          // Retry if a local write completed after our read began.
          if (before !== current.current) { wanted = true; continue; }
          if (undo) setCategoryUndo(undo);
          try { setFolders(loadFolders()); } catch { /* Keep the last readable folder list. */ }
          if (active) {
            const freshRecord = fresh.find(item => item.id === active.id);
            if (!freshRecord) {
              setActive(value => value?.id === active.id ? undefined : value);
              setPage({name:'home'});
              setNotice('다른 탭에서 기록이 삭제되어 녹음을 종료했습니다.');
            }
          }
          current.current = fresh;
          setList(fresh);
        }
      } catch {
        if (alive) setNotice('다른 탭에서 바뀐 기록을 불러오지 못했습니다.');
      } finally { refreshing = false; }
    }
    const unwatch = watchLibrary(() => { wanted = true; if (!refreshing) void sync(); });
    return () => { alive = false; unwatch(); };
  }, [active, loading]);

  useEffect(() => {
    const fromLocation = () => { if (!active && !pending.current) setPage(sourcePage()); };
    window.addEventListener('hashchange', fromLocation);
    return () => window.removeEventListener('hashchange', fromLocation);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    function beforeLeave(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = '';
    }
    function closeAudio() {
      active?.session.dispose();
      void active?.audio.dispose();
    }
    window.addEventListener('beforeunload', beforeLeave);
    window.addEventListener('pagehide', closeAudio);
    return () => {
      window.removeEventListener('beforeunload', beforeLeave);
      window.removeEventListener('pagehide', closeAudio);
      closeAudio();
    };
  }, [active]);

  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try { await action(); }
    catch (error) { setNotice(error instanceof Error ? error.message : '요청을 완료하지 못했습니다.'); }
    finally { pending.current = false; setBusy(false); }
  }

  function saveProviderKeys(keys: ProviderKeys, resetForm: () => void) {
    void run(async () => {
      setNotice('');
      setConnected(await saveKeys(keys));
      resetForm();
      setNotice('API 키를 저장했습니다.');
    });
  }

  function navigate(next: Page) {
    if (!active && !pending.current) {
      setNotice('');
      const hash = next.name === 'detail' && next.part ? `#record:${encodeURIComponent(next.id)}#${encodeURIComponent(next.part)}` : '';
      if (hash !== location.hash) history.pushState(null, '', location.pathname + location.search + hash);
      setPage(next);
    }
  }

  const open: Jump = (id, part) => navigate({ name: 'detail', id, part });

  function start(mode: Mode, info?: RecordInfo, recordId?: string, prepared?: ConsentAudio) {
    if (active || pending.current || loading) return;
    if (mode !== 'followup' && !info?.title.trim()) {
      setNotice(`${mode === 'meeting' ? '회의' : '개인 대화'} 제목을 입력하세요.`);
      return;
    }
    const missingKeys = connected && missingVoiceKeys(mode, connected.providers);
    if (!connected || missingKeys) {
      setPage({ name: 'settings' });
      setNotice(missingKeys ? `아래에 ${missingKeys} API 키를 입력하고 저장하세요.` : '서버 연결 상태를 확인하세요.');
      return;
    }
    const audio = prepared?.take() ?? createWebAudio({bargeIn:mode !== 'followup', recoverTail:mode === 'followup'});
    const unlocked = audio.unlock();
    void run(async () => {
      try {
        if (mode === 'followup' && page.name === 'detail' && page.offerFollowup) setPage({ name: 'detail', id: page.id });
        await unlocked;
        const existing = recordId ? await records.load(recordId) : undefined;
        if (mode === 'followup' && (!existing || existing.kind !== 'meeting' || !existing.turns.length)) {
          if (recordId && !existing) forgetRecord(recordId);
          throw Error('이 브라우저에서 보충 질문할 회의 기록을 찾을 수 없습니다.');
        }
        const record = existing ?? createRecord({ id: crypto.randomUUID(), kind: mode === 'meeting' ? 'meeting' : 'personal', ...info });
        if (!existing) await records.create(record);
        publish(record);
        const latest = () => current.current.find(item => item.id === record.id) ?? record;
        const session = createVoiceSession({
          baseUrl: location.origin, token: '', mode, audio, voice: aiVoice,
          connect: url => new WebSocket(url) as unknown as ReturnType<NonNullable<Parameters<typeof createVoiceSession>[0]['connect']>>,
          timeMs: () => Math.max(0, Date.now() - Date.parse(record.createdAt)),
          getContext: () => liveContext(latest(), mode === 'followup').context,
          getQuestionMeeting: latest,
          getQuestionHistory: (_query, beforeMs, pending, plan) => meetingQuestionHistory(latest(), beforeMs, pending, plan),
          async persist(turn) {
            const next = await records.update(record.id, fresh => applyTurn(fresh, turn));
            if (!next) {
              forgetRecord(record.id);
              setActive(value => value?.id === record.id ? undefined : value);
              setPage({name:'home'});
              setNotice('다른 탭에서 기록이 삭제되어 녹음을 종료했습니다.');
              throw Error('다른 탭에서 기록이 삭제되었습니다.');
            }
            publish(next);
          },
          async search(query,beforeMs,pending,scope,plan) {
            if (scope === 'current' || plan?.scope === 'current') return '';
            const fresh = await records.list();
            const activeRecord = fresh.find(item => item.id === record.id);
            if (!activeRecord) throw Error('회의 기록을 찾을 수 없습니다.');
            const {evidence,meeting} = lookupPastOriginals(fresh,activeRecord,query,'',beforeMs,pending,plan);
            return {context:searchContext(evidence),recap:meeting && buildMeetingRecap(meeting)};
          },
        });
        setNotice('');
        setActive({ session, audio, id: record.id, mode });
        session.start();
      } catch (error) {
        await audio.dispose();
        throw error;
      }
    });
  }

  function acceptFollowup(id: string, audio?: ConsentAudio) {
    if (pending.current) setQueuedFollowup({ id, audio });
    else start('followup', undefined, id, audio);
  }

  async function saveTypedFollowup(id: string, pair: TypedPair) {
    if (active || pending.current) throw Error('다른 작업을 마친 뒤 다시 저장해 주세요.');
    pending.current = true;
    setBusy(true);
    try {
      await editRecord(id, latest => appendTypedFollowup(latest, pair));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    if (busy || !queuedFollowup) return;
    setQueuedFollowup(undefined);
    if (!document.hidden && page.name === 'detail' && page.id === queuedFollowup.id && page.offerFollowup) {
      start('followup', undefined, queuedFollowup.id, queuedFollowup.audio);
    }
  }, [busy, page, queuedFollowup]);

  useEffect(() => {
    if (!queuedFollowup) return;
    const cancelPending = () => {
      setQueuedFollowup(undefined);
      setPage(value => value.name === 'detail' && value.id === queuedFollowup.id
        ? { name: 'detail', id: value.id, part: value.part } : value);
    };
    const hide = () => { if (document.hidden) cancelPending(); };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', cancelPending);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', cancelPending);
    };
  }, [queuedFollowup]);

  async function saveSummary(record: RecordData) {
    if (!record.turns.length) return;
    if (!connected?.providers.text) { setNotice('원문은 저장되었습니다. 요약하려면 OpenAI 연결이 필요합니다.'); return; }
    const request = Symbol();
    summaries.current.set(record.id, request);
    try {
      const base = await records.load(record.id);
      if (!base?.turns.length || summaries.current.get(record.id) !== request) return;
      const result = await summarize(base.kind, analysisContext(base), '');
      if (summaries.current.get(record.id) !== request) return;
      const saved = await records.saveSummary(base, result.markdown, result.questions);
      if (saved && summaries.current.get(record.id) === request) publish(saved);
    } catch (error) {
      if (summaries.current.get(record.id) !== request) return;
      setNotice('요약을 완료하지 못했습니다. 원문과 이미 저장한 요약은 그대로 있습니다. ' + (error instanceof Error ? error.message : ''));
    } finally {
      if (summaries.current.get(record.id) === request) summaries.current.delete(record.id);
    }
  }

  function correctTranscript(record: RecordData) {
    void run(async () => {
      setNotice('문맥에 맞춰 전사 보정 중…');
      let count = 0;
      const edits = await requestTranscriptCorrections(record,correctTranscription);
      await editRecord(record.id, latest => {
        const next = applyTranscriptCorrections(latest,edits);
        count = next.turns.filter((turn,i) => turn !== latest.turns[i]).length;
        return next;
      });
      setNotice(count ? `전사 ${count}개를 보정했습니다. 기존 요약은 다시 만들 수 있습니다.` : '추가로 보정할 발언을 찾지 못했습니다.');
    });
  }

  function finish() {
    if (!active || pending.current) return;
    // Unlock playback on the click; consent sends no microphone audio before the invitation finishes.
    const prepared = active.mode === 'meeting' && connected && !missingVoiceKeys('followup', connected.providers)
      ? prepareVoiceConsent() : undefined;
    void run(async () => {
      let offered = false;
      try {
        const result = await active.session.finish();
        if (!result.saved) {
          if (current.current.some(item => item.id === active.id)) setNotice('원문을 모두 저장하지 못했습니다. 저장을 다시 시도하세요.');
          return;
        }
        const record = current.current.find(item => item.id === active.id);
        offered = active.mode === 'meeting' && !!record?.turns.some(turn => turn.role !== 'ai');
        setActive(undefined);
        setPage({ name: 'detail', id: active.id, offerFollowup: offered, consentAudio: offered ? prepared : undefined });
        setNotice(result.flushed ? '' : '연결이 끝나기 전에 받은 원문만 저장했습니다.');
        if (record && offered) void saveSummary(record);
        else if (record) await saveSummary(record);
      } finally {
        if (!offered) prepared?.dispose();
      }
    });
  }

  function deleteSelection(ids: readonly string[]) {
    void run(async () => {
      const requested = new Set(ids);
      const selected = current.current.filter(item => requested.has(item.id));
      if (!selected.length) return;
      const multiple = selected.length > 1;
      const location = noteFiles() ? '이 앱과 현재 저장 폴더' : '이 브라우저';
      const prompt = multiple
        ? `선택한 기록 ${selected.length}개를 ${location}에서 삭제할까요? 삭제하면 되돌릴 수 없습니다.`
        : `‘${selected[0].title}’ 기록을 ${location}에서 삭제할까요?`;
      if (!window.confirm(prompt + (selected.some(item => item.originalFilename) ? ' 가져온 원본 파일은 보관됩니다.' : ''))) return;
      const keys = new Set(selected.map(item => item.id));
      for (const id of keys) summaries.current.delete(id);
      try { await deleteRecords([...keys]); }
      catch { throw Error('기록을 삭제하지 못했습니다. 선택한 기록은 그대로 남아 있습니다.'); }
      current.current = current.current.filter(item => !keys.has(item.id));
      setList(current.current);
      setPage(currentPage => currentPage.name === 'detail' && keys.has(currentPage.id) ? { name: 'home' } : currentPage);
      if (!noteFiles()) setNotice(multiple ? `기록 ${keys.size}개를 삭제했습니다.` : '기록을 삭제했습니다.');
    });
  }

  function selectStorageFolder() {
    void run(async () => {
      setNotice('');
      const selection = await chooseNoteFolder();
      if (selection) { setNoteFolder(selection); setNotice('노트 저장 폴더를 변경했습니다. 이전 폴더의 파일은 그대로 있습니다.'); }
    });
  }

  function importDocument(project: string, close: () => void) {
    void run(async () => {
      setNotice('');
      setDocumentImportError('');
      try {
        const draft = await noteFiles()?.pickDocument();
        if (!draft) return;
        const record = importedRecord(draft, project);
        await saveImportedRecord(record, draft.markdown);
        publish(record);
        setLibraryView('date');
        close();
        setNotice('회의 문서를 노트에 추가했습니다.');
      } catch (error) {
        setDocumentImportError(error instanceof Error ? error.message : '회의 문서를 추가하지 못했습니다.');
      }
    });
  }

  function exportLibrary() {
    void run(async () => {
      const fresh = await records.list();
      exportRecords(fresh);
      setNotice('');
    });
  }

  function classifyLibrary() {
    if (!connected?.providers.text) return;
    void run(async () => {
      const fresh = await records.list();
      const unclassified = fresh.filter(record => !record.category);
      if (!unclassified.length) { setNotice('분류가 필요한 기록이 없습니다.'); return; }
      setNotice('AI가 미분류 기록의 분류를 정리하는 중입니다.');
      const taxonomy = [...loadFolders(), ...fresh.map(record => record.category).filter(isCategoryPath)];
      const assignments = await classifyRecords(unclassified.slice(0, categoryBatchLimit), taxonomy);
      let changed;
      try {
        changed = await applyCategories(assignments);
      } catch {
        throw Error('AI 분류를 저장하지 못했습니다. 기존 분류는 그대로 있습니다.');
      }
      publishMany(changed.records);
      setCategoryUndo(changed.entries);
      setNotice(changed.records.length ? `기록 ${changed.records.length}개의 분류를 저장했습니다.` : '분류가 필요한 기록이 없습니다.');
    });
  }

  function undoClassification() {
    void run(async () => {
      const result = await undoCategories(categoryUndo);
      setCategoryUndo(result.entries);
      if (result.stale) {
        const fresh = await records.list();
        current.current = fresh;
        setList(fresh);
        setNotice('다른 탭에서 AI 분류를 바꿨습니다. 최근 분류를 되돌리려면 다시 선택하세요.');
        return;
      }
      publishMany(result.records);
      const restored = result.records.length;
      setNotice(restored ? `기록 ${restored}개의 AI 분류를 되돌렸습니다.` : '되돌릴 AI 분류가 없습니다.');
    });
  }

  async function createFolder(input: string) {
    const path = parseCategoryPath(input);
    if (!path) throw Error('폴더 경로를 입력하세요.');
    const explicit = loadFolders();
    if (explicit.some(folder => folder.length === path.length && path.every((label, index) => label === folder[index]))) {
      throw Error('같은 경로의 폴더가 이미 있습니다.');
    }
    const next = [...explicit, path];
    saveFolders(next);
    setFolders(next);
    setNotice('폴더를 만들었습니다.');
  }

  async function moveToFolder(id: string, category: string[]) {
    if (pending.current) throw Error('다른 작업이 끝나면 다시 시도하세요.');
    pending.current = true;
    setBusy(true);
    try {
      await editRecord(id, latest => sameCategory(latest.category, category) ? latest : {...latest, category});
      setNotice('선택한 기록을 폴더로 옮겼습니다.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const record = list.find(item => item.id === (active?.id ?? (page.name === 'detail' ? page.id : undefined)));
  const evidence = useMemo(() => record && active
    ? resolveOriginalSources(list, record, record.turns.findLast(turn => turn.role === 'ai')?.sourceRefs ?? [])
    : record ? answerSources(list, record) : [], [list, record, active]);
  const followupKeys = connected && missingVoiceKeys('followup', connected.providers);
  const followupIssue = !connected ? '로컬 서버에 연결해야 보충 질문을 시작할 수 있습니다.'
    : followupKeys ? `보충 질문을 하려면 설정에 ${followupKeys} API 키가 필요합니다.` : undefined;
  const showLibraryNotice = !active && page.name === 'home' && libraryView === 'category';
  const undoAvailable = useMemo(() => {
    if (!categoryUndo.length) return false;
    const ids = new Set(list.map(item => item.id));
    return categoryUndo.some(entry => ids.has(entry.id));
  }, [list, categoryUndo]);
  const notesSelected = page.name === 'home' || page.name === 'detail';
  return <div className="app-layout">
    <header className="app-rail">
      <div className="rail-inner">
        <button className="wordmark" aria-label="Sitenote 홈" disabled={!!active || busy} onClick={() => navigate({ name: 'home' })}>
          <span className="mark"><Icon name="wave" /></span><span>Sitenote</span>
        </button>
        <nav aria-label="주 메뉴">
          <button className={notesSelected ? 'selected' : ''} aria-current={notesSelected ? 'page' : undefined} disabled={!!active || busy} onClick={() => navigate({ name: 'home' })}><Icon name="file" /><span className="nav-label">노트</span></button>
          <button className={page.name === 'search' ? 'selected' : ''} aria-current={page.name === 'search' ? 'page' : undefined} disabled={!!active || busy} onClick={() => navigate({ name: 'search' })}><Icon name="search" /><span className="nav-label">검색</span></button>
          <button className={page.name === 'settings' ? 'selected' : ''} aria-current={page.name === 'settings' ? 'page' : undefined} disabled={!!active || busy} onClick={() => navigate({ name: 'settings' })}><Icon name="settings" /><span className="nav-label">설정</span></button>
        </nav>
        <div className="rail-foot">
          <div className="host"><span className={connected ? 'dot active' : 'dot'} aria-hidden="true" />{connected ? '로컬 서버 연결됨' : checked ? '서버 연결 확인' : '서버 확인 중'}</div>
        </div>
      </div>
    </header>
    <div className="app-main">
      <main className="shell content">
        {notice && !showLibraryNotice && <p className="notice" role="status">{notice}</p>}
        {!active && page.name === 'home' && documentImportError && <p className="notice" role="alert">{documentImportError}</p>}
        <DesktopUpdate settings={page.name === 'settings'} visible={!active && (page.name === 'home' || page.name === 'settings')} busy={busy} />
        {!active && page.name === 'settings' && noteFiles() && <section className="summary" aria-labelledby="note-folder">
          <h2 id="note-folder">노트 저장 폴더</h2>
          {noteFolder && <p className="folder-path">{noteFolder.root}</p>}
          <p className="muted">원문과 요약은 Markdown으로, 가져온 원본 문서는 별도 폴더에 보관합니다. 위치를 바꾸면 기존 노트와 원본을 복사합니다.</p>
          <button type="button" className="button quiet" disabled={busy || loading} onClick={selectStorageFolder}>저장 폴더 변경</button>
        </section>}
        {active && record ? <Voice session={active.session} mode={active.mode} record={record} status={snapshot}
          evidence={snapshot.phase === 'processing' ? [] : evidence} finish={finish} busy={busy} aiAvailable={!!connected?.providers.live} readMeter={active.audio.readMeter}
          withAudio={action => void run(async () => { await active.audio.unlock(); await action(); })} />
          : page.name === 'search' ? <Search records={list} online={!!connected?.providers.text} ask={lookupAnswer} open={open} />
          : page.name === 'settings' ? <Settings health={connected} checked={checked} busy={busy} refresh={() => void refresh()} save={saveProviderKeys}
            voice={aiVoice} changeVoice={voice => {
              try { saveAiVoice(voice); setAiVoice(voice); setNotice(''); }
              catch { setNotice('AI 목소리 설정을 저장하지 못했습니다.'); }
            }} />
          : page.name === 'detail' && record ? <Detail key={`${record.id}:${editorVersion}`} record={record} part={page.part} busy={busy}
            related={evidence}
            correctTranscript={connected?.providers.text && canCorrectTranscript(record) ? () => correctTranscript(record) : undefined}
            open={open} back={() => navigate({ name: 'home' })} summarize={() => void run(() => saveSummary(record))}
            followup={() => acceptFollowup(record.id, consentAudio)} offerFollowup={!!page.offerFollowup} consentAudio={consentAudio}
            typedFollowup={!!page.typedFollowup} typedAIAvailable={!!connected?.providers.text}
            openTypedFollowup={() => {
              setQueuedFollowup(undefined);
              setNotice('');
              setPage({name:'detail', id:record.id, part:page.part, typedFollowup:true});
            }} closeTypedFollowup={() => setPage({name:'detail', id:record.id, part:page.part})}
            loadTypedFollowup={() => records.load(record.id)} saveTypedFollowup={pair => saveTypedFollowup(record.id, pair)}
            followupIssue={followupIssue} keySettings={() => {
              if (!active) {
                setQueuedFollowup(undefined);
                setNotice('');
                setPage({ name: 'settings' });
              }
            }}
            dismissFollowup={() => {
              setQueuedFollowup(undefined);
              setPage({ name: 'detail', id: record.id, part: page.part });
            }}
            save={(edits) => void run(async () => {
              const changed = {
                ...(edits.title !== undefined && {title:edits.title}),
                ...(edits.project !== undefined && {project:edits.project || undefined}),
                ...(edits.allowInMeetings !== undefined && {allowInMeetings:edits.allowInMeetings}),
                ...(edits.categoryPath !== undefined && {category:parseCategoryPath(edits.categoryPath)}),
              };
              await editRecord(record.id, latest => Object.keys(changed).length ? {...latest, ...changed} : latest);
              setEditorVersion(previous => previous + 1);
              setNotice('기록을 업데이트했습니다.');
            })}
            rename={(id, name) => void run(async () => {
              await editRecord(record.id, latest => renameSpeaker(latest, id, name));
            })}
            remove={() => deleteSelection([record.id])} />
          : <>
            <StartCards startPersonal={(title, project) => start('personal', { title, project })} startMeeting={(title, project) => start('meeting', { title, project })}
              disabled={loading || busy} />
            <RecordList records={list} loading={loading} busy={busy} open={open} remove={id => deleteSelection([id])}
              importDocument={noteFiles() ? importDocument : undefined}
              removeMany={deleteSelection} exportAll={exportLibrary}
              view={libraryView} selectView={setLibraryView} aiAvailable={!!connected?.providers.text} classify={classifyLibrary}
              keySettings={() => navigate({ name: 'settings' })} notice={showLibraryNotice ? notice : undefined}
              folders={folders} createFolder={createFolder} moveToFolder={moveToFolder}
              undoAvailable={undoAvailable} undo={undoClassification} />
          </>}
      </main>
      <footer className="app-footer"><div className="shell footer"><span>Sitenote Desktop</span><span>원문과 요약은 로컬 PC에 저장됩니다.</span></div></footer>
    </div>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
