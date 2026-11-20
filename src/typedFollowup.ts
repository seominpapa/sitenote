import { applyTurn, assertDate, assertId, type RecordData } from './records/model.ts';

export const TYPED_QUESTION_LIMIT = 500;
export const TYPED_ANSWER_LIMIT = 2_000;
const HISTORY_LIMIT = 5;
const HISTORY_QUESTION_LIMIT = 240;
const normalizeQuestion = (value: string) => value.normalize('NFC').trim().replace(/\s+/gu, ' ');
const historyClip = (value: string) => clip(value, HISTORY_QUESTION_LIMIT);

export type TypedPair = {id: string; origin: 'ai'|'manual'; question: string; answer: string};
export type TypedVerdict = 'advance'|'clarify'|'wait'|'complete';

function clip(value: string, length: number): string {
  if (value.length <= length) return value;
  return value.slice(0, /[\uD800-\uDBFF]/.test(value[length - 1]) ? length - 1 : length);
}

function requireText(value: string, length: number, name: string): string {
  const text = value.trim().replace(/\r\n?/g, '\n');
  if (!text || text.length > length) throw new Error(`${name}은 1~${length}자로 입력해 주세요.`);
  return text;
}

export function appendTypedFollowup(record: RecordData, pair: TypedPair, now = new Date().toISOString()): RecordData {
  if (record.kind !== 'meeting') throw new Error('회의에만 보완 내용을 저장할 수 있습니다.');
  const question = requireText(pair.question, TYPED_QUESTION_LIMIT, '질문');
  const answer = requireText(pair.answer, TYPED_ANSWER_LIMIT, '답변');
  assertDate(now);
  assertId(pair.id);
  const questionId = pair.id + '-question';
  const answerId = pair.id + '-answer';
  if (record.turns.some(turn => turn.id === questionId || turn.id === answerId)) {
    throw new Error('이미 저장된 보완 내용입니다.');
  }
  const timeMs = Math.max(Date.parse(now) - Date.parse(record.createdAt), (record.turns.at(-1)?.timeMs ?? -1) + 1);
  return applyTurn(applyTurn(record, {
    id: questionId, section:'followup', role: pair.origin === 'ai' ? 'ai' : 'user', entry:'typed-question', text:question, timeMs,
  }, now), {
    id: answerId, section:'followup', role:'user', entry:'typed-answer', text:answer, timeMs:timeMs + 1,
  }, now);
}

function answeredQuestions(record: RecordData): Set<string> {
  const answered = new Set<string>();
  let prompt: RecordData['turns'][number] | undefined;
  for (const turn of record.turns) {
    if (turn.section !== 'followup') { prompt = undefined; continue; }
    if (turn.role === 'ai') { prompt = turn.interrupted ? undefined : turn; continue; }
    if (!prompt || turn.interrupted || !turn.text.trim()) continue;
    const typed = prompt.entry === 'typed-question';
    if (typed && turn.entry === 'typed-answer' && prompt.id === turn.id.replace(/-answer$/, '-question') ||
        !typed && !turn.entry) {
      answered.add(normalizeQuestion(prompt.text));
      prompt = undefined;
    } else if (turn.entry) prompt = undefined;
  }
  return answered;
}

export function pendingTypedQuestions(record: RecordData): string[] {
  const answered = answeredQuestions(record);
  return [...new Set((record.questions ?? []).map(normalizeQuestion))]
    .filter(question => question && question.length <= TYPED_QUESTION_LIMIT && !answered.has(question));
}

export function typedQuestionRequest(record: RecordData) {
  const summary = record.summary?.trim();
  const humanTurns = record.turns.filter(turn => turn.role !== 'ai' && turn.entry !== 'typed-question' && turn.text.trim())
    .slice(-10);
  if (!summary && !humanTurns.length) return undefined;
  const transcript = humanTurns.map(turn => ({
    section:turn.section, speaker:turn.speakerId && Object.hasOwn(record.speakers, turn.speakerId)
      ? clip(record.speakers[turn.speakerId], 100) : undefined,
    excerpt:clip(turn.text.trim(), 450),
  }));
  const title = clip(record.title, 120);
  let summaryExcerpt = summary && clip(summary, 4_400);
  let context = JSON.stringify({title, summary:summaryExcerpt, transcript});
  while (context.length > 8_000) {
    if (transcript.length > 1) transcript.shift();
    else summaryExcerpt = clip(summaryExcerpt ?? '', Math.floor((summaryExcerpt?.length ?? 0) / 2));
    context = JSON.stringify({title, summary:summaryExcerpt, transcript});
  }
  const previousQuestions = [...new Set([...answeredQuestions(record)].reverse().map(historyClip))].slice(0, HISTORY_LIMIT);
  return {action:'question' as const, context, previousQuestions};
}

export function typedJudgeRequest(question: string, answer: string, remaining: readonly string[]) {
  return {
    action:'judge' as const,
    question:requireText(question, TYPED_QUESTION_LIMIT, '질문'),
    answer:requireText(answer, TYPED_ANSWER_LIMIT, '답변'),
    hasNext:remaining.length > 0,
    context:remaining.slice(0, HISTORY_LIMIT).map(normalizeQuestion).map(historyClip).filter(Boolean),
  };
}
