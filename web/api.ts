import { compactParts, draftContext } from '../src/workflow.ts';
import { isCategoryPath, type RecordData } from '../src/records/core.ts';
import { TYPED_QUESTION_LIMIT, typedJudgeRequest, typedQuestionRequest, type TypedVerdict } from '../src/typedFollowup.ts';
import { readVoicePreview } from '../src/voice-preview.ts';
import type { AiVoice } from '../server/voices.mjs';

export type Health = { ok: true; providers: { live: boolean; soniox: boolean; text: boolean } };
export type ProviderKeys = { openaiKey?: string; sonioxKey?: string };
type Summary = { markdown: string; questions: string[] };

async function request<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    redirect: 'error',
    ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90_000),
  });
  const result = await response.json();
  if (!response.ok) throw Error(typeof result.error === 'string' ? result.error : '서버 요청에 실패했습니다.');
  return result as T;
}

export const health = () => request<Health>('/health');
export const saveKeys = (keys: ProviderKeys) => request<Health>('/settings/keys', keys);
export async function fetchVoicePreview(voice: AiVoice, signal: AbortSignal) {
  const response = await fetch('/v1/voice-preview', {
    method:'POST', credentials:'same-origin', redirect:'error', signal,
    headers:{'Content-Type':'application/json'}, body:JSON.stringify({voice}),
  });
  return readVoicePreview(response);
}
export const answer = (question: string, context: string) =>
  request<{ answer: string }>('/answer', { question, context });

export async function nextTypedQuestion(body: NonNullable<ReturnType<typeof typedQuestionRequest>>): Promise<string | null> {
  const result = await request<{ question?: unknown }>('/followup', body);
  if (result?.question === null) return null;
  if (typeof result?.question === 'string' && result.question.trim() && result.question.length <= TYPED_QUESTION_LIMIT) return result.question.trim();
  throw Error('AI 보충 질문 응답을 읽지 못했습니다.');
}

export async function judgeTypedAnswer(body: ReturnType<typeof typedJudgeRequest>): Promise<TypedVerdict> {
  const result = await request<{ verdict?: unknown }>('/followup', body);
  const verdict = result?.verdict;
  if (verdict === 'advance' || verdict === 'clarify' || verdict === 'wait' || verdict === 'complete') return verdict;
  throw Error('AI 답변 확인 결과를 읽지 못했습니다.');
}

export type CategoryAssignment = { id: string; path: string[] };
const classifyBatchSize = 24;

const excerpt = (value: string, max: number) => value.trim().replace(/\s+/gu, ' ')
  .slice(0, max).replace(/[\uD800-\uDBFF]$/u, '').trimEnd();

function classificationRecord(record: RecordData) {
  const title = excerpt(record.title, 120) || (record.kind === 'meeting' ? '회의' : '개인 대화');
  const project = excerpt(record.project ?? '', 120);
  let sample = excerpt(record.summary ?? '', 400);
  if (!sample) {
    for (const turn of record.turns) {
      if (turn.role === 'ai') continue;
      sample = excerpt(`${sample} ${turn.text}`, 400);
      if (sample.length >= 399) break;
    }
  }
  return {id: record.id, kind: record.kind, title, ...(project && {project}), excerpt: sample};
}

function assignmentsFor(value: unknown, ids: string[]): CategoryAssignment[] {
  const result = (value as { assignments?: unknown } | undefined)?.assignments;
  const remaining = new Set(ids);
  const error = '서버 분류 결과를 확인할 수 없습니다.';
  if (!Array.isArray(result) || result.length !== ids.length) throw Error(error);
  const assignments = result.map(item => {
    if (!item || !remaining.delete(item.id) || !isCategoryPath(item.path)) throw Error(error);
    return {id: item.id as string, path: item.path};
  });
  if (remaining.size) throw Error(error);
  return assignments;
}

export async function classifyRecords(records: readonly RecordData[], knownPaths: readonly (readonly string[])[] = []): Promise<CategoryAssignment[]> {
  const paths = new Map<string, string[]>();
  const remember = (path: readonly string[]) => {
    if (paths.size >= 24 || !isCategoryPath(path)) return;
    paths.set(JSON.stringify(path), path);
  };
  for (const path of knownPaths) remember(path);
  const all: CategoryAssignment[] = [];
  for (let i = 0; i < records.length; i += classifyBatchSize) {
    const batch = records.slice(i, i + classifyBatchSize).map(classificationRecord);
    const result = await request<unknown>('/categories', {records: batch, ...(paths.size && {knownPaths: [...paths.values()]})});
    const assignments = assignmentsFor(result, batch.map(({id}) => id));
    for (const assignment of assignments) remember(assignment.path);
    all.push(...assignments);
  }
  return all;
}

export async function summarize(kind: 'personal' | 'meeting', transcript: string, related: string) {
  const summarizePart = (context: string) => request<Summary>('/summary', { kind, context });
  const limit = 30_000;
  let parts = compactParts([transcript], limit);
  while (parts.length > 1) {
    const drafts: string[] = [];
    for (const context of parts) {
      const draft = await summarizePart(context);
      drafts.push(draftContext(draft.markdown, draft.questions, context));
    }
    const merged = compactParts(drafts, limit);
    if (merged.length >= parts.length) throw Error('중간 요약이 너무 깁니다. 원문은 그대로 남아 있습니다.');
    parts = merged;
  }
  return summarizePart([...parts, related].filter(Boolean).join('\n\n').slice(0, 45_000));
}
