import { speakerLabel, timeLabel, transcriptText, type RecordData, type Turn } from './records/model.ts';
import { isOriginalTurn, matchMeetingHistory, openingTurns, type VoiceSearchPlan } from './records/search.ts';
import { splitContext } from './workflow.ts';

const formatTurn = (record: RecordData, turn: Turn, excerpt: string) => JSON.stringify({
  시각:timeLabel(turn.timeMs), 화자:speakerLabel(record,turn).slice(0,100),
  구분:turn.section === 'meeting-ai' ? 'AI 질의응답 중 참가자 발언' : '회의 발언', 본문:excerpt,
  ...(turn.correctedText && {전사보정:true}),
});

export type MeetingRecap = {chunks: string[]; incomplete?: true};
export type MeetingQuestionHistory = {context: string; scope?: 'current' | 'saved'; recap?: MeetingRecap};

export function buildMeetingRecap(record: RecordData, turns = record.turns): MeetingRecap {
  const lines: string[] = [];
  let length = 0;
  for (const turn of turns.filter(isOriginalTurn).sort((a,b) => a.timeMs - b.timeMs)) {
    const line = formatTurn(record,turn,transcriptText(turn)) + '\n';
    if ((length += line.length) > 480_000) return {chunks:[],incomplete:true};
    lines.push(line);
  }
  const chunks = splitContext(lines.join(''),20_000);
  return chunks.length > 24 ? {chunks:[],incomplete:true} : {chunks};
}

function priorQuestionEvidence(turns: Turn[], terms: string) {
  const all = turns.filter(turn => turn.section === 'meeting-ai');
  const matches = terms ? matchMeetingHistory(all,terms,'').map(({turn}) => turn) : [];
  const questions = matches.length ? matches.slice(0,4).sort((a,b) => a.timeMs - b.timeMs) : all.slice(-4);
  const last = questions.at(-1);
  const related = last ? matchMeetingHistory(turns.filter(turn => turn.section === 'meeting'), transcriptText(last), '').slice(0,3) : [];
  return [...questions.map(turn => ({turn,excerpt:transcriptText(turn).slice(0,480)})), ...related];
}

export function meetingQuestionHistory(record: RecordData, beforeMs: number, pending: readonly Turn[],
  plan?: VoiceSearchPlan): MeetingQuestionHistory {
  if (!plan || plan.scope === 'clarify') return {context:''};
  if (['latest','related','newest_note'].includes(plan.scope)) return {scope:'saved',context:''};
  if (record.kind !== 'meeting') return {context:''};
  const visible = new Map(record.turns.map(turn => [turn.id,turn]));
  for (const turn of pending) visible.set(turn.id,turn);
  const chronological = [...visible.values()].filter(turn => turn.timeMs < beforeMs && isOriginalTurn(turn) &&
    (turn.section === 'meeting' || turn.section === 'meeting-ai')).sort((a,b) => a.timeMs - b.timeMs);
  const explicitCurrent = plan.scope === 'current';
  const openingRequested = explicitCurrent && plan.range === 'opening';
  const earlierQuestionRequested = explicitCurrent && plan.range === 'prior-question';
  const scope = openingRequested ? openingTurns(chronological) : chronological;
  const overview = explicitCurrent && (plan.range === 'overview' || (openingRequested && !plan.terms));
  if (overview) {
    const heading = openingRequested ? '현재 회의 초반 5분에 기록된 발언 (시간순):' : '현재 회의에서 질문 직전까지 기록된 발언 (시간순):';
    if (!scope.length) return {scope:'current',context:heading + '\n아직 저장된 발언이 없습니다.'};
    const recap = buildMeetingRecap(record,scope);
    if (!recap.incomplete && recap.chunks.length === 1 && heading.length + recap.chunks[0].length < 5000) {
      return {scope:'current',context:heading + '\n' + recap.chunks[0]};
    }
    const count = Math.min(9,scope.length);
    const sample = Array.from({length:count},(_,i) => scope[Math.floor(i*(scope.length-1)/Math.max(1,count-1))]);
    return {scope:'current',recap,context:heading + '\n전체 전사가 아닌 시작·중간·마지막 발췌입니다.\n' +
      sample.map(turn => formatTurn(record,turn,transcriptText(turn).slice(0,135))).join('\n').slice(0,4400)};
  }
  const times = earlierQuestionRequested ? priorQuestionEvidence(scope,plan.terms)
    : matchMeetingHistory(scope,plan.terms,'').sort((a,b) => a.turn.timeMs - b.turn.timeMs);
  const label = openingRequested ? '현재 회의 초반 발언' : earlierQuestionRequested
    ? '현재 회의에서 AI에게 앞서 한 질문' : '현재 회의의 앞선 관련 발언';
  const answerScope = explicitCurrent ? 'current' : undefined;
  if (!times.length) return {scope:answerScope,context:explicitCurrent ? `${label}: 검색어와 맞는 저장된 발언을 찾지 못했습니다.` : '',
    ...(explicitCurrent && (plan.range === 'topic' || openingRequested) && scope.length
      ? {recap:buildMeetingRecap(record,scope)} : {})};
  let result = label + ' (과거 노트와 별개):';
  for (const {turn,excerpt} of times) {
    const line = formatTurn(record,turn,excerpt);
    if (result.length + line.length + 1 <= 5000) result += '\n' + line;
  }
  return {scope:answerScope,context:result};
}
