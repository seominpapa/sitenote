import { isTranscribedTurn, type RecordData } from './records/model.ts';

type Row = {id: string; text: string};
export type CorrectionRequest = {title: string; project?: string; turns: Row[]};
type Edit = Row & {original: string};

const metadata = (text = '') => text.trim().slice(0,120).replace(/[\uD800-\uDBFF]$/u,'').trimEnd();
const eligible = (text: string) => text.length <= 1800 && /[\p{L}\p{N}]/u.test(text);
export const canCorrectTranscript = (record: RecordData) => !record.originalFilename &&
  record.turns.some(turn => isTranscribedTurn(turn) && eligible(turn.text));

export async function requestTranscriptCorrections(record: RecordData, send: (data: CorrectionRequest) => Promise<{corrections: Row[]}>): Promise<Edit[]> {
  if (!canCorrectTranscript(record)) return [];
  const rows = record.turns.filter(turn => isTranscribedTurn(turn) && eligible(turn.text)).map(({id,text}) => ({id,text}));
  const title = metadata(record.title) || (record.kind === 'meeting' ? '회의' : '개인 대화');
  const project = metadata(record.project) || undefined;
  const edits: Edit[] = [];
  for (let offset = 0; offset < rows.length;) {
    let end = offset;
    let length = 0;
    while (end < rows.length && end-offset < 40 && (length += rows[end].text.length) <= 12_000) end++;
    const turns = rows.slice(offset,end);
    const original = new Map(turns.map(row => [row.id,row.text]));
    const {corrections} = await send({title,project,turns});
    if (!Array.isArray(corrections)) throw Error('AI 전사 보정 결과를 읽지 못했습니다.');
    const counts = new Map<string,number>();
    for (const row of corrections) if (typeof row?.id === 'string') counts.set(row.id,(counts.get(row.id) ?? 0)+1);
    for (const row of corrections) {
      if (!row || !original.has(row.id) || counts.get(row.id) !== 1 || typeof row.text !== 'string' || !eligible(row.text)) continue;
      const text = original.get(row.id)!;
      if (row.text.trim() !== text.trim()) edits.push({id:row.id,original:text,text:row.text.trim()});
    }
    offset = end;
  }
  return edits;
}

export function applyTranscriptCorrections(record: RecordData, edits: readonly Edit[]) {
  const byId = new Map(edits.map(edit => [edit.id,edit]));
  const turns = record.turns.map(turn => {
    const edit = byId.get(turn.id);
    return edit && isTranscribedTurn(turn) && edit.original === turn.text && edit.text !== turn.correctedText
      ? {...turn,correctedText:edit.text} : turn;
  });
  return turns.some((turn,i) => turn !== record.turns[i]) ? {...record,turns,updatedAt:new Date().toISOString()} : record;
}
