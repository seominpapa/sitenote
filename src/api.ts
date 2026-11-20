import * as SecureStore from 'expo-secure-store';
import { fetch } from 'expo/fetch';
import { TYPED_QUESTION_LIMIT, typedJudgeRequest, typedQuestionRequest, type TypedVerdict } from './typedFollowup';
import { compactParts, draftContext, type Connection } from './workflow';
import { isAiVoice, type AiVoice } from '../server/voices.mjs';
import { readVoicePreview } from './voice-preview';

const settingsKey = 'sitenote.connection.v1';
export type Settings = Partial<Connection> & {keepAudio?: boolean; voice?: AiVoice};
export type Health = {ok: true; providers: {live: boolean; soniox: boolean; text: boolean}};
export type Summary = {markdown: string; questions: string[]};

export async function loadSettings(): Promise<Settings> {
  const raw = await SecureStore.getItemAsync(settingsKey);
  if (!raw) return {};
  const stored = JSON.parse(raw);
  return {...stored, voice:isAiVoice(stored?.voice) ? stored.voice : undefined};
}

export async function saveSettings(settings: Settings) {
  await SecureStore.setItemAsync(settingsKey, JSON.stringify(settings));
}

async function request<T>(connection: Connection, path: string, body?: object): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(connection.url + path, {
      method: body ? 'POST' : 'GET',
      headers: {Authorization: 'Bearer ' + connection.token, ...(body && {'Content-Type': 'application/json'})},
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: controller.signal,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : '서버가 요청을 처리하지 못했습니다.');
    return result as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('서버 응답이 지연되었습니다. 다시 시도해 주세요.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const health = (c: Connection) => request<Health>(c, '/health');
export async function fetchVoicePreview(connection: Connection, voice: AiVoice, signal: AbortSignal) {
  const response = await fetch(connection.url + '/v1/voice-preview', {
    method:'POST', redirect:'error', signal,
    headers:{Authorization:'Bearer ' + connection.token, 'Content-Type':'application/json'}, body:JSON.stringify({voice}),
  });
  return readVoicePreview(response);
}
export const answer = (c: Connection, question: string, context: string, history?: string) =>
  request<{answer: string}>(c, '/answer', {question, context, history});

export async function generateFollowup(c: Connection, input: NonNullable<ReturnType<typeof typedQuestionRequest>>) {
  const result = await request<{question?: unknown}>(c, '/followup', input);
  if (result.question === null) return null;
  const question = typeof result.question === 'string' ? result.question.trim() : '';
  if (!question || question.length > TYPED_QUESTION_LIMIT) throw new Error('서버가 보완 질문을 반환하지 않았습니다.');
  return question;
}

export async function judgeFollowup(c: Connection, input: ReturnType<typeof typedJudgeRequest>): Promise<TypedVerdict> {
  const {verdict} = await request<{verdict?: unknown}>(c, '/followup', input);
  if (verdict === 'advance' || verdict === 'clarify' || verdict === 'wait' || verdict === 'complete') return verdict;
  throw new Error('서버가 보완 답변 확인 결과를 반환하지 않았습니다.');
}

export async function summarize(c: Connection, kind: 'personal'|'meeting', transcript: string, related: string): Promise<Summary> {
  const limit = 30_000;
  const summary = (context: string) => request<Summary>(c, '/summary', {kind, context});
  let parts = compactParts([transcript], limit);
  if (parts.length <= 1) return summary([transcript, related].filter(Boolean).join('\n\n').slice(0, 45_000));
  while (parts.length > 1) {
    const drafts: string[] = [];
    for (const context of parts) {
      const draft = await summary(context);
      drafts.push(draftContext(draft.markdown, draft.questions, context));
    }
    parts = compactParts(drafts, limit);
    if (parts.length >= drafts.length) throw new Error('중간 요약이 너무 깁니다. 원문은 저장되어 있습니다.');
  }
  return summary(['구간별 요약 자료 (각 구간의 원문 참조를 보존):', ...parts, related].join('\n\n').slice(0, 45_000));
}
