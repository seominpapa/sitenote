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

function readableSpeaker(record: RecordData, turn: Turn) {
  if (turn.role !== 'speaker' || !turn.speakerId) return speakerLabel(record, turn);
  if (Object.hasOwn(record.speakers, turn.speakerId)) return record.speakers[turn.speakerId];
  const number = speakerDisplayId(turn.speakerId);
  return /^\d+$/.test(number) ? `화자 ${number}` : '발언자 미확인';
}

function readableTranscript(record: RecordData) {
  const lines = [`# ${heading(record.title)}`];
  let section: Turn['section'] | undefined;
  for (const turn of record.turns) {
    if (section !== turn.section) {
      section = turn.section;
      lines.push('', `## ${sectionLabels[section]}`);
    }
    const name = readableSpeaker(record,turn);
    lines.push('', `### ${timeLabel(turn.timeMs)} · ${heading(name)}`, '',
      ...turn.text.replace(/\r\n?/g, '\n').split('\n').map(line => `> ${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}`));
  }
  return lines.join('\n');
}

function readableSummary(record: RecordData) {
  const summary = summaryWithSpeakerNames(record)
    ?.replace(/<!--\s*sitenote-(?:record|turn|summary)\b[\s\S]*?-->/g, '')
    .replace(/[ \t]*\[record:[^\]\r\n]+\](?:\([^\r\n)]*\))?/gi, '')
    .trim();
  return summary ? `# ${heading(record.title)}\n\n${summary}` : undefined;
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
      [name + '_원문.md', ordered.map(readableTranscript).join(separator) + '\n'],
      [name + '_요약.md', (summaries.join(separator) || '저장된 요약이 없습니다.') + '\n'],
    ]),
  };
}
