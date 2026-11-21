import { heading, sectionLabels } from './markdown.ts';
import { speakerDisplayId, speakerLabel, timeLabel, type RecordData, type Turn } from './model.ts';
import { summaryWithSpeakerNames } from './summary-speakers.ts';
import { zipTextFiles } from './zip.ts';

const separator = '\n\n---\n\n';

function localDate(value: string) {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function noteFolderName(record: RecordData): string {
  const prefix = localDate(record.createdAt).replaceAll('-', '') + '_';
  const safeTitle = record.title.normalize('NFC').replace(/[<>:"/\\|?*\p{Cc}\p{Cs}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  let length = prefix.length;
  let title = '';
  for (const char of safeTitle) {
    const point = char.codePointAt(0)!;
    length += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (length > 180) break;
    title += char;
  }
  return prefix + (title.replace(/[. ]+$/u, '') || '제목 없음');
}

function withoutStorageTags(text: string): string {
  return text.replace(/<!--\s*sitenote-(?:record|turn|summary)\b[\s\S]*?-->/g, '')
    .replace(/<a id="[A-Za-z0-9_-]+"><\/a>/g, '')
    .replace(/[ \t]*\[record:[^\]\r\n]+\](?:\([^\r\n)]*\))?/gi, '');
}

function readableSpeaker(record: RecordData, turn: Turn) {
  if (turn.role !== 'speaker' || !turn.speakerId) return speakerLabel(record, turn);
  const number = speakerDisplayId(turn.speakerId);
  const label = /^\d+$/.test(number) ? `화자 ${number}` : '';
  const name = Object.hasOwn(record.speakers, turn.speakerId) ? record.speakers[turn.speakerId] : '';
  return (name && label ? `${name} (${label})` : name || label) || '발언자 미확인';
}

export function readableTranscript(record: RecordData, importMarkdown?: string): string {
  if (record.originalFilename) return withoutStorageTags(importMarkdown ?? record.turns
    .filter(turn => turn.section === 'meeting' && turn.id.startsWith('import-')).map(turn => turn.text).join('\n\n')).trim();
  const lines = [`# ${heading(record.title)}`];
  let section: Turn['section'] | undefined;
  for (const turn of record.turns) {
    if (section !== turn.section) {
      section = turn.section;
      lines.push('', `## ${sectionLabels[section]}`);
    }
    const name = readableSpeaker(record,turn);
    lines.push('', `### ${timeLabel(turn.timeMs)} · ${heading(name)}`, '',
      ...withoutStorageTags(turn.text).trimEnd().replace(/\r\n?/g, '\n').split('\n')
        .map(line => `> ${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}`));
  }
  return lines.join('\n');
}

export function readableSummary(record: RecordData) {
  const summary = withoutStorageTags(summaryWithSpeakerNames(record) ?? '').trim();
  return summary ? `# ${heading(record.title)}\n\n${summary}` : undefined;
}

export function buildNoteExport(record: RecordData, importMarkdown?: string) {
  return {filename: `${noteFolderName(record)}.md`,
    markdown: [readableTranscript(record, importMarkdown), readableSummary(record)].filter(Boolean).join(separator) + '\n'};
}

export function buildNotesExport(records: readonly RecordData[]) {
  if (!records.length) throw Error('내보낼 노트가 없습니다.');
  const ordered = [...records].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const start = localDate(ordered[0].createdAt);
  const end = localDate(ordered[ordered.length - 1].createdAt);
  const name = `sitenote_(${start === end ? start : start + '~' + end})`;
  const summaries = ordered.flatMap(record => readableSummary(record) ?? []);
  return {
    filename: name + '.zip',
    bytes: zipTextFiles([
      [name + '_원문.md', ordered.map(record => readableTranscript(record)).join(separator) + '\n'],
      [name + '_요약.md', (summaries.join(separator) || '저장된 요약이 없습니다.') + '\n'],
    ]),
  };
}
