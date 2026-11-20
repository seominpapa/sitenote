import { assertDate, assertId, assertTurn, isCategoryPath, speakerLabel, timeLabel, type RecordData, type Turn } from './model.ts';

const recordTag = '<!-- sitenote-record ';
const turnTag = '<!-- sitenote-turn ';
const summaryTag = '<!-- sitenote-summary ';
const tagEnd = ' -->';
const sectionLabels = { personal: '개인 대화', meeting: '회의 원문', 'meeting-ai': '회의 중 AI 질의응답', followup: '회의 후 보완 대화' };

const metadata = (tag: string, value: unknown) => tag + JSON.stringify(value).replace(/[<>&]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`) + tagEnd;
const heading = (value: string) => value.replace(/\s+/g, ' ').replace(/[\\`*_{}\[\]()#+.!<>|~-]/g, '\\$&');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function readMetadata(line: string, tag: string): unknown {
  if (!line.startsWith(tag) || !line.endsWith(tagEnd)) throw Error('Markdown 메타데이터를 읽을 수 없습니다.');
  return JSON.parse(line.slice(tag.length, -tagEnd.length)) as unknown;
}

export function transcriptMarkdown(record: RecordData): string {
  assertId(record.id);
  assertDate(record.createdAt);
  assertDate(record.updatedAt);
  const { turns, summary: _summary, questions: _questions, ...header } = record;
  const lines = [metadata(recordTag, header), '', `# ${heading(record.title)}`, '',
    `- 기록 ID: ${record.id}`, `- 종류: ${record.kind === 'meeting' ? '회의' : '개인 대화'}`,
    `- 생성: ${record.createdAt}`, `- 수정: ${record.updatedAt}`];
  if (record.project) lines.push(`- 프로젝트: ${heading(record.project)}`);
  if (record.category) lines.push(`- 분류: ${heading(record.category.join(' / '))}`);
  let section: Turn['section'] | undefined;
  for (const turn of turns) {
    assertTurn(turn);
    if (turn.section !== section) {
      lines.push('', `## ${sectionLabels[turn.section]}`);
      section = turn.section;
    }
    const { text, ...turnHeader } = turn;
    lines.push('', metadata(turnTag, turnHeader), `<a id="${turn.id}"></a>`,
      `### ${timeLabel(turn.timeMs)} · ${heading(speakerLabel(record, turn))}${turn.interrupted ? ' · 중단됨' : ''}`,
      '', ...text.split('\n').map(line => `> ${line}`));
  }
  return `${lines.join('\n')}\n`;
}

function readRecordHeader(line: string): Omit<RecordData, 'turns'> {
  const value = readMetadata(line, recordTag);
  if (!object(value) || typeof value.id !== 'string' || (value.kind !== 'meeting' && value.kind !== 'personal') ||
    typeof value.title !== 'string' || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' ||
    (value.project !== undefined && typeof value.project !== 'string') || typeof value.allowInMeetings !== 'boolean' ||
    (value.category !== undefined && !isCategoryPath(value.category)) ||
    !object(value.speakers) || Object.values(value.speakers).some(name => typeof name !== 'string')) {
    throw Error('기록 메타데이터 형식이 올바르지 않습니다.');
  }
  assertId(value.id);
  assertDate(value.createdAt);
  assertDate(value.updatedAt);
  const { id, kind, title, createdAt, updatedAt, project, category, allowInMeetings, speakers } = value;
  return { id, kind, title, createdAt, updatedAt, ...(project === undefined ? {} : { project }),
    ...(category ? {category} : {}), allowInMeetings, speakers: speakers as RecordData['speakers'] };
}

export function parseTranscript(markdown: string): RecordData {
  const [first = '', ...lines] = markdown.replace(/\r\n?/g, '\n').split('\n');
  const header = readRecordHeader(first);
  const turns: Turn[] = [];
  const ids = new Set<string>();
  let current: { header: Omit<Turn, 'text'>; lines: string[] } | undefined;
  const append = () => {
    if (!current) return;
    const turn: Turn = { ...current.header, text: current.lines.join('\n') };
    assertTurn(turn);
    if (!current.lines.length || ids.has(turn.id)) throw Error('발언 원문 또는 ID가 손상되었습니다.');
    turns.push(turn);
    ids.add(turn.id);
  };
  for (const line of lines) {
    if (line.startsWith(turnTag)) {
      append();
      const value = readMetadata(line, turnTag);
      if (!object(value)) throw Error('발언 메타데이터 형식이 올바르지 않습니다.');
      current = { header: value as Omit<Turn, 'text'>, lines: [] };
    } else if (current && line.startsWith('> ')) current.lines.push(line.slice(2));
  }
  append();
  return { ...header, turns };
}

export function summaryMarkdown(markdown: string, questions: readonly string[] = []): string {
  return `${metadata(summaryTag, { questions })}\n\n${markdown.trim()}\n`;
}

export function parseSummary(markdown: string): { summary: string; questions: string[] } {
  const [first = '', ...lines] = markdown.replace(/\r\n?/g, '\n').split('\n');
  if (!first.startsWith(summaryTag)) return { summary: markdown.trim(), questions: [] };
  const info = readMetadata(first, summaryTag);
  if (!object(info) || !Array.isArray(info.questions) || info.questions.some(q => typeof q !== 'string')) {
    throw Error('요약 메타데이터 형식이 올바르지 않습니다.');
  }
  return { summary: lines.join('\n').trim(), questions: info.questions as string[] };
}
