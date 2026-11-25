import React, { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { searchRecords, speakerGroups, speakerLabel, summarySourceAnchor, summarySourceEvidence, timeLabel, type Evidence, type RecordData, type Turn } from '../src/records/core.ts';
import { summaryWithSpeakerNames } from '../src/records/summary-speakers.ts';
import { date, Icon, type Jump } from './ui.tsx';
import { OriginalFile, pastSources, SavedSources, SourceLink, VoiceSources } from './source-panels.tsx';
import { currentQuotedRefs } from '../src/recordContext.ts';
import type { createVoiceSession, Mode, Snapshot } from '../src/session/session.ts';
import { citationParts } from '../src/workflow.ts';
import { exportRecord } from './store.ts';
import type { Health, ProviderKeys } from './api.ts';
import { categoryTree, type CategoryNode } from './library.ts';
import { listenForVoiceConsent, type ConsentAudio, type ConsentState } from './voice-consent.ts';
import { pendingTypedQuestions, type TypedPair } from '../src/typedFollowup.ts';
import { TypedFollowup } from './typed-followup.tsx';
import { SpeakerCorrection } from './SpeakerCorrection.tsx';
import { useMeetingPlayback } from './meeting-playback.tsx';
import { findSimilarMeetingTurns } from './speaker-match.ts';
import { VoiceSettings } from './voice-settings.tsx';
import type { AiVoice } from '../server/voices.mjs';

export type LibraryView = 'date' | 'category';
export const categoryBatchLimit = 120;
const describe = (record: RecordData) => [date.format(new Date(record.createdAt)), record.project].filter(Boolean).join(' · ');

type StartRecording = (title: string, project?: string, keepAudio?: boolean) => void;

function MeetingAudioOption({checked, disabled, onChange}: {
  checked: boolean; disabled: boolean; onChange: (checked: boolean) => void;
}) {
  const helpId = useId();
  const [showHelp, setShowHelp] = useState(false);
  return <div className="meeting-audio-option">
    <label className="checkbox"><input type="checkbox" checked={checked} disabled={disabled}
      onChange={event => onChange(event.currentTarget.checked)} /> 원본 음성 보관</label>
    <button type="button" className="audio-option-help" aria-label="원본 음성 보관 안내"
      aria-controls={helpId} aria-expanded={showHelp} onClick={() => setShowHelp(open => !open)}
      onKeyDown={event => { if (event.key === 'Escape') setShowHelp(false); }}>
      <span aria-hidden="true">?</span>
    </button>
    <p id={helpId} className="audio-option-bubble" hidden={!showHelp}>
      회의 음성을 이 기기에 보관합니다. 회의 후 전체를 다시 듣거나, 화자가 잘못 구분된 발언을 다시 듣고 올바른 화자로 옮길 수 있습니다.
    </p>
  </div>;
}

function RecordingForm({ titlePrefix, placeholder, start, disabled }: {
  titlePrefix: '개인 대화' | '회의'; placeholder: string; start: StartRecording; disabled: boolean;
}) {
  const [title, setTitle] = useState('');
  const [project, setProject] = useState('');
  const [keepAudio, setKeepAudio] = useState(false);
  return <form className="recording-form" onSubmit={event => {
    event.preventDefault();
    if (title.trim()) start(title.trim(), project.trim() || undefined, keepAudio);
  }}>
    <label>{titlePrefix} 제목<input value={title} onChange={event => setTitle(event.target.value)} maxLength={120} placeholder={placeholder} required /></label>
    <label>{titlePrefix} 프로젝트<input value={project} onChange={event => setProject(event.target.value)} maxLength={120} placeholder="선택 입력" /></label>
    {titlePrefix === '회의' && <MeetingAudioOption checked={keepAudio} disabled={disabled} onChange={setKeepAudio} />}
    <button className="button primary" disabled={disabled || !title.trim()}>{titlePrefix} 시작 <Icon name="arrow" /></button>
  </form>;
}

export function StartCards({ startPersonal, startMeeting, disabled }: {
  startPersonal: StartRecording; startMeeting: StartRecording; disabled: boolean;
}) {
  return <>
    <section className="intro">
      <div className="intro-heading">
        <h1>기록 작업실</h1>
        <p className="description">개인 대화와 회의를 녹음하고, 저장한 기록을 여기서 찾아보세요.</p>
      </div>
    </section>
    <div className="start-grid">
      <section className="start-card personal">
        <div className="card-top"><span className="tile-icon"><Icon name="mic" /></span></div>
        <h2>개인 대화</h2>
        <p>생각이나 대화를 음성으로 기록하고, 필요할 때 AI에게 질문하세요.</p>
        <RecordingForm titlePrefix="개인 대화" placeholder="예: 현장 자동화 아이디어" start={startPersonal} disabled={disabled} />
      </section>
      <section className="start-card meeting">
        <div className="card-top"><span className="tile-icon"><Icon name="people" /></span></div>
        <h2>회의 녹음</h2>
        <p>발언을 실시간으로 옮기고, 필요한 순간에만 AI를 부릅니다.</p>
        <RecordingForm titlePrefix="회의" placeholder="예: 주간 공정 회의" start={startMeeting} disabled={disabled} />
      </section>
    </div>
  </>;
}

type RecordActions = { busy: boolean; open: Jump; remove: (id: string) => void };
type RowActions = RecordActions & { selected: ReadonlySet<string>; toggle(ids: readonly string[], checked: boolean): void };

function RecordRows({ records, busy, open, remove, selected, toggle }: RowActions & { records: readonly RecordData[] }) {
  return <ul className="records">{records.map(record => <li className="record-actions" key={record.id} data-selected={selected.has(record.id)}>
    <button className="record-row" data-testid="record-item" disabled={busy} onClick={() => open(record.id)}>
      <span className="empty-icon"><Icon name={record.kind === 'meeting' ? 'people' : 'mic'} /></span>
      <span className="record-name"><strong>{record.title}</strong><small>{describe(record)}</small></span>
      <span className="badge">{record.originalFilename ? '문서' : record.kind === 'meeting' ? '회의' : '개인'}</span><Icon name="arrow" />
    </button>
    <button className="button danger" aria-label={`${record.title} 삭제`} data-testid="record-delete" disabled={busy} onClick={() => remove(record.id)}>삭제</button>
    <label className="record-select"><input type="checkbox" aria-label={`${record.title} 선택`} checked={selected.has(record.id)} disabled={busy}
      onChange={event => toggle([record.id], event.currentTarget.checked)} /></label>
  </li>)}</ul>;
}

function PageSelection({ ids, selected, disabled, toggle }: {
  ids: string[]; selected: ReadonlySet<string>; disabled: boolean; toggle: RowActions['toggle'];
}) {
  const input = useRef<HTMLInputElement>(null);
  const count = ids.filter(id => selected.has(id)).length;
  const mixed = count > 0 && count < ids.length;
  useEffect(() => { if (input.current) input.current.indeterminate = mixed; }, [mixed]);
  return <label className="page-select"><input type="checkbox" ref={input} checked={count > 0 && count === ids.length}
    aria-checked={mixed ? 'mixed' : undefined} disabled={disabled} onChange={event => toggle(ids, event.currentTarget.checked)} />이 페이지 전체 선택</label>;
}

function RecordPagination({ page, total, busy, setPage }: { page: number; total: number; busy: boolean; setPage(next: number): void }) {
  return <nav className="record-pagination" aria-label="기록 페이지">
    <button className="button quiet" disabled={busy || page === 0} onClick={() => setPage(page - 1)}>이전 페이지</button>
    <p className="muted" data-testid="record-page-status" role="status" aria-atomic="true">페이지 {page + 1} / {total}</p>
    <button className="button quiet" disabled={busy || page + 1 === total} onClick={() => setPage(page + 1)}>다음 페이지</button>
  </nav>;
}

type MoveToFolder = (id: string, path: string[]) => Promise<void>;

function FolderRecordForm({ destination, candidates, busy, move }: {
  destination: string[]; candidates: RecordData[]; busy: boolean; move: MoveToFolder;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  if (!open) return <button type="button" className="button quiet" disabled={busy || !candidates.length} onClick={() => setOpen(true)}>기록 추가</button>;
  return <form className="folder-form inline" onSubmit={event => {
    event.preventDefault();
    if (!selected) return;
    setError('');
    void move(selected, destination).then(() => { setOpen(false); setSelected(''); }, error => {
      setError(error instanceof Error ? error.message : '기록을 옮기지 못했습니다.');
    });
  }}>
    <label>추가할 기록<select value={selected} onChange={event => setSelected(event.target.value)} disabled={busy} required>
      <option value="">기록을 선택하세요</option>
      {candidates.map(record => <option key={record.id} value={record.id}>{record.title}</option>)}
    </select></label>
    <button type="submit" className="button primary" disabled={busy || !selected}>선택한 기록 추가</button>
    <button type="button" className="button quiet" disabled={busy} onClick={() => { setOpen(false); setError(''); setSelected(''); }}>취소</button>
    {error && <p className="muted" role="alert">{error}</p>}
  </form>;
}

function CategoryFolders({ nodes, actions, library, move }: {
  nodes: readonly CategoryNode[]; actions: RowActions; library: RecordData[]; move: MoveToFolder;
}) {
  return <ul className="category-folders">{nodes.map(node => <li key={JSON.stringify(node.path)}>
    <details open data-testid="category-folder">
      <summary><Icon name="folder" /><span>{node.label}</span></summary>
      {!!node.path.length && <div className="folder-actions"><FolderRecordForm destination={node.path} busy={actions.busy} move={move}
        candidates={library.filter(record => !node.records.some(item => item.id === record.id))} /></div>}
      {!!node.records.length && <RecordRows records={node.records} {...actions} />}
      {!!node.children.length && <CategoryFolders nodes={node.children} actions={actions} library={library} move={move} />}
    </details>
  </li>)}</ul>;
}

const libraryViews: [LibraryView, string][] = [['date', '날짜순'], ['category', '분류별']];
const notesPerPage = 10;

function useNoteSelection(records: readonly RecordData[]) {
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const recordIds = useMemo(() => new Set(records.map(record => record.id)), [records]);
  const selected = useMemo(() => new Set([...selection].filter(id => recordIds.has(id))), [selection, recordIds]);
  useEffect(() => { if (selected.size !== selection.size) setSelection(selected); }, [selected, selection]);
  function toggle(ids: readonly string[], checked: boolean) {
    const toggled = new Set(ids);
    setSelection(previous => checked ? new Set([...previous, ...ids]) : new Set([...previous].filter(id => !toggled.has(id))));
  }
  return { selected, toggle, selectAll: () => setSelection(recordIds), clear: () => setSelection(new Set()) };
}

function NewFolderForm({ create, close }: { create: (path: string) => Promise<void>; close: () => void }) {
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  return <form className="folder-form inline new-folder" onSubmit={event => {
    event.preventDefault();
    if (!path.trim()) return;
    setError('');
    void create(path).then(close, error => setError(error instanceof Error ? error.message : '폴더를 만들지 못했습니다.'));
  }}>
    <label>폴더 경로<input value={path} onChange={event => setPath(event.target.value)} required placeholder="예: 업무 / 정기 회의" /></label>
    <button type="submit" className="button primary" disabled={!path.trim()}>폴더 만들기</button>
    <button type="button" className="button quiet" onClick={close}>취소</button>
    {error && <p className="muted" role="alert">{error}</p>}
  </form>;
}

export function RecordList({ records, loading, busy, open, remove, removeMany, exportAll, view, selectView, aiAvailable, classify,
  keySettings, notice, folders, createFolder, moveToFolder, undoAvailable, undo, importDocument }: RecordActions & {
  records: RecordData[]; loading: boolean; removeMany(ids: readonly string[]): void; exportAll: () => void; view: LibraryView; selectView: (mode: LibraryView) => void;
  aiAvailable: boolean; classify: () => void; keySettings: () => void; notice?: string;
  folders: string[][]; createFolder: (path: string) => Promise<void>; moveToFolder: MoveToFolder;
  undoAvailable: boolean; undo: () => void;
  importDocument?: (project: string, close: () => void) => void;
}) {
  const [addingFolder, setAddingFolder] = useState(false);
  const [addingDocument, setAddingDocument] = useState(false);
  const [page, setPage] = useState(0);
  const { selected, toggle, selectAll, clear } = useNoteSelection(records);
  const actions = { busy, open, remove, selected, toggle };
  const sorted = useMemo(() => [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)), [records]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / notesPerPage));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = sorted.slice(currentPage * notesPerPage, (currentPage + 1) * notesPerPage);
  const hasSelection = selected.size > 0;
  useEffect(() => { setPage(previous => Math.min(previous, pageCount - 1)); }, [pageCount]);
  const unclassified = records.filter(record => !record.category).length;
  const tree = view === 'category' ? categoryTree(records, 'category', folders) : [];
  return <section className="library">
    <div className="section-heading">
      <h2>최근 노트 <small>{records.length}</small></h2>
      <div className="actions">
        {importDocument && <button className="button primary" disabled={busy || loading || addingDocument} onClick={() => setAddingDocument(true)}>노트 추가</button>}
        <button className="button quiet" disabled={!records.length || busy} onClick={exportAll}><Icon name="download" /> 전체 내보내기 (ZIP)</button>
      </div>
    </div>
    {addingDocument && importDocument && <form className="inline document-import" onSubmit={event => {
      event.preventDefault();
      importDocument(String(new FormData(event.currentTarget).get('project') ?? '').trim(), () => { setAddingDocument(false); setPage(0); });
    }}>
      <label>프로젝트 (선택)<input name="project" maxLength={120} /></label>
      <button className="button primary" disabled={busy} type="submit">{busy ? '가져오는 중…' : '파일 선택'}</button>
      <button className="button quiet" disabled={busy} type="button" onClick={() => setAddingDocument(false)}>취소</button>
      <p className="muted">MD, TXT, DOCX, HWP, HWPX, 텍스트 PDF를 기기에서 변환합니다. AI가 노트를 참고할 때 관련 문서의 일부가 답변 요청에 포함될 수 있습니다.</p>
    </form>}
    <div className="library-toolbar">
      <div className="library-tabs" role="group" aria-label="기록 보기">{libraryViews.map(([mode, label]) =>
        <button key={mode} className="button quiet" aria-pressed={view === mode} disabled={busy} onClick={() => {
          if (mode !== view) { setPage(0); selectView(mode); }
        }}>{label}</button>)}</div>
      {view === 'category' && <div className="library-tabs">
        <button className="button quiet" disabled={busy || loading || addingFolder} onClick={() => setAddingFolder(true)}>새 폴더</button>
        <button className="button primary" disabled={busy || loading || !unclassified || !aiAvailable} onClick={classify}>AI 자동 분류</button>
        {undoAvailable && <button className="button quiet" disabled={busy || loading} onClick={undo}>AI 분류 되돌리기</button>}
      </div>}
    </div>
    {view === 'category' && addingFolder && <NewFolderForm create={createFolder} close={() => setAddingFolder(false)} />}
    {view === 'category' && <div className="library-help">
      <p className="muted">기록 설정에서 분류를 직접 수정할 수 있습니다. AI 자동 분류는 미분류 기록만 처리합니다.</p>
      {!!unclassified && <p className="muted">미분류 기록 {unclassified}개 · 실행하면 제목과 프로젝트, 요약 또는 원문 일부를 OpenAI에 보냅니다.</p>}
      {unclassified > categoryBatchLimit && <p className="muted">한 번에 최근 {categoryBatchLimit}개까지 분류합니다.</p>}
      {!loading && !!records.length && !unclassified && <p className="muted">모든 기록에 분류가 있습니다.</p>}
      {!aiAvailable && <button className="citation" disabled={busy} onClick={keySettings}>OpenAI 연결 및 API 키 설정</button>}
    </div>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {!loading && !!records.length && <div className="library-selection" role="group" aria-label="기록 선택">
      <div className="selection-info">
        {view === 'date' && <PageSelection ids={visible.map(record => record.id)} selected={selected} disabled={busy} toggle={toggle} />}
        <p className="selection-count muted" data-testid="record-selection-count" data-selected={hasSelection} role="status" aria-atomic="true">{selected.size}개 선택됨</p>
      </div>
      <div className="actions">
        <button className="button quiet" disabled={busy || selected.size === records.length} onClick={selectAll}>모든 기록 선택</button>
        <button className="button quiet" disabled={busy || !hasSelection} onClick={clear}>선택 해제</button>
        <button className="button danger" disabled={busy || !hasSelection} onClick={() => removeMany([...selected])}>선택 삭제 ({selected.size}개)</button>
      </div>
    </div>}
    {loading ? <div className="empty" role="status">기록을 불러오는 중입니다.</div>
      : view === 'category' && tree.length ? <CategoryFolders nodes={tree} actions={actions} library={records} move={moveToFolder} /> : !records.length
      ? <div className="empty"><span className="empty-icon"><Icon name="file" /></span><div><strong>아직 기록이 없어요</strong><p>개인 대화나 회의를 시작하면 여기에 자동으로 모입니다.</p></div></div>
      : <><RecordRows records={visible} {...actions} /><RecordPagination page={currentPage} total={pageCount} busy={busy} setPage={setPage} /></>}
  </section>;
}

const phases: Record<Snapshot['phase'], string> = {
  idle: '준비', connecting: '서버 연결 중', recording: '전사 중', question: '듣는 중',
  processing: 'AI가 답변을 준비하는 중', responding: 'AI 답변 중', finishing: '원문 저장 중',
  finished: '녹음 종료', disconnected: '연결 끊김', error: '연결 오류',
};
const sectionNames: Record<Turn['section'], string> = { personal: '개인 대화', meeting: '회의', 'meeting-ai': '질의응답', followup: '보충 질문' };

function transcriptSpeaker(record: RecordData, turn: Turn) {
  if (turn.entry) return speakerLabel(record, turn);
  if (turn.section === 'followup' && turn.role === 'ai') return 'AI 질문';
  const label = speakerLabel(record, turn);
  if (turn.section !== 'followup') return label;
  return `참가자 답변 · ${label}`;
}

function Transcript({ turns, record, partials = false, afterTurn, originalAt }: {
  turns: Turn[]; record: RecordData; partials?: boolean; afterTurn?: (turn: Turn) => ReactNode; originalAt?: string;
}) {
  return <div className={partials ? 'transcript partial' : 'transcript'}>
    {turns.map(turn => {
      const corrected = !partials && turn.role !== 'ai' && turn.correctedText !== turn.text ? turn.correctedText : undefined;
      return <article id={partials ? undefined : turn.id} tabIndex={partials ? undefined : -1} data-testid={partials ? undefined : 'transcript-turn'} key={turn.id} className={turn.role === 'ai' ? 'turn ai' : 'turn'}>
        <div className="turn-by"><span>{transcriptSpeaker(record, turn)}</span>
          {!(record.originalFilename && turn.id.startsWith('import-')) && <small>{sectionNames[turn.section]} · {timeLabel(turn.timeMs)}{turn.interrupted ? ' · 중단' : ''}{corrected ? ' · AI 보정' : ''}</small>}
        </div>
        <p>{corrected || turn.text}</p>
        {corrected && <details className="turn-original" open={originalAt === turn.id || undefined}>
          <summary>보정 전 원문 보기</summary><p>{turn.text}</p>
        </details>}
        {afterTurn?.(turn)}
      </article>;
    })}
  </div>;
}

type MeterKind = 'mic' | 'speaker';
type ReadMeter = (kind: MeterKind, samples: Float32Array<ArrayBuffer>) => void;
const flatWave = 'M0 29H320';

function audioWave(samples: Float32Array<ArrayBuffer>) {
  if (!samples.some(value => Math.abs(value) > 0.006)) return flatWave;
  const steps = 64;
  const points = [];
  for (let step = 0; step <= steps; step++) {
    let value = 0;
    for (let i = Math.floor(step * samples.length / (steps + 1)); i < Math.floor((step + 1) * samples.length / (steps + 1)); i++) {
      if (Math.abs(samples[i]) > Math.abs(value)) value = samples[i];
    }
    points.push(`${step * 5} ${Math.round(29 - Math.max(-25, Math.min(25, value * 100)))}`);
  }
  return `M${points.join('L')}`;
}

function AudioPanel({ kind, label, title, drawing, readMeter }: {
  kind: MeterKind; label: string; title: string; drawing: boolean; readMeter: ReadMeter;
}) {
  const panel = useRef<HTMLElement>(null);
  const wave = useRef<SVGPathElement>(null);
  useEffect(() => {
    const root = panel.current;
    const path = wave.current;
    if (!root || !path || !drawing) return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const samples = new Float32Array(1024);
    let tick = 0;
    let lastDraw = 0;
    let previous = flatWave;
    function draw(time: number) {
      if (!root || !path) return;
      if (time - lastDraw >= 32) {
        lastDraw = time;
        readMeter(kind, samples);
        const line = audioWave(samples);
        if (line !== previous) {
          path.setAttribute('d', line);
          root.dataset.signal = line === flatWave ? 'silent' : 'audible';
          previous = line;
        }
      }
      tick = requestAnimationFrame(draw);
    }
    function stop() {
      cancelAnimationFrame(tick);
      path?.setAttribute('d', flatWave);
      if (root) root.dataset.signal = 'silent';
      previous = flatWave;
    }
    function applyPreference() {
      stop();
      if (!preference.matches) tick = requestAnimationFrame(draw);
    }
    applyPreference();
    preference.addEventListener('change', applyPreference);
    return () => { stop(); preference.removeEventListener('change', applyPreference); };
  }, [drawing, kind, readMeter]);

  return <section ref={panel} className={`audio-panel ${kind}`} aria-label={title} data-testid={kind === 'mic' ? 'voice-meter' : 'ai-panel'} data-signal="silent">
    <div className="audio-panel-label">
      <span className="audio-icon"><Icon name={kind} /></span>
      <div><span className="audio-kicker">{title}</span><strong role="status">{label}</strong></div>
    </div>
    <svg className="waveform" data-testid={`${kind}-waveform`} viewBox="0 0 320 58" preserveAspectRatio="none" aria-hidden="true">
      <path className="baseline" d={flatWave} />
      <path className="wave" ref={wave} d={flatWave} />
    </svg>
  </section>;
}

function aiStatus(status: Snapshot, mode: Mode, invited: boolean) {
  if (status.paused) return '일시정지';
  if (status.phase === 'finishing' || status.phase === 'finished' || (mode !== 'followup' && !invited)) return '대기 중';
  if (status.phase === 'disconnected' || status.phase === 'error' || (mode === 'followup' && status.phase === 'recording' && !status.liveReady)) return '연결 끊김';
  if (!status.liveReady) return '연결 중';
  if (status.playback) return '답변 재생 중';
  if (status.phase === 'processing' || status.phase === 'responding') return '답변 준비 중';
  return '질문 듣는 중';
}

const recordingLabels = { personal: '개인 대화 전사 중', meeting: '회의 전사 중', followup: '답변 전사 중' } as const;

function voiceStatus(status: Snapshot, mode: Mode, invited: boolean) {
  if (status.paused) return '마이크 일시정지';
  if (mode === 'followup' && status.liveReady && status.phase !== 'finishing' && status.phase !== 'finished') {
    if (status.playback) return 'AI 질문 재생 중';
    if (status.followupState === 'waiting') return '지금 답변하세요';
    if (status.followupState === 'judging') return '답변 확인 중';
    if (status.followupState === 'complete') return '보충 질문 완료';
    return 'AI 질문 준비 중';
  }
  if (invited) {
    if (!status.liveReady) return 'AI 음성 연결 중';
    if (status.playback) return 'AI 답변 재생 중';
    if (status.phase === 'question') return '지금 질문하세요';
    return 'AI가 답변을 준비하는 중';
  }
  if (status.phase === 'recording') {
    if (status.transcriptionPaused) return mode === 'meeting' ? '회의 전사 일시정지' : '개인 대화 전사 일시정지';
    if (status.micMuted) return '마이크 중지';
    return recordingLabels[mode];
  }
  return phases[status.phase];
}

export function Voice({ session, status, mode, record, evidence, finish, busy, aiAvailable, readMeter, withAudio }: {
  session: ReturnType<typeof createVoiceSession>; status: Snapshot; mode: Mode;
  record: RecordData; evidence: Evidence[]; finish: () => void; busy: boolean; aiAvailable: boolean;
  readMeter: ReadMeter;
  withAudio(action: () => void | Promise<void>): void;
}) {
  const transcript = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const pane = transcript.current;
    if (!pane || !pane.firstElementChild) return;
    const follow = () => { pane.scrollTop = pane.scrollHeight; };
    const observer = new ResizeObserver(follow);
    observer.observe(pane.firstElementChild);
    observer.observe(pane);
    follow();
    return () => observer.disconnect();
  }, []);
  const canInvite = mode !== 'followup';
  const aiInvited = canInvite && ['question', 'processing', 'responding'].includes(status.phase);
  const recording = status.phase === 'recording' && status.capturing && status.sonioxReady;
  const lost = ['error', 'disconnected'].includes(status.phase);
  const stopping = status.phase === 'finishing' || status.phase === 'finished';
  const sources = pastSources(record.id, evidence);
  const latestAnswer = record.turns.findLast(turn => turn.role === 'ai');
  const micStatus = status.paused || status.micMuted ? '일시정지' : status.capturing && !stopping ? '녹음 중' : '대기 중';
  const sonioxStatus = status.paused || status.micMuted ? 'Soniox 답변 전사 일시정지' : lost ? 'Soniox 답변 전사 연결 끊김'
    : stopping ? 'Soniox 마지막 전사 저장 중'
    : status.playback ? 'AI 질문을 재생하는 중입니다.'
    : status.liveReady && status.followupState === 'prompting' ? '질문이 끝나면 답변을 전사합니다.'
    : status.sonioxReady && status.capturing ? 'Soniox 답변 전사 중' : 'Soniox 전사 연결 중';
  return <section className="page-stack voice-layout">
    <div className="voice-controls">
      <div className="page-heading recording">
        <h1 className="record-title" title={mode === 'followup' ? undefined : record.title}>{mode === 'followup' ? '보충 질문' : record.title}</h1>
        <p className="muted">{mode === 'meeting' ? '회의 녹음' : mode === 'personal' ? '개인 대화 녹음' : '실시간 음성 노트'}</p>
        <p className="recording-status" data-testid="voice-status" role="status"><span className={status.capturing ? 'dot active' : 'dot'} />{voiceStatus(status, mode, aiInvited)}</p>
        {aiInvited && status.transcriptionPaused && <p className="muted" role="status">{mode === 'meeting' ? '회의 전사 일시정지' : '개인 대화 전사 일시정지'}</p>}
        {mode === 'followup' && !status.paused && <>
          {status.followupState === 'complete' ? <p className="muted" role="status">확인할 질문을 마쳤습니다. 녹음 종료를 눌러 저장하세요.</p>
            : status.followupState === 'judging' ? <p className="muted" role="status">방금 답변으로 확인할 내용이 충분한지 보고 있습니다.</p>
            : status.followupState === 'waiting' ? <p className="muted">질문에 답해 주세요. 답변이 충분하면 다음 질문으로 넘어갑니다.</p>
            : status.liveReady && <p className="muted">질문이 끝난 뒤 바로 답변해 주세요.</p>}
        </>}
        <div className="actions">
          {lost ? <button className="button quiet" disabled={busy} onClick={() => withAudio(session.reconnect)}>다시 연결</button>
            : <button className="button quiet" disabled={busy || stopping || (!status.capturing && !status.paused)}
              onClick={() => status.paused ? withAudio(session.resume) : session.setMicMuted(!status.micMuted)}>{status.paused || status.micMuted ? '마이크 재개' : '마이크 중지'}</button>}
          {canInvite && <button className="button quiet" disabled={busy || stopping || lost || !status.sonioxReady}
            onClick={() => session.setTranscriptionPaused(!status.transcriptionPaused)}>{mode === 'meeting'
              ? status.transcriptionPaused ? '회의재개' : '회의중지'
              : status.transcriptionPaused ? '전사재개' : '전사중지'}</button>}
          {canInvite && <button className="button quiet" title={aiAvailable || aiInvited ? undefined : 'OpenAI 키가 필요합니다.'}
            disabled={busy || stopping || status.paused || (!aiInvited && (status.micMuted || !aiAvailable || !recording))}
            onClick={() => aiInvited ? session.leave() : withAudio(session.ask)}>{aiInvited ? 'AI 질문 닫기' : 'AI에게 질문'}</button>}
          {mode === 'followup' && <button className="button quiet" disabled={!status.capturing || !status.liveReady || stopping || status.followupState === 'complete'} onClick={session.skip}>다음 확인 사항</button>}
          <button className="button quiet" disabled={!status.playback || stopping} onClick={session.interrupt}>AI 음성 중지</button>
          <button className="button danger" disabled={busy || status.phase === 'finishing'} onClick={finish}>녹음 종료</button>
        </div>
        {canInvite && recording && !status.paused && !status.micMuted && <p className="muted">{aiAvailable
          ? 'AI가 필요하면 “AI에게 질문”을 누르세요.'
          : 'AI 음성 질문에는 OpenAI API 키가 필요합니다.'}</p>}
      </div>
      <div className="audio-panels">
        <AudioPanel kind="mic" title="마이크 입력" label={micStatus} drawing={status.capturing && !status.paused && !status.micMuted && !stopping} readMeter={readMeter} />
        <AudioPanel kind="speaker" title="AI 음성" label={aiStatus(status, mode, aiInvited)} drawing={status.playback && !status.paused && !stopping} readMeter={readMeter} />
      </div>
      {status.error && <p className="notice" role="alert">{status.error}</p>}
      {status.saveError && <div className="notice"><p role="alert">{status.saveError}</p><button className="button quiet" onClick={() => void session.retrySave()}>저장 다시 시도</button></div>}
      <VoiceSources sources={sources} quoted={latestAnswer ? currentQuotedRefs(latestAnswer, sources) : undefined} />
    </div>
    <div className="section-heading"><h2>실시간 원문</h2><small className="muted">{status.saving ? '원문 저장 중' : '브라우저에 저장'}</small></div>
    {mode === 'followup' && <p className="muted" data-testid="soniox-status" role="status">{sonioxStatus} · 참가자 답변은 화자별로 기록됩니다.</p>}
    <div ref={transcript} className="live-transcript" role="region" aria-label="실시간 원문" tabIndex={0}>
      <div>
        {!record.turns.length && !status.partials.length && <div className="empty">아직 전사된 발언이 없습니다.</div>}
        <Transcript turns={record.turns} record={record} />
        <Transcript turns={status.partials} record={record} partials />
      </div>
    </div>
  </section>;
}

