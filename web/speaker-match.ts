import type {RecordData,Turn} from '../src/records/core.ts';
import {readMeetingAudio} from './meeting-archive.ts';
import {requestSpeakerMatch} from './api.ts';

const batchSize = 8;
const maximumComparisons = 120;
const confidenceFloor = 0.70;

function base64Audio(wav: ArrayBuffer) {
  const bytes = new Uint8Array(wav);
  const blocks: string[] = [];
  for (let at=0; at<bytes.length; at+=8192) blocks.push(String.fromCharCode(...bytes.subarray(at,at+8192)));
  return btoa(blocks.join(''));
}

export async function findSimilarMeetingTurns(record: RecordData, reference: Turn): Promise<string[]> {
  const spoken = record.turns.filter(turn => turn.section === 'meeting' && turn.role === 'speaker' && !turn.entry);
  const relevant = record.turns.filter(turn => turn.section !== 'followup');
  const nextStarts = new Map(relevant.slice(0,-1).map((turn,i) => [turn.id, relevant[i+1].timeMs]));
  const countByStart = new Map<number,number>();
  for (const turn of spoken) countByStart.set(turn.timeMs,(countByStart.get(turn.timeMs) ?? 0)+1);
  async function excerpt(turn: Turn): Promise<string|undefined> {
    if ((countByStart.get(turn.timeMs) ?? 0) > 1) return;
    const end = Math.min(turn.timeMs+6_000,nextStarts.get(turn.id) ?? Number.POSITIVE_INFINITY);
    if (end-turn.timeMs < 2_000) return;
    const audio = await readMeetingAudio(record.id,turn.timeMs,end,{minimumCapturedMs:2_000,requireContinuous:true});
    if (!audio || audio.size < 44 + 96_000) return;
    return base64Audio(await audio.arrayBuffer());
  }
  if (!spoken.some(turn => turn.id === reference.id)) throw Error('회의 중에 말한 발언을 기준으로 선택해 주세요.');
  const sample = await excerpt(reference);
  if (!sample) throw Error('기준 발언에 저장된 음성이 짧습니다. 2초 이상 또렷하게 말한 발언을 선택해 주세요.');

  const candidates = spoken.filter(turn => turn.id !== reference.id)
    .sort((a,b) => Number(b.speakerId === reference.speakerId) - Number(a.speakerId === reference.speakerId) ||
      Math.abs(a.timeMs-reference.timeMs) - Math.abs(b.timeMs-reference.timeMs))
    .slice(0,maximumComparisons);
  const suggestions: {id:string;score:number}[] = [];
  for (let cursor=0; cursor<candidates.length; cursor+=batchSize) {
    const group = (await Promise.all(candidates.slice(cursor,cursor+batchSize)
      .map(async turn => ({id:turn.id, pcm:await excerpt(turn)}))))
      .filter((clip): clip is {id:string;pcm:string} => !!clip.pcm);
    if (!group.length) continue;
    const scores = await requestSpeakerMatch(sample,group.map(clip => clip.pcm));
    scores.forEach((score,i) => {if (score !== null && score >= confidenceFloor) suggestions.push({id:group[i].id,score});});
  }
  return suggestions.sort((a,b) => b.score-a.score).map(item => item.id);
}
