import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { timeLabel, type Evidence } from '../src/records/core.ts';
import { noteFiles } from './note-files.ts';
import { date, Icon, type Jump } from './ui.tsx';

type PastSource = Evidence;

export function pastSources(recordId: string, evidence: Evidence[]) {
  const sources = new Map<string, PastSource>();
  for (const item of evidence) {
    if ((!item.turnId && !item.summaryOnly) || item.recordId === recordId) continue;
    sources.set(item.reference, item);
  }
  return [...sources.values()];
}

function SourceMetadata({ item }: { item: PastSource }) {
  return <span className="source-meta">
    <time dateTime={item.createdAt}>{date.format(new Date(item.createdAt))}</time>
    {item.summaryOnly && <span> · 요약에만 있는 내용</span>}
    {item.originalFilename && <span> · 가져온 문서</span>}
    {item.timeMs !== undefined && <span> · 발언 위치 {timeLabel(item.timeMs)}</span>}
  </span>;
}

export function OriginalFile({id}: {id: string}) {
  const [error, setError] = useState(false);
  const desktop = noteFiles();
  if (!desktop) return null;
  return <div className="original-file">
    <button type="button" className="button quiet" onClick={() => {
      setError(false);
      void desktop.revealOriginal(id).then(found => setError(!found), () => setError(true));
    }}>원본 파일 위치 열기</button>
    {error && <small role="alert">원본 파일을 찾지 못했습니다. 노트 저장 폴더를 확인해 주세요.</small>}
  </div>;
}

function SourceLabel({ item }: { item: PastSource }) {
  return <><span className="source-label"><strong>{item.title}</strong><SourceMetadata item={item} /></span><Icon name="arrow" /></>;
}

function SourceGroups({ sources, quoted, render }: { sources: PastSource[]; quoted?: string[]; render: (item: PastSource) => ReactNode }) {
  const original = sources.filter(item => !item.summaryOnly);
  const direct = original.filter(item => quoted?.includes(item.reference));
  const provided = original.filter(item => !quoted?.includes(item.reference));
  const groups: [PastSource[], string][] = [[direct, '답변에서 직접 인용한 원문'],
    [provided, direct.length ? '답변에 제공한 다른 원문' : '답변에 제공한 원문'],
    [sources.filter(item => item.summaryOnly), '요약에만 있는 내용']];
  return <>{groups.map(([items, label]) => {
    return items.length ? <div key={label}><h3>{label}</h3><ul className="source-entries" aria-label={label} role="list">
      {items.map(item => <li key={item.reference}>{render(item)}</li>)}
    </ul></div> : null;
  })}</>;
}

export function VoiceSources({ sources, quoted }: { sources: PastSource[]; quoted?: string[] }) {
  const headingId = useId();
  const readerId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [selectedRef, setSelected] = useState<string>();
  const selected = sources.find(item => item.reference === selectedRef);

  useEffect(() => {
    if (selected && dialog.current && !dialog.current.open) dialog.current.showModal();
    if (!selected && dialog.current?.open) dialog.current.close();
  }, [selected]);

  return <>
    {!!sources.length && <section className="source-panel" aria-labelledby={headingId} data-testid="live-sources">
      <h2 id={headingId}>{sources.some(item => item.summaryOnly) ? '이 답변의 참고 기록' : '이 답변의 과거 원문'}</h2>
      <SourceGroups sources={sources} quoted={quoted} render={item =>
        <button type="button" className="source-entry" aria-haspopup="dialog" onClick={event => {
          opener.current = event.currentTarget;
          setSelected(item.reference);
        }}><SourceLabel item={item} /></button>} />
    </section>}
    <dialog className="source-reader" ref={dialog} aria-labelledby={readerId} data-testid="source-reader" onClose={() => {
      setSelected(undefined);
      opener.current?.focus();
    }}>
      <header className="source-reader-header">
        <h2 id={readerId}>{selected?.summaryOnly ? '요약에만 있는 내용' : '원문 보기'}</h2>
        <form method="dialog"><button type="submit" className="button quiet">닫기</button></form>
      </header>
      {selected && <article>
        <h3>{selected.title}</h3>
        <SourceMetadata item={selected} />
        <p className="source-reader-text">{selected.text}</p>
        {selected.originalFilename && <OriginalFile key={selected.recordId} id={selected.recordId} />}
      </article>}
    </dialog>
  </>;
}

export function SourceLink({ item, open, className, children }: { item: Evidence; open: Jump; className: string; children: ReactNode }) {
  const part = item.targetId ?? item.turnId ?? 'summary';
  return <a className={className} href={`#record:${encodeURIComponent(item.recordId)}#${encodeURIComponent(part)}`} onClick={event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open(item.recordId, part);
  }}>{children}</a>;
}

export function SavedSources({ sources, quoted, open }: { sources: PastSource[]; quoted?: string[]; open: Jump }) {
  const headingId = useId();
  return <section className="source-panel" aria-labelledby={headingId} data-testid="saved-sources">
    <h2 id={headingId}>{sources.some(item => item.summaryOnly) ? '이 답변의 참고 기록' : '이 답변의 과거 원문'}</h2>
    <SourceGroups sources={sources} quoted={quoted} render={item =>
      <SourceLink item={item} open={open} className="source-entry"><SourceLabel item={item} /></SourceLink>} />
  </section>;
}
