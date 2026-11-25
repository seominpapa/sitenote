import { parseOriginalSourceRef, speakerDisplayId, speakerGroups, summarySpeakerNumber, type RecordData, type SummarySpeakerLabels, type Turn } from './model.ts';

const attribution = /(?:발언자[ \t]+미확인[ \t]*\([ \t]*화자[ \t]*(\d+)[ \t]*\)|화자[ \t]*(\d+))(으로|에게|에서|한테|께서|은|는|이|가|을|를|과|와|로|의|에|도)?(?![\p{L}\p{N}_])/gu;
const protectedText = /`[^`]*`|“[^”]*”|‘[^’]*’|"[^"]*"|'[^']*'|\[[^\]]*\](?:\([^)]*\))?/gu;
const reference = /\[record:[^\]]+\]/g;

export function buildSummarySpeakerLabels(record: RecordData): SummarySpeakerLabels {
  if (record.kind !== 'meeting') return {};
  const ids = new Set(record.turns.flatMap(turn => turn.role === 'speaker' && turn.speakerId ? [turn.speakerId] : []));
  const byNumber = new Map<string, string>();
  const withoutNumber: string[] = [];
  for (const id of ids) {
    const number = speakerDisplayId(id);
    if (summarySpeakerNumber.test(number) && !byNumber.has(number)) byNumber.set(number, id);
    else withoutNumber.push(id);
  }
  let next = 1;
  for (const id of withoutNumber) {
    while (byNumber.has(String(next))) next++;
    byNumber.set(String(next++), id);
  }
  return Object.fromEntries(byNumber);
}

function adjustedParticle(name: string, particle: string) {
  const code = name.charCodeAt(name.length - 1);
  if (code < 0xac00 || code > 0xd7a3 || !particle) return particle;
  const end = (code - 0xac00) % 28;
  if (particle === '으로' || particle === '로') return end && end !== 8 ? '으로' : '로';
  return ['은는', '이가', '을를', '과와'].find(pair => pair.includes(particle))?.[end ? 0 : 1] ?? particle;
}

function protectSegments(line: string, transform: (segment: string) => string) {
  let start = 0;
  let output = '';
  for (const match of line.matchAll(protectedText)) {
    output += transform(line.slice(start, match.index)) + match[0];
    start = match.index + match[0].length;
  }
  return output + transform(line.slice(start));
}

export function summaryWithSpeakerNames(record: RecordData): string | undefined {
  const {summary, speakers, summarySpeakerLabels} = record;
  if (!summary || record.kind !== 'meeting' || record.summaryNeedsSpeakerRefresh ||
      (!summarySpeakerLabels && !Object.keys(speakers).length)) return summary;
  const groupLabels = summarySpeakerLabels ? new Map(speakerGroups(record).map(group =>
    [group.id, group.label.replace(/ · 구분 (\d+)$/, ' (구분 $1)')])) : undefined;
  const turns = new Map(record.turns.map(turn => [turn.id, turn]));
  const meetingTurns = record.turns.filter(turn => turn.section !== 'followup');
  const followupTurns = record.turns.filter(turn => turn.section === 'followup');
  const speakerId = (turn?: Turn) => turn?.role === 'speaker' ? turn.speakerId : undefined;
  const matching = (matches: readonly Turn[], number: string) => [...new Set(matches.flatMap(turn => {
    const id = speakerId(turn);
    return id && speakerDisplayId(id) === number ? [id] : [];
  }))];
  let followup = false;
  let fence = '';
  return summary.split('\n').map(line => {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fenceMatch) {
      if (!fence) fence = fenceMatch;
      else if (fence[0] === fenceMatch[0] && fenceMatch.length >= fence.length) fence = '';
      return line;
    }
    if (fence || /^\s*>/.test(line)) return line;
    if (/^\s*#{1,3}\s/.test(line)) followup = /보충\s*(?:질문|대화|답변)|보완\s*대화|회의\s*후|추가\s*설명/u.test(line);
    const refs = [...line.matchAll(reference)].map(match => parseOriginalSourceRef(match[0]));
    const local = refs.flatMap(ref => {
      const turn = ref?.recordId === record.id ? turns.get(ref.turnId) : undefined;
      return turn ? [turn] : [];
    });
    const candidates = refs.length ? local : followup ? followupTurns : meetingTurns;
    if (refs.length !== local.length) return line;
    return protectSegments(line, segment => segment.replace(attribution, (original, full, simple, suffix = '', offset: number) => {
      if (offset && /[\p{L}\p{N}]/u.test(segment[offset - 1])) return original;
      const number = full ?? simple;
      const ids = summarySpeakerLabels ? [] : matching(candidates, number);
      const alias = summarySpeakerLabels?.[number];
      const id = alias && refs.length && local.some(turn => speakerId(turn) === alias) ? alias : ids.length === 1 ? ids[0] : undefined;
      const name = id && Object.hasOwn(speakers, id) ? speakers[id] : '';
      if (name) return name.replace(/\s+/g, ' ').replace(/[\`*_\[\]<>|]/g, char => '\\' + char) + adjustedParticle(name, suffix);
      const group = id && groupLabels?.get(id);
      return group && group !== `화자 ${number}` ? group + suffix : original;
    }));
  }).join('\n');
}
