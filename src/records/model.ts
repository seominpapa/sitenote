export type Turn = {
  id: string;
  section: 'personal' | 'meeting' | 'meeting-ai' | 'followup';
  role: 'user' | 'ai' | 'speaker';
  text: string;
  timeMs: number;
  speakerId?: string;
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
  allowInMeetings: boolean;
  speakers: Record<string, string>;
  turns: Turn[];
  summary?: string;
  questions?: string[];
};

export const safeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const sections = ['personal', 'meeting', 'meeting-ai', 'followup'] as const;
export const roles = ['user', 'ai', 'speaker'] as const;
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

export function applyTurn(record: RecordData, turn: Turn, now = new Date().toISOString()): RecordData {
  assertTurn(turn);
  const previous = record.turns.find(item => item.id === turn.id);
  const { id, section, role, speakerId } = turn;
  const text = turn.text.replace(/\r\n?/g, '\n');
  const timeMs = previous?.timeMs ?? Math.round(turn.timeMs);
  const interrupted = previous?.interrupted || turn.interrupted;
  const refs = role === 'ai' ? turn.sourceRefs ?? previous?.sourceRefs : undefined;
  const sourceRefs = refs?.length ? refs : undefined;
  const verified = new Set([...(previous?.quotedRefs ?? []), ...(turn.quotedRefs ?? [])]);
  const quotes = sourceRefs?.filter(ref => verified.has(ref));
  const quotedRefs = quotes?.length ? quotes : undefined;
  if (previous && previous.text === text && previous.section === section && previous.role === role &&
    previous.speakerId === speakerId && previous.interrupted === interrupted &&
    previous.sourceRefs?.join() === sourceRefs?.join() && previous.quotedRefs?.join() === quotedRefs?.join()) return record;
  const next: Turn = { id, section, role, text, timeMs,
    ...(speakerId !== undefined ? { speakerId } : {}), ...(interrupted !== undefined ? { interrupted } : {}),
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
  if (turn.role === 'ai') return 'AI';
  if (turn.role === 'user') return turn.section === 'personal' ? '나' : '응답자 미확인';
  const id = turn.speakerId;
  if (!id) return '발언자 미확인';
  const name = Object.hasOwn(record.speakers, id) ? record.speakers[id] : '발언자 미확인';
  return `${name} (화자 ${speakerDisplayId(id)})`;
}

export const speakerDisplayId = (id: string) => /^(?:meeting|followup):[^:]+:/.test(id)
  ? id.slice(id.indexOf(':', id.indexOf(':') + 1) + 1) : id;

export function timeLabel(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
}