function textLines(markdown: string, render: (text: string) => ReactNode = text => text) {
  return markdown.split('\n').filter(line => line.trim()).map((line, index) => {
    const text = line.replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, '• ').replace(/\*\*([^*]+)\*\*/g, '$1');
    const content = render(text);
    return line.startsWith('#') ? <h3 key={index}>{content}</h3> : <p key={index}>{content}</p>;
  });
}

function answerLines(markdown: string, sources: ReadonlyMap<string, Evidence>, open: Jump) {
  return textLines(markdown, text => citationParts(text, sources).map((part, index) => {
    const evidence = part.reference && sources.get(part.reference);
    return evidence
      ? <SourceLink key={index} item={evidence} open={open} className="citation">{evidence.summaryOnly ? '요약에만 있는 내용' : '출처'}: {evidence.title}{evidence.timeMs !== undefined && ` · ${timeLabel(evidence.timeMs)}`}</SourceLink>
      : part.text;
  }));
}

function summaryLines(markdown: string) {
  // Provenance comes from the saved answer references, never from the summary model's prose.
  const cleaned = markdown.split('\n').flatMap(line => {
    if (/^\s*(?:(?:#{1,6}|[-*])\s+)?(?:\[\s*(?:\^[^\]\r\n]+|(?:출처\s*)?\d+)\s*\]|출처\s*\d+)\s*[:：]/.test(line)) return [];
    if (/^\s*#{1,6}\s+출처\s*[:：]?\s*$/.test(line)) return [];
    const withoutMarkers = line
      .replace(/\[record:[^\]\r\n]+\](?:\([^\r\n)]*\))?/gi, '')
      .replace(/\[\s*(?:\^[^\]\r\n]+|출처\s*[:：]?\s*\d+)\s*\](?:\([^\r\n)]*\))?/g, '')
      .replace(/\(\s*출처\s*[:：]?\s*\d+\s*\)|【\s*(?:출처\s*)?\d+(?:†[^】\r\n]*)?\s*】/g, '')
      .replace(/\[\s*\d+\s*\]/g, (marker, offset: number, text: string) => {
        // Keep numbered list labels at the start of a line when a list entry follows.
        const atListStart = !text.slice(0, offset).trim() && /^[ \t]+\S/.test(text.slice(offset + marker.length));
        return atListStart ? marker : '';
      })
      .replace(/\*\*(출처[ \t]*\d+)\*\*/g, '$1')
      .replace(/(^|[ \t]+)출처[ \t]*[:：]?[ \t]*\d+(?=$|[ \t.,!?;:：。])/g, '')
      .trimEnd();
    const body = withoutMarkers === line.trimEnd() ? withoutMarkers : withoutMarkers.replace(/[ \t]+(?=[,.!?。])/g, '');
    return /^\s*(?:(?:#{1,6}|[-*]|\d+[.)])\s*)?(?:\*{2,4}\s*)?$/.test(body) ? [] : [body];
  }).join('\n');
  return textLines(cleaned);
}

const consentMessages: Record<ConsentState, string> = {
  speaking: '안내 음성이 끝나면 “예” 또는 “아니요”라고 말씀하세요.',
  connecting: '음성 응답을 준비하고 있습니다.',
  listening: '지금 “예” 또는 “아니요”라고 말씀하세요.',
  unavailable: '음성 응답을 사용할 수 없습니다. 아래 버튼으로 선택하세요.',
  timeout: '음성 응답 시간이 끝났습니다. 아래 버튼으로 선택할 수 있습니다.',
  accepted: '보충 질문에 동의했습니다. 음성을 연결하고 있습니다.',
};

function FollowupInvitation({ issue, prepared, accept, typeAnswer, dismiss, keySettings }: {
  issue?: string; prepared?: ConsentAudio; accept: () => void; typeAnswer: () => void; dismiss: () => void; keySettings: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const control = useRef<(keepCapture?: boolean) => void>(() => {});
  const decided = useRef(false);
  const callbacks = useRef({accept, dismiss});
  const [state, setState] = useState<ConsentState>('connecting');
  const question = 'AI 보충 질문을 시작할까요?';
  useEffect(() => { callbacks.current = {accept, dismiss}; }, [accept, dismiss]);
  useEffect(() => {
    heading.current?.focus();
    if (issue || !prepared) return;
    if (document.hidden) { setState('unavailable'); return; }
    const speaker = window.speechSynthesis;
    let stopListening: ((keepCapture?: boolean) => void) | undefined;
    let pending = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clean = (keepCapture = false) => {
      pending = false;
      clearTimeout(timer);
      stopListening?.(keepCapture);
      speaker?.cancel();
    };
    control.current = clean;
    const pagehide = () => clean();
    window.addEventListener('pagehide', pagehide);
    const hide = () => {
      if (!document.hidden || !pending) return;
      clean();
      setState('unavailable');
    };
    document.addEventListener('visibilitychange', hide);
    function announce(listen: () => void) {
      if (!pending) return;
      if (document.hidden) { clean(); setState('unavailable'); return; }
      const done = () => {
        if (!pending) return;
        clearTimeout(timer);
        listen();
      };
      if (!speaker || typeof SpeechSynthesisUtterance === 'undefined') { done(); return; }
      setState('speaking');
      const invitation = new SpeechSynthesisUtterance('AI 보충 질문을 시작할까요? 예 또는 아니요라고 말씀하세요.');
      invitation.lang = 'ko-KR';
      invitation.onend = done;
      invitation.onerror = done;
      // Some browsers never report a blocked utterance; offer the same choice in text.
      timer = setTimeout(() => { speaker.cancel(); done(); }, 8_000);
      try { speaker.speak(invitation); } catch { done(); }
    }
    stopListening = listenForVoiceConsent(prepared, {
      onState: setState,
      onReady: announce,
      onDecision(approved) {
        if (!pending || decided.current) return;
        decided.current = true;
        clean();
        if (approved) { setState('accepted'); callbacks.current.accept(); }
        else callbacks.current.dismiss();
      },
    });
    return () => {
      clean();
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', pagehide);
    };
  }, [issue, prepared]);

  function choose(action: () => void, acceptChoice = false) {
    if (acceptChoice && decided.current) return;
    decided.current = true;
    control.current(acceptChoice);
    if (acceptChoice) setState('accepted');
    action();
  }

  return <section className="summary invitation" aria-labelledby="followup-invitation">
    <h2 id="followup-invitation" ref={heading} tabIndex={-1}>{question}</h2>
    <p>회의 원문은 저장했습니다. 동의하면 AI가 회의에서 빠진 점을 묻고 답변을 같은 기록에 따로 남깁니다.</p>
    {issue ? <p className="muted">{issue}</p>
      : <p className="consent-status" data-testid="voice-consent-status" data-state={prepared ? state : 'unavailable'} role="status">
        {prepared ? consentMessages[state] : consentMessages.unavailable}</p>}
    <div className="actions">
      <button className="button primary" disabled={!!issue || state === 'accepted'} onClick={() => choose(accept, true)}>보충 질문 시작</button>
      <button className="button quiet" onClick={() => choose(typeAnswer)}>글로 보충하기</button>
      <button className="button quiet" onClick={() => choose(dismiss)}>이대로 마치기</button>
      {issue && <button className="button quiet" onClick={() => choose(keySettings)}>API 키 설정</button>}
    </div>
  </section>;
}

function SpeakerNames({record, busy, rename}: {record: RecordData; busy: boolean; rename(id: string, name: string): void}) {
  const groups = speakerGroups(record);
  if (!groups.length) return null;
  return <details className="edit-record">
    <summary>화자 이름 관리 · {groups.length}개 그룹</summary>
    <p className="muted">한 그룹의 모든 발언에 이름을 적용합니다. 녹음 연결이 달라지면 같은 번호라도 동일인인지 확인할 수 없습니다.</p>
    {(['meeting','followup'] as const).map(area => {
      const speakers = groups.filter(group => group.area === area);
      return !!speakers.length && <section key={area}>
        <h3>{area === 'followup' ? '회의 후 보충 대화' : '회의 원문'}</h3>
        {speakers.map(({id,label,firstTurn,count,name}) => <form className="inline" key={id} onSubmit={event => {
          event.preventDefault();
          rename(id, String(new FormData(event.currentTarget).get('speaker') ?? ''));
        }}>
          <label>이름 · {label} · 첫 발언 {timeLabel(firstTurn.timeMs)}
            <small className="muted">{count}개 발언 · {firstTurn.text.slice(0,100)}</small>
            <input key={name} name="speaker" maxLength={100} defaultValue={name} placeholder="발언자 미확인" disabled={busy} />
          </label>
          <button className="button quiet" disabled={busy}>화자 이름 저장</button>
        </form>)}
      </section>;
    })}
  </details>;
}

type NoteEdits = { title?: string; project?: string; allowInMeetings?: boolean; categoryPath?: string };

export function Detail({ record, related, part, busy, open, back, summarize, correctTranscript, followup, offerFollowup, followupIssue, consentAudio,
  typedFollowup, typedAIAvailable, openTypedFollowup, closeTypedFollowup, loadTypedFollowup, saveTypedFollowup,
  dismissFollowup, keySettings, save, rename, reassign, speakerMatch, remove }: {
  record: RecordData; related: Evidence[]; part?: string; busy: boolean; open: Jump; back: () => void; summarize: () => void;
  correctTranscript?: () => void; followup: () => void;
  offerFollowup: boolean; followupIssue?: string; consentAudio?: ConsentAudio; dismissFollowup: () => void; keySettings: () => void;
  typedFollowup: boolean; typedAIAvailable: boolean; openTypedFollowup(): void; closeTypedFollowup(): void;
  loadTypedFollowup(): Promise<RecordData | undefined>; saveTypedFollowup(pair: TypedPair): Promise<void>;
  save(edits: NoteEdits): void; rename(speakerId: string, name: string): void; remove(): void;
  reassign(edit: (latest: RecordData) => RecordData): Promise<void>; speakerMatch?: boolean;
}) {
  const editBaseline = useRef(new Map<string, string | boolean>());
  const audio = useMeetingPlayback(record);
  useEffect(() => {
    const target = part && document.getElementById(summarySourceAnchor.test(part) ? 'summary' : part);
    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'center' });
    }
  }, [part, record.id]);
  const original = record.turns.filter(turn => turn.section !== 'followup');
  const supplemental = record.turns.filter(turn => turn.section === 'followup');
  const sources = pastSources(record.id, related);
  const answerSources = (turn: Turn) => {
    if (turn.role !== 'ai' || !turn.sourceRefs?.length) return null;
    const matches = sources.filter(item => turn.sourceRefs!.includes(item.reference));
    return matches.length ? <SavedSources sources={matches} quoted={currentQuotedRefs(turn, matches)} open={open} /> : null;
  };
  const markdown = summaryWithSpeakerNames(record);
  const summary = markdown ? summaryLines(markdown) : [];
  return <section className="page-stack">
    <button className="back" onClick={back} disabled={busy}>← 최근 노트</button>
    <div className="page-heading">
      <h1 className="record-title">{record.title}</h1>
      <p className="muted">{describe(record)}</p>
      {record.category && <p className="muted">분류: {record.category.join(' / ')}</p>}
      <div className="actions">
        <button className="button primary" disabled={busy || !record.turns.length} onClick={summarize}>{busy ? '처리 중…' : record.summary ? '요약 다시 만들기' : '요약 만들기'}</button>
        {correctTranscript && <button className="button quiet" disabled={busy} onClick={correctTranscript}
          aria-describedby="transcript-correction-help">전사 보정</button>}
        {!offerFollowup && !typedFollowup && record.kind === 'meeting' && !record.originalFilename && !!original.length && <>
          <button className="button quiet" disabled={busy} onClick={followup}>보충 질문하기</button>
          <button className="button quiet" disabled={busy} onClick={openTypedFollowup}>글로 보충하기</button>
        </>}
        <button className="button quiet" onClick={() => exportRecord(record)}><Icon name="download" /> Markdown 내보내기</button>
        {record.originalFilename && !part && <OriginalFile id={record.id} />}
      </div>
      {correctTranscript && <p className="muted" id="transcript-correction-help">전사 보정을 누르면 발언을 OpenAI에 보내 문맥에 맞게 보정합니다. 노트에는 보정본이 먼저 표시됩니다. 처음 받아쓴 문장은 발언 아래 ‘보정 전 원문 보기’와 Markdown 내보내기에서 확인할 수 있습니다.</p>}
    </div>
    {offerFollowup && <FollowupInvitation issue={followupIssue} prepared={consentAudio} accept={followup} typeAnswer={openTypedFollowup}
      dismiss={dismissFollowup} keySettings={keySettings} />}
    {typedFollowup && <TypedFollowup aiAvailable={typedAIAvailable} hasCachedQuestions={!!pendingTypedQuestions(record).length}
      busy={busy} load={loadTypedFollowup} save={saveTypedFollowup} close={closeTypedFollowup} />}
    <section id="summary" className="summary" tabIndex={-1}>
      <h2>요약</h2>
      {record.summaryNeedsSpeakerRefresh && <p className="notice">발언의 화자가 바뀌었습니다. 새 화자를 반영하려면 ‘요약 다시 만들기’를 누르세요.</p>}
      {part && summarySourceEvidence(record,part) && <p className="notice">요약에만 있는 내용 · 원문에서 확인되지 않았습니다.</p>}
      {summary.length ? summary : <p className="muted">아직 요약이 없습니다.</p>}
      {!record.summaryNeedsSpeakerRefresh && !!record.questions?.length && <><h3>확인할 사항</h3><ul>{record.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></>}
    </section>
    <details className="edit-record">
      <summary>기록 설정</summary>
      <form onChange={event => {
        const input = event.target;
        if (input instanceof HTMLInputElement && !editBaseline.current.has(input.name)) {
          editBaseline.current.set(input.name, input.type === 'checkbox' ? input.defaultChecked : input.defaultValue.trim());
        }
      }} onSubmit={event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const edits: NoteEdits = {};
        for (const [name, key] of [['title','title'], ['project','project'], ['category','categoryPath']] as const) {
          const value = String(data.get(name) ?? '').trim();
          if (editBaseline.current.has(name) && editBaseline.current.get(name) !== value) edits[key] = value;
        }
        const exclude = 'excludeFromMeetings';
        const checked = data.has(exclude);
        if (record.kind === 'personal' && editBaseline.current.has(exclude) && editBaseline.current.get(exclude) !== checked) {
          edits.allowInMeetings = !checked;
        }
        save(edits);
      }}>
        <label>기록 제목<input name="title" defaultValue={record.title} required maxLength={120} /></label>
        <label>프로젝트<input name="project" defaultValue={record.project} maxLength={120} /></label>
        <label>분류<input name="category" defaultValue={record.category?.join(' / ')} placeholder="예: 업무 / 정기 회의" /></label>
        <p className="muted">/ 로 최대 3단계까지 나눌 수 있습니다. 분류를 지우려면 비워 두고 저장하세요.</p>
        {record.kind === 'personal' && <label className="checkbox"><input type="checkbox" name="excludeFromMeetings" defaultChecked={!record.allowInMeetings} /> 회의에서 이 개인 기록 참고하지 않음</label>}
        <div className="actions"><button className="button primary" disabled={busy}>기록 설정 저장</button><button type="button" className="button danger" onClick={remove} disabled={busy}>기록 삭제</button></div>
      </form>
    </details>
    <SpeakerNames record={record} busy={busy} rename={rename} />
    <div className="original-heading">
      <h2>{record.originalFilename ? `문서 본문 · ${record.originalFilename}` : `원문 · ${original.length}개 발언`}</h2>
      {audio.wholeMeeting}
    </div>
    {original.length ? <Transcript turns={original} record={record} originalAt={part} afterTurn={turn => record.originalFilename && turn.id === part
      ? <OriginalFile id={record.id} /> : <>{audio.playAt(turn)}{answerSources(turn)}</>} /> : <div className="empty">아직 전사된 발언이 없습니다.</div>}
    {!!supplemental.length && <><h2>회의 후 보충 질문 · {supplemental.length}개 발언</h2><Transcript turns={supplemental} record={record} originalAt={part} afterTurn={answerSources} /></>}
    <SpeakerCorrection key={record.id} record={record} busy={busy} save={reassign} playAt={audio.playAt}
      findSimilar={audio.available && speakerMatch ? turn => findSimilarMeetingTurns(record,turn) : undefined}
      audioAvailable={audio.available} />
    {audio.player}
  </section>;
}

