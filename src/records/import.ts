import { createRecord, isOriginalFilename, type RecordData, type Turn } from './model.ts';

const maxChunk = 2400;

export function importedRecord({id, filename, markdown}: {id: string; filename: string; markdown: string}, project?: string): RecordData {
  if (!isOriginalFilename(filename) || !markdown.trim()) throw Error('문서에서 가져올 내용을 확인하지 못했습니다.');
  const title = Array.from(filename.slice(0, filename.lastIndexOf('.')).trim()).slice(0, 120).join('');
  const turns: Turn[] = [];
  let rest = markdown.replace(/\r\n?/g, '\n').trim();
  while (rest.length) {
    let cut = rest.length;
    if (cut > maxChunk) {
      const paragraph = rest.lastIndexOf('\n\n', maxChunk);
      const line = rest.lastIndexOf('\n', maxChunk);
      const space = rest.lastIndexOf(' ', maxChunk);
      cut = paragraph > maxChunk / 2 ? paragraph : line > maxChunk / 2 ? line : space > maxChunk / 2 ? space : maxChunk;
      if (/[\uD800-\uDBFF]/u.test(rest[cut - 1])) cut--;
    }
    turns.push({id:`import-${turns.length + 1}`, section:'meeting', role:'speaker', timeMs:turns.length, text:rest.slice(0,cut).trimEnd()});
    rest = rest.slice(cut).trimStart();
  }
  return {...createRecord({id, title, project, kind:'meeting'}), originalFilename:filename, turns};
}
