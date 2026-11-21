export type Turn = {
  id: string;
  section: 'personal' | 'meeting' | 'meeting-ai' | 'followup';
  role: 'user' | 'ai' | 'speaker';
  text: string;
  timeMs: number;
  speakerId?: string;
  entry?: 'typed-question' | 'typed-answer';
  interrupted?: boolean;
  sourceRefs?: string[];
  quotedRefs?: string[];
};

export type RecordData = {
  id: string;
  kind: 'meeting' | 'personal';
  title: string;
  createdAt: string;
  updatedAt: string;
  project?: string;
  category?: string[];
  originalFilename?: string;
  allowInMeetings: boolean;
  speakers: Record<string, string>;
  turns: Turn[];
  summary?: string;
  questions?: string[];
};

export const safeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const sections = ['personal', 'meeting', 'meeting-ai', 'followup'] as const;
export const roles = ['user', 'ai', 'speaker'] as const;
export const isOriginalFilename = (value: unknown): value is string => typeof value === 'string' &&
  value.length <= 255 && /^[^/\\:\p{Cc}]+\.(?:md|markdown|txt|docx|hwp|hwpx)$/iu.test(value);
const categoryLabel = /^[^/\\\p{Cc}\u2028\u2029]+$/u;

export function parseOriginalSourceRef(value: unknown): {recordId: string; turnId: string} | undefined {
  if (typeof value !== 'string' || value.length > 266) return;
  const match = /^\[record:([^#]+)#([^\]]+)\]$/.exec(value);
  if (!match || match[0] !== value) return;
  const [,recordId,turnId] = match;
  if (safeId.test(recordId) && safeId.test(turnId) && turnId !== 'summary') return {recordId,turnId};
}

export function isOriginalSourceRef(value: unknown): value is string {
  return parseOriginalSourceRef(value) !== undefined;
}

export function isCategoryPath(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 3 &&
    value.every(label => typeof label === 'string' && label.length <= 45 && label === label.trim() && categoryLabel.test(label));
}

export function parseCategoryPath(value: string): string[] | undefined {
  if (!value.trim()) return;
  const path = value.normalize('NFC').split('/').map(label => label.trim().replace(/ +/g, ' '));
  if (!isCategoryPath(path)) throw Error('분류는 / 로 구분해 최대 3단계, 단계마다 45자 이하로 입력하세요.');
  return path;
}

export function assertId(id: string): void {
  if (typeof id !== 'string' || !safeId.test(id)) throw Error('기록 또는 발언 ID가 올바르지 않습니다.');
}

export function assertDate(value: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw Error('기록 시각이 올바르지 않습니다.');
  }
}

type NewRecord = Pick<RecordData, 'id' | 'kind' | 'project'> & { title?: string; now?: string };

export function createRecord({ id, kind, title, project, now = new Date().toISOString() }: NewRecord): RecordData {
  assertId(id);
  assertDate(now);
  return {
    id, kind, title: title?.trim() || (kind === 'meeting' ? '회의' : '개인 대화'),
    createdAt: now, updatedAt: now, ...(project?.trim() ? { project: project.trim() } : {}),
    allowInMeetings: kind === 'personal', speakers: {}, turns: [],
  };
}

export function assertTurn(turn: Turn): void {
  assertId(turn.id);
  if (turn.id === 'summary' || !sections.includes(turn.section) || !roles.includes(turn.role) ||
    typeof turn.text !== 'string' || !Number.isFinite(turn.timeMs) || turn.timeMs < 0 ||
    (turn.speakerId !== undefined && (typeof turn.speakerId !== 'string' || turn.speakerId.length > 128)) ||
    (turn.interrupted !== undefined && typeof turn.interrupted !== 'boolean')) {
    throw Error('발언 데이터가 올바르지 않습니다.');
  }
  assertEntry(turn, turn.entry);
  const refs = turn.sourceRefs;
  if (refs !== undefined && (turn.role !== 'ai' || !Array.isArray(refs) || refs.length > 2 ||
    !Array.from(refs).every(isOriginalSourceRef) || new Set(refs).size !== refs.length)) {
    throw Error('AI 발언 출처가 올바르지 않습니다.');
  }
  const quotes = turn.quotedRefs;
  if (quotes !== undefined && (turn.role !== 'ai' || !Array.isArray(quotes) || quotes.length > 2 ||
    !refs || !Array.from(quotes).every(ref => refs.includes(ref)) || new Set(quotes).size !== quotes.length)) {
    throw Error('AI 인용 출처가 올바르지 않습니다.');
  }
}

function assertEntry(turn: Turn, entry: Turn['entry']): void {
  if (entry !== undefined && (turn.section !== 'followup' ||
    !(entry === 'typed-question' ? (turn.role === 'ai' || turn.role === 'user') : entry === 'typed-answer' && turn.role === 'user'))) {
    throw Error('직접 입력한 발언을 구분할 수 없습니다.');
  }
}

export function applyTurn(record: RecordData, turn: Turn, now = new Date().toISOString()): RecordData {
  assertTurn(turn);
  const previous = record.turns.find(item => item.id === turn.id);
  const { id, section, role, speakerId } = turn;
  const entry = turn.entry ?? previous?.entry;
  assertEntry(turn, entry);
  const text = turn.text.replace(/\r\n?/g, '\n');
  const timeMs = previous?.timeMs ?? Math.round(turn.timeMs);
  const interrupted = previous?.interrupted || turn.interrupted;
  const refs = role === 'ai' ? turn.sourceRefs ?? previous?.sourceRefs : undefined;
  const sourceRefs = refs?.length ? refs : undefined;
  const verified = new Set([...(previous?.quotedRefs ?? []), ...(turn.quotedRefs ?? [])]);
  const quotes = sourceRefs?.filter(ref => verified.has(ref));
  const quotedRefs = quotes?.length ? quotes : undefined;
  if (previous && previous.text === text && previous.section === section && previous.role === role &&
    previous.speakerId === speakerId && previous.interrupted === interrupted && previous.entry === entry &&
    previous.sourceRefs?.join() === sourceRefs?.join() && previous.quotedRefs?.join() === quotedRefs?.join()) return record;
  const next: Turn = { id, section, role, text, timeMs,
    ...(speakerId !== undefined ? { speakerId } : {}), ...(interrupted !== undefined ? { interrupted } : {}), ...(entry ? {entry} : {}),
    ...(sourceRefs ? {sourceRefs:[...sourceRefs]} : {}), ...(quotedRefs ? {quotedRefs} : {}) };
  const turns = previous ? record.turns.map(item => item.id === id ? next : item) : [...record.turns, next];
  if (!previous && (record.turns.at(-1)?.timeMs ?? 0) > timeMs) turns.sort((a, b) => a.timeMs - b.timeMs);
  return { ...record, turns, updatedAt: now };
}

export function renameSpeaker(record: RecordData, speakerId: string, name: string, now = new Date().toISOString()): RecordData {
  if (!record.turns.some(turn => turn.speakerId === speakerId)) throw Error('기록에 없는 화자입니다.');
  const trimmed = name.trim();
  if (trimmed.length > 100) throw Error('이름은 100자 이하로 입력해 주세요.');
  const speakers = trimmed ? { ...record.speakers, [speakerId]: trimmed } :
    Object.fromEntries(Object.entries(record.speakers).filter(([id]) => id !== speakerId));
  return { ...record, speakers, updatedAt: now };
}

export function speakerLabel(record: RecordData, turn: Turn): string {
  if (turn.entry === 'typed-question') return turn.role === 'ai' ? 'AI 질문' : '직접 입력한 질문';
  if (turn.entry === 'typed-answer') return '직접 입력한 답변';
  if (turn.role === 'ai') return 'AI';
  if (record.originalFilename && turn.id.startsWith('import-') && turn.section === 'meeting') return '가져온 문서';
  if (turn.role === 'user') return turn.section === 'personal' ? '나' : '응답자 미확인';
  const id = turn.speakerId;
  if (!id) return '발언자 미확인';
  const name = Object.hasOwn(record.speakers, id) ? record.speakers[id] : '발언자 미확인';
  return `${name} (화자 ${speakerDisplayId(id)})`;
}

export const speakerDisplayId = (id: string) => /^(?:meeting|followup):[^:]+:/.test(id)
  ? id.slice(id.indexOf(':', id.indexOf(':') + 1) + 1) : id;

type SpeakerGroup = {id: string; area: 'meeting'|'followup'; label: string; firstTurn: Turn; count: number; name: string};

export function speakerGroups(record: RecordData): SpeakerGroup[] {
  const groups = new Map<string, SpeakerGroup>();
  for (const turn of record.turns) {
    const id = turn.speakerId;
    if (!id || turn.role !== 'speaker') continue;
    const group = groups.get(id);
    if (group) {
      groups.set(id, {...group, count:group.count + 1, firstTurn:turn.timeMs < group.firstTurn.timeMs ? turn : group.firstTurn});
    } else {
      groups.set(id, {id, area:turn.section === 'followup' ? 'followup' : 'meeting', label:`화자 ${speakerDisplayId(id)}`,
        firstTurn:turn, count:1, name:Object.hasOwn(record.speakers,id) ? record.speakers[id] : ''});
    }
  }
  const byTime = [...groups.values()].sort((a,b) => a.firstTurn.timeMs - b.firstTurn.timeMs);
  const descriptions = byTime.map(group => `${group.area}:${group.label}`);
  const count = new Map<string,number>();
  for (const label of descriptions) count.set(label,(count.get(label) ?? 0) + 1);
  const seen = new Map<string,number>();
  return byTime.map((group,index) => {
    const key = descriptions[index];
    if (count.get(key) === 1) return group;
    const position = (seen.get(key) ?? 0) + 1;
    seen.set(key,position);
    return {...group,label:`${group.label} · 구분 ${position}`};
  });
}

export function timeLabel(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
}
