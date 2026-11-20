export type Connection = {url: string; token: string};
export type CitationPart = {text: string; reference?: string};
const citation = /\[record:[a-z0-9_-]+#[a-z0-9_.:-]+\]/gi;

export function validateConnection(address: string, token: string): Connection {
  const match = /^(https?):\/\/(\[::1\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?\/?$/i.exec(address.trim());
  const protocol = match?.[1].toLowerCase();
  const host = match?.[2].toLowerCase();
  const port = match?.[3];
  const local = host && ['localhost', '127.0.0.1', '10.0.2.2', '[::1]'].includes(host);
  if (!host || host.includes('..') || (port && (Number(port) === 0 || Number(port) > 65535)) ||
      !(protocol === 'https' || (local && protocol === 'http'))) {
    throw new Error('HTTPS 서버의 기본 주소를 입력해 주세요. 인증 정보는 주소에 넣지 않습니다.');
  }
  if (!/^\S{32,}$/.test(token.trim())) throw new Error('서버 접근 토큰을 32자 이상 입력해 주세요.');
  return {url: protocol + '://' + host + (port ? ':' + port : ''), token: token.trim()};
}

export function citationParts(text: string, references: {has: (reference: string) => boolean}): CitationPart[] {
  const parts: CitationPart[] = [];
  let offset = 0;
  for (const match of text.matchAll(citation)) {
    if (!references.has(match[0])) continue;
    if (match.index > offset) parts.push({text: text.slice(offset, match.index)});
    parts.push({text: match[0], reference: match[0]});
    offset = match.index + match[0].length;
  }
  if (offset < text.length) parts.push({text: text.slice(offset)});
  return parts;
}

export function draftContext(markdown: string, questions: string[], source: string): string {
  const allowed = new Set(source.split('\n').map(line => line.trim()));
  const used = new Set<string>();
  const clean = (text: string) => text.replace(citation, reference => {
    if (!allowed.has(reference)) return '';
    used.add(reference);
    return reference;
  });
  const draft = JSON.stringify({markdown: clean(markdown), questions: questions.map(clean)});
  return [...used, draft].join('\n');
}

export function splitContext(text: string, limit: number): string[] {
  if (limit < 2) throw new RangeError('Context limit must be at least two characters');
  const parts: string[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + limit);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline > offset + limit / 2) end = newline + 1;
      else if (/[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
    }
    parts.push(text.slice(offset, end));
    offset = end;
  }
  return parts;
}

export function compactParts(parts: string[], limit: number): string[] {
  const groups: string[] = [];
  for (const input of parts.flatMap(part => splitContext(part, limit))) {
    const previous = groups.at(-1);
    if (previous && previous.length + input.length < limit) {
      groups[groups.length - 1] = previous + '\n' + input;
    } else groups.push(input);
  }
  return groups;
}
