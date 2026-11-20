import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import type { RecordData } from '../records/model';
import { pendingTypedQuestions, TYPED_ANSWER_LIMIT, TYPED_QUESTION_LIMIT, type TypedPair, type TypedVerdict } from '../typedFollowup';
import { Button, Field, Notice, styles } from './base';

type Pair = Omit<TypedPair, 'id'>;
export type SupplementActions = {
  save: (pair: Pair) => Promise<void>;
  generate?: () => Promise<string|null>;
  judge?: (question: string, answer: string, remaining: readonly string[]) => Promise<TypedVerdict>;
};

const explain = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;
const entryStyle = {minHeight: 100, textAlignVertical: 'top' as const};

export function Supplement({record, actions, working}: {record: RecordData; actions: SupplementActions; working: boolean}) {
  const [custom, setCustom] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [typed, setTyped] = useState('');
  const [selected, setSelected] = useState<string>();
  const [skipped, setSkipped] = useState<string[]>([]);
  const [active, setActive] = useState<'generate'|'answer'|'manual'>();
  const [note, setNote] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const running = useRef(false);
  const known = pendingTypedQuestions(record).filter(value => !skipped.includes(value));
  const prompt = selected ?? known[0];
  const remaining = known.filter(value => value !== prompt);
  const disabled = working || !!active;

  async function run(mode: NonNullable<typeof active>, task: () => Promise<void>) {
    if (working || running.current) return;
    running.current = true;
    setActive(mode);
    setFailure(undefined);
    setNote(undefined);
    try { await task(); }
    catch (error) { setFailure(explain(error, '작업을 마치지 못했습니다. 다시 시도해 주세요.')); }
    finally { running.current = false; setActive(undefined); }
  }

  function advance(question: string) {
    setSkipped(previous => [...previous, question]);
    setSelected(undefined);
    setTyped('');
  }

  function loadPrompt() {
    const generate = actions.generate;
    if (!generate) return;
    void run('generate', async () => {
      const next = await generate();
      if (next) { setSelected(next); setTyped(''); }
      else setNote('이 기록에서 더 확인할 질문을 찾지 못했습니다.');
    });
  }

  function answerPrompt() {
    if (!prompt || !typed.trim()) return;
    void run('answer', async () => {
      setSelected(prompt);
      await actions.save({origin:'ai', question:prompt, answer:typed});
      setTyped('');
      if (!actions.judge) {
        advance(prompt);
        setNote('답변을 이 기기에 저장했습니다.');
        return;
      }
      try {
        const verdict = await actions.judge(prompt, typed, remaining);
        if (verdict === 'clarify' || verdict === 'wait') {
          setNote(verdict === 'clarify' ? '답변을 저장했습니다. 가능하면 조금 더 구체적으로 적어 주세요.'
            : '답변을 저장했습니다. 더 설명하거나 다음 질문으로 넘어갈 수 있습니다.');
          return;
        }
        advance(prompt);
        setNote('답변을 이 기기에 저장했습니다.');
      } catch {
        advance(prompt);
        setNote('답변을 저장했지만 AI가 확인하지 못했습니다. 저장된 답변은 아래에 남습니다.');
      }
    });
  }

  function saveManual() {
    if (!question.trim() || !answer.trim()) return;
    void run('manual', async () => {
      await actions.save({origin:'manual', question, answer});
      setQuestion('');
      setAnswer('');
      setNote('질문과 답변을 이 기기에 저장했습니다.');
    });
  }

  return <View style={styles.card}>
    <Text accessibilityRole="header" style={styles.heading}>글로 보완하기</Text>
    <Text style={styles.small}>마이크를 사용하지 않습니다. 작성한 내용은 회의 원문과 구분하여 저장합니다.</Text>
    {prompt ? <>
      <Text style={styles.label}>AI 질문</Text>
      <Text selectable style={styles.body}>{prompt}</Text>
      <Field label="AI 질문에 답변" multiline style={entryStyle} value={typed} onChangeText={setTyped}
        maxLength={TYPED_ANSWER_LIMIT} editable={!disabled}/>
      {actions.judge && <Text style={styles.small}>답변을 먼저 저장한 뒤 질문과 답변을 서버로 보내 AI가 확인합니다.</Text>}
      <View style={styles.row}>
        <Button label={active === 'answer' ? '저장 중…' : '답변 저장'} variant="primary" onPress={answerPrompt} disabled={disabled || !typed.trim()}/>
        <Button label="질문 건너뛰기" disabled={disabled} onPress={() => { advance(prompt); setNote(undefined); setFailure(undefined); }}/>
      </View>
    </> : actions.generate ? <>
      <Text style={styles.small}>AI 질문을 받으면 이 회의의 요약과 일부 발언을 서버로 보냅니다.</Text>
      <View style={styles.row}><Button label={active === 'generate' ? '질문 만드는 중…' : 'AI에게 질문 받기'} onPress={loadPrompt} disabled={disabled}/></View>
    </> : <Text style={styles.small}>지금 보여 줄 AI 질문이 없습니다. 아래에서 직접 질문과 답을 적을 수 있습니다.</Text>}
    <View style={styles.row}><Button label={custom ? '직접 쓰기 접기' : '질문과 답변 직접 쓰기'} onPress={() => setCustom(!custom)} disabled={disabled}/></View>
    {custom && <>
      <Field label="직접 쓴 질문" value={question} onChangeText={setQuestion} maxLength={TYPED_QUESTION_LIMIT} editable={!disabled}/>
      <Field label="직접 쓴 답변" multiline style={entryStyle} value={answer} onChangeText={setAnswer}
        maxLength={TYPED_ANSWER_LIMIT} editable={!disabled}/>
      <Text style={styles.small}>직접 쓴 질문과 답변은 서버 연결 없이 기기에 저장할 수 있습니다.</Text>
      <View style={styles.row}><Button label={active === 'manual' ? '저장 중…' : '질문과 답변 저장'} variant="primary" onPress={saveManual}
        disabled={disabled || !question.trim() || !answer.trim()}/></View>
    </>}
    {note && <Notice text={note}/>}
    {failure && <Notice text={failure} danger/>}
  </View>;
}
