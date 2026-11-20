import React, { useEffect, useRef, useState } from 'react';
import type { RecordData } from '../src/records/model.ts';
import { pendingTypedQuestions, typedJudgeRequest, typedQuestionRequest,
  TYPED_ANSWER_LIMIT, TYPED_QUESTION_LIMIT, type TypedPair, type TypedVerdict } from '../src/typedFollowup.ts';
import { judgeTypedAnswer, nextTypedQuestion } from './api.ts';

type Judge = ReturnType<typeof typedJudgeRequest>;
type Question = { text: string; remaining: string[] };
type Props = {
  aiAvailable: boolean;
  hasCachedQuestions: boolean;
  busy: boolean;
  load(): Promise<RecordData | undefined>;
  save(pair: TypedPair): Promise<void>;
  close(): void;
};

export function TypedFollowup({ aiAvailable, hasCachedQuestions, busy, load, save, close }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const [stage, setStage] = useState<'choose'|'ai'|'manual'|'done'>('choose');
  const [question, setQuestion] = useState<Question>();
  const [manualQuestion, setManualQuestion] = useState('');
  const [draft, setDraft] = useState('');
  const [work, setWork] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState<Judge>();
  const disabled = busy || !!work;

  useEffect(() => {
    mounted.current = true;
    heading.current?.focus();
    return () => { mounted.current = false; };
  }, []);

  async function run(label: string, action: () => Promise<void>) {
    if (busy || inFlight.current) return;
    inFlight.current = true;
    setWork(label);
    setMessage('');
    setError('');
    try { await action(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '요청을 완료하지 못했습니다.'); }
    finally { inFlight.current = false; if (mounted.current) setWork(''); }
  }

  function advance(remaining: string[]) {
    setRetry(undefined);
    const [text, ...next] = remaining;
    if (text) setQuestion({text, remaining:next});
    else {
      setStage('done');
      setQuestion(undefined);
      setMessage('AI 보충 질문을 마쳤습니다.');
    }
  }

  async function startAI() {
    const record = await load();
    if (!mounted.current) return;
    if (!record) throw Error('보충할 회의 기록을 찾을 수 없습니다.');
    const queued = pendingTypedQuestions(record).slice(0, 5);
    if (!queued.length && !aiAvailable) throw Error('저장된 질문이 없습니다. OpenAI를 연결하거나 직접 기록할 수 있습니다.');
    setStage('ai');
    if (queued.length) { advance(queued); return; }
    try {
      const request = typedQuestionRequest(record);
      const text = request && await nextTypedQuestion(request);
      if (!mounted.current) return;
      if (text) advance([text]);
      else { advance([]); setMessage('추가로 확인할 질문이 없습니다.'); }
    } catch (cause) {
      if (mounted.current) setStage('choose');
      throw cause;
    }
  }

  function applyVerdict(verdict: TypedVerdict, current: Question) {
    setRetry(undefined);
    if (verdict === 'advance') advance(current.remaining);
    else if (verdict === 'complete') advance([]);
    else setMessage(verdict === 'clarify' ? '답변을 저장했습니다. 조금 더 구체적으로 적어 주세요.' :
      '답변을 저장했습니다. 질문에 대한 답을 조금 더 적거나 다음으로 넘어갈 수 있습니다.');
  }

  async function judge(request: Judge, current: Question) {
    try {
      const verdict = await judgeTypedAnswer(request);
      if (mounted.current) applyVerdict(verdict, current);
    } catch {
      if (!mounted.current) return;
      setRetry(request);
      throw Error('답변은 저장했습니다. AI가 확인하지 못했습니다. 확인을 다시 시도하거나 다음으로 넘어갈 수 있습니다.');
    }
  }

  async function submitAI(current: Question) {
    const body = typedJudgeRequest(current.text, draft, current.remaining);
    await save({ id:crypto.randomUUID(), origin:'ai', question:body.question, answer:body.answer });
    if (!mounted.current) return;
    setDraft('');
    if (aiAvailable) await judge(body, current);
    else {
      advance(current.remaining);
      setMessage('답변을 저장했습니다. OpenAI가 연결되지 않아 답변 확인은 건너뛰었습니다.');
    }
  }

  async function submitManual() {
    await save({ id:crypto.randomUUID(), origin:'manual', question:manualQuestion, answer:draft });
    if (!mounted.current) return;
    setManualQuestion('');
    setDraft('');
    setMessage('직접 입력한 질문과 답변을 저장했습니다.');
  }

  function select(next: 'choose'|'manual') {
    setStage(next);
    setDraft('');
    setManualQuestion('');
    setMessage('');
    setError('');
    setRetry(undefined);
  }

  return <section className="summary typed-followup" aria-labelledby="typed-followup-title" aria-busy={!!work}>
    <h2 id="typed-followup-title" ref={heading} tabIndex={-1}>글로 보충하기</h2>
    <p className="muted">마이크를 쓰지 않습니다. 저장한 질문과 답변은 이 회의의 보충 기록에 남습니다.</p>
    {stage === 'choose' && <>
      {!aiAvailable && <p className="muted">{hasCachedQuestions
        ? '저장된 AI 질문에 답할 수 있습니다. 새 질문과 답변 확인에는 OpenAI 연결이 필요합니다.'
        : 'AI 질문을 받으려면 OpenAI 연결이 필요합니다. 직접 기록은 바로 사용할 수 있습니다.'}</p>}
      <div className="actions">
        <button className="button primary" disabled={disabled || (!aiAvailable && !hasCachedQuestions)} onClick={() => void run('AI 질문을 확인하는 중…', startAI)}>AI 질문 받기</button>
        <button className="button quiet" disabled={disabled} onClick={() => select('manual')}>직접 질문과 답변 기록</button>
      </div>
    </>}
    {stage === 'ai' && question && <form onSubmit={event => {
      event.preventDefault();
      void run('답변을 저장하고 확인하는 중…', () => submitAI(question));
    }}>
      <p className="typed-question"><strong>AI 질문</strong><br />{question.text}</p>
      <label>AI 질문에 대한 답변<textarea value={draft} disabled={disabled || !!retry} rows={4} maxLength={TYPED_ANSWER_LIMIT} required onChange={event => setDraft(event.target.value)} /></label>
      <div className="actions">
        {retry ? <button type="button" className="button primary" disabled={disabled} onClick={() => void run('답변을 확인하는 중…', () => judge(retry, question))}>답변 확인 다시 시도</button>
          : <button className="button primary" disabled={disabled || !draft.trim()}>답변 저장</button>}
        <button type="button" className="button quiet" disabled={disabled} onClick={() => {
          setDraft(''); setError(''); setMessage(''); advance(question.remaining);
        }}>{question.remaining.length ? '다음 질문으로' : 'AI 질문 마치기'}</button>
      </div>
    </form>}
    {stage === 'manual' && <form onSubmit={event => { event.preventDefault(); void run('직접 입력한 내용을 저장하는 중…', submitManual); }}>
      <label>직접 입력할 질문<textarea value={manualQuestion} disabled={disabled} rows={2} maxLength={TYPED_QUESTION_LIMIT} required onChange={event => setManualQuestion(event.target.value)} /></label>
      <label>직접 입력할 답변<textarea value={draft} disabled={disabled} rows={4} maxLength={TYPED_ANSWER_LIMIT} required onChange={event => setDraft(event.target.value)} /></label>
      <button className="button primary" disabled={disabled || !manualQuestion.trim() || !draft.trim()}>질문과 답변 저장</button>
    </form>}
    {work && <p role="status">{work}</p>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert" className="notice">{error}</p>}
    <div className="actions">
      {stage !== 'choose' && <button className="button quiet" disabled={disabled} onClick={() => select('choose')}>보충 방법 선택</button>}
      <button className="button quiet" disabled={disabled} onClick={close}>글 보충 닫기</button>
    </div>
  </section>;
}