export function Search({ records, online, ask, open }: {
  records: RecordData[]; online: boolean; ask(question: string): Promise<{ answer: string; evidence: Evidence[] }>; open: Jump;
}) {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [reply, setReply] = useState<{ answer: string; evidence: Evidence[] }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const found = submitted ? searchRecords(records, submitted, undefined, { library: true }) : [];
  const sources = new Map(reply?.evidence.filter(item => records.some(record => record.id === item.recordId &&
    (item.summaryOnly ? !!item.targetId && !!summarySourceEvidence(record,item.targetId) : record.turns.some(turn => turn.id === item.turnId))))
    .map(item => [item.reference, item]));
  return <section className="page-stack">
    <div className="page-heading"><h1>기록 검색</h1><p className="muted">제목, 분류, 발언, 회의 요약을 이 브라우저에서 찾습니다.</p></div>
    <form className="inline" onSubmit={event => { event.preventDefault(); setSubmitted(query.trim()); setReply(undefined); setError(''); }}>
      <input aria-label="기록 검색" value={query} onChange={event => setQuery(event.target.value)} placeholder="무엇을 찾고 싶으세요?" maxLength={1800} />
      <button className="button primary" disabled={!query.trim() || busy}><Icon name="search" /> 검색 실행</button>
    </form>
    {submitted && <div className="section-heading"><h2>검색 결과 · {found.length}</h2><button className="button quiet" disabled={!online || busy} onClick={() => {
      setBusy(true);
      setError('');
      void ask(submitted).then(setReply)
        .catch(error => setError(error instanceof Error ? error.message : '답변을 만들지 못했습니다.'))
        .finally(() => setBusy(false));
    }}>{busy ? '답변 만드는 중…' : '이 기록에 AI로 질문'}</button></div>}
    {error && <p className="notice" role="alert">{error}</p>}
    {reply && <div className="summary"><h2>AI 답변</h2>{answerLines(reply.answer, sources, open)}
      {[...sources.values()].some(item => item.summaryOnly) && <SavedSources sources={[...sources.values()].filter(item => item.summaryOnly)} open={open}/>}
    </div>}
    {submitted && !found.length && <div className="empty">일치하는 기록이 없습니다.</div>}
    <ul className="records">{found.map(item => <li key={item.reference}>
      <button className="record-row" onClick={() => open(item.recordId, item.turnId ?? 'summary')}>
        <span className="empty-icon"><Icon name="file" /></span><span className="record-name"><strong>{item.title}</strong><small>{item.text}</small></span><Icon name="arrow" />
      </button>
    </li>)}</ul>
  </section>;
}

