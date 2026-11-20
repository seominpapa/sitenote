import { quotedReferences } from '../server/voice-quotes.mjs';
import { isOriginalTurn, parseOriginalSourceRef, recordInScope, searchContext, searchHumanOriginals, searchRecords, turnEvidence,
  type Evidence, type RecordData, type SearchScope, type Turn } from './records/core.ts';

export function scopeFor(record: RecordData): SearchScope {
  return {mode: record.kind, project: record.kind === 'meeting' ? record.project : undefined, currentRecordId: record.id};
}

function allowedPastRecords(records: readonly RecordData[], active: RecordData): RecordData[] {
  const scope = scopeFor(active);
  // Distinct records can be created in the same millisecond.
  return records.filter(record => record.id !== active.id && record.createdAt <= active.createdAt && recordInScope(record,scope));
}

export function searchPastOriginals(records: readonly RecordData[], record: RecordData, query: string, previousQuery?: string): Evidence[] {
  return searchHumanOriginals(allowedPastRecords(records, record), query, previousQuery);
}

export function searchOriginalAnswers(records: readonly RecordData[], query: string, previousQuery?: string): Evidence[] {
  return searchHumanOriginals(records, query, previousQuery);
}

export function resolveOriginalSources(records: readonly RecordData[], record: RecordData, refs: readonly string[]): Evidence[] {
  if (!refs.length) return [];
  const allowed = new Map(allowedPastRecords(records, record).map(item => [item.id, item]));
  return [...new Set(refs)].flatMap(ref => {
    const parts = parseOriginalSourceRef(ref);
    if (!parts) return [];
    const source = allowed.get(parts.recordId);
    const turn = source?.turns.find(candidate => candidate.id === parts.turnId && isOriginalTurn(candidate));
    return source && turn ? [turnEvidence(source, turn)] : [];
  });
}

export function currentQuotedRefs(turn: Turn, sources: readonly Evidence[]): string[] {
  if (turn.role !== 'ai' || !turn.quotedRefs?.length || !turn.sourceRefs?.length) return [];
  const provided = new Set(turn.sourceRefs);
  const candidates = sources.filter(source => provided.has(source.reference))
    .map(({reference, text}) => ({reference, excerpt:text}));
  const matches = new Set(quotedReferences(turn.text, candidates));
  // The original verification and the current source must agree. A correction only removes attribution.
  return turn.quotedRefs.filter(ref => matches.has(ref));
}

function quote(value: unknown) {
  return JSON.stringify(value).replace(/\[record:/gi, '\\u005brecord:');
}

export function analysisContext(record: RecordData): string {
  const header = {title: record.title, project: record.project, date: record.createdAt};
  return [quote(header), ...record.turns.map(turn => {
    const evidence = turnEvidence(record, turn);
    return evidence.reference + '\n' + quote({
      ...header, section: turn.section, role: turn.role, timeMs: turn.timeMs,
      speaker: evidence.speaker, interrupted: turn.interrupted, text: turn.text,
    });
  })].join('\n\n');
}

export function liveContext(record: RecordData, followup = false): {context: string; evidence: Evidence[]} {
  const evidence = record.turns.slice(-10).map(turn => turnEvidence(record, turn));
  const notes = followup && record.summary
    ? '요약 초안과 확인 사항 (참고 데이터):\n' + quote({summary: record.summary.slice(0, 4800), questions: record.questions?.slice(0, 15)})
    : '';
  return {evidence, context: [notes, '현재 기록의 최근 발언 (참고 데이터):', searchContext(evidence)].filter(Boolean).join('\n')};
}

export function relatedRecords(records: RecordData[], record: RecordData) {
  const terms = [record.project, record.title, ...record.turns.filter(turn => turn.role !== 'ai').slice(-5).map(turn => turn.text)]
    .filter(Boolean).join(' ').slice(0, 1800);
  return searchRecords(records.filter(item => item.id !== record.id), terms, scopeFor(record), {limit: 4});
}