function KeyField({ name, provider, purpose, configured }: {
  name: keyof ProviderKeys; provider: string; purpose: string; configured: boolean | undefined;
}) {
  return <div className="key-field">
    <div className="key-label">
      <label htmlFor={name}>{provider} API 키</label>
      <span className={configured ? 'badge configured' : 'badge'}>{configured ? '키 저장됨' : configured === false ? '키 필요' : '상태 확인 필요'}</span>
    </div>
    <input id={name} name={name} type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false}
      placeholder={configured ? '변경할 때 새 키 입력' : 'API 키 붙여넣기'} aria-describedby={`${name}-purpose`} />
    <small className="muted" id={`${name}-purpose`}>{purpose}</small>
  </div>;
}

export function Settings({ health, checked, busy, refresh, save, voice, changeVoice }: {
  health?: Health; checked: boolean; busy: boolean; refresh: () => void;
  save: (keys: ProviderKeys, resetForm: () => void) => void;
  voice: AiVoice; changeVoice: (value: AiVoice) => void;
}) {
  const [inputError, setInputError] = useState('');
  return <section className="page-stack" aria-label="설정">
    <div className="summary">
      <div className="section-heading"><h2>API 키</h2><button className="button quiet" onClick={refresh} disabled={busy || !checked}>새로고침</button></div>
      <p role="status">{!checked ? '연결 확인 중…' : health ? '로컬 서버가 연결되어 있습니다.' : '로컬 서버에 연결할 수 없습니다. 서버 실행 창을 확인하세요.'}</p>
      <form className="key-form" autoComplete="off" onChange={() => setInputError('')} onSubmit={event => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        const openaiKey = String(data.get('openaiKey') ?? '').trim();
        const sonioxKey = String(data.get('sonioxKey') ?? '').trim();
        if (!openaiKey && !sonioxKey) { setInputError('저장할 API 키를 입력하세요.'); return; }
        save({ ...(openaiKey && { openaiKey }), ...(sonioxKey && { sonioxKey }) }, () => form.reset());
      }}>
        <fieldset disabled={!health || !checked || busy}>
          <KeyField name="openaiKey" provider="OpenAI" purpose="AI 음성 답변, 기록 요약 및 자동 분류"
            configured={health && health.providers.live && health.providers.text} />
          <KeyField name="sonioxKey" provider="Soniox" purpose="개인 대화, 회의 및 보충 질문 답변 전사"
            configured={health?.providers.soniox} />
          <button type="submit" className="button primary">{busy ? '저장 중…' : 'API 키 저장'}</button>
        </fieldset>
        {inputError && <p role="alert">{inputError}</p>}
        <p className="muted">비워 둔 항목은 기존 설정을 유지합니다. 키는 이 기기의 로컬 서버에 저장되고 화면에는 다시 표시되지 않습니다.</p>
        <p className="muted">표시된 상태는 키가 설정됐는지를 알려줍니다. 키의 유효성과 서비스 연결은 해당 기능을 실행할 때 확인됩니다.</p>
      </form>
    </div>
    <VoiceSettings voice={voice} change={changeVoice} disabled={busy} canPreview={!!health?.providers.live} />
    <p className="muted">원문과 요약은 로컬 PC에 저장됩니다. 웹앱과 데스크톱 앱은 기록을 따로 보관하며, 다른 브라우저와도 자동으로 동기화되지 않습니다.</p>
  </section>;
}
