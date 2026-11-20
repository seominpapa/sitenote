import { safeId, speakerLabel, type RecordData, type Turn } from './model.ts';

export type SearchScope = { mode: 'personal' | 'meeting'; project?: string; currentRecordId?: string };
export type Evidence = {
  recordId: string;
  turnId?: string;
  title: string;
  createdAt: string;
  text: string;
  speaker?: string;
  timeMs?: number;
  role?: Turn['role'];
  section?: Turn['section'];
  reference: string;
};

const stopWords = new Set(['이', '그', '저', '왜', '뭐', '어떤', '회의', '기록', '관련', '지난', '과거', '전에', '그때', '당시', '지금', '프로젝트', '알려줘', '정리해줘', '설명해줘', '해줘', '말해줘', '정리', '대해', '때문', 'the', 'was', 'were', 'is', 'and', 'did', 'what', 'when', 'why', 'then', 'that', 'for', 'who', 'how', 'from', 'with', 'this', 'about', 'our', 'please']);
const anaphora = /(?:그때|당시|그거|그건|거기|그 회의|그 일정|그 프로젝트|이 프로젝트|지난번|\b(?:it|that|then|there|those)\b)/i;
const concepts = [
  ['납기', '일정', '기한', '마감', '마감일', '배송일', '완료일', '시한', 'deadline', 'delivery', 'schedule', 'due'],
  ['변경', '연기', '조정', '미뤄', '미루', '밀려', '늦춰', '당겨', '바꿔', 'reschedule', 'postpone', 'delay'],
  ['담당', '책임자', '담당자', '오너', '배정', '맡았', '맡을', 'owner', 'assignee', 'assign'],
  ['합의', '확정', '결정', '채택', '의결', 'decision', 'decided', 'agreed'],
  ['미해결', '미정', '불확실', '보류', '검토중', 'unresolved', 'pending', 'undecided'],
  ['아이디어', '제안', '구상', '발상', 'idea', 'proposal', 'suggestion'],
];

const words = (text: string) => text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const queryWords = (text: string) => [...new Set(words(text))].filter(word =>
  (word.length >= 2 || /^\d$/.test(word)) && !stopWords.has(word) && !/^누구|^어떻게|^무엇|^언제|^어디/.test(word)).slice(0, 14);
const cleanProject = (name: string | undefined) => name?.trim().normalize('NFKC').toLowerCase();

const inflection = /^(?:은|는|이|가|을|를|에|에서|으?로|에게|까지|부터|보다|와|과|도|만|이나|나|인데|인지|인지를|인가요|입니다|이라고|이며|이고|이었다|(?:하|한|할|함|해|했|되|된|될|됨|돼|됐|었|았)[가-힣]{0,7}|s|es|d|ed|ing)$/u;
const wordForm = (root: string, value: string, strict: boolean) => value.startsWith(root) &&
  (!strict || root === value || inflection.test(value.slice(root.length)));
const koreanTail = /^([가-힣]{2,}?)(?:에서는|에서|에는|으로는|으?로|에게|까지|부터|보다|이나|이라고|입니다|이었습니다|이었어요|인가요|인지는|인지|이고|이며|인데|은|는|이|가|을|를|에|와|과|도|만)$/u;
const koreanStem = (value: string) => koreanTail.exec(value)?.[1] ?? value;

function similarity(term: string, target: string, strict: boolean): number {
  if (target === term || (term.length >= 2 && (strict ? wordForm(term, target, true) : target.includes(term)))) return 4;
  if (target.length >= 2 && wordForm(target, term, strict)) return 3;
  if (strict && koreanStem(term) === koreanStem(target)) return 3.5;
  if (concepts.some(group => group.some(word => wordForm(word, term, strict)) && group.some(word => wordForm(word, target, strict)))) return 2.8;
  if (term.length < 3) return 0;
  let total = 0;
  for (let i = 0; i < term.length - 1; i++) if (target.includes(term.slice(i, i + 2))) total++;
  return total >= 2 ? total * 2.4 / (term.length - 1) : 0;
}

function match(text: string, terms: string[], strict = false): { score: number; matchWord: string; strong: number } {
  const targets = words(text);
  let matchWord = '';
  let best = 0;
  let score = 0;
  let strong = 0;
  for (const term of terms) {
    let nearest = 0;
    for (const target of targets) {
      const value = similarity(term, target, strict);
      if (value > nearest) nearest = value;
      if (value > best) { best = value; matchWord = target; }
      if (nearest === 4) break;
    }
    score += nearest;
    if (nearest >= 2.8) strong++;
  }
  return { score, matchWord, strong };
}

function clip(text: string, matchWord = '', max = 650): string {
  if (text.length <= max) return text;
  const pos = matchWord ? Math.max(0, text.normalize('NFKC').toLowerCase().indexOf(matchWord.slice(0, 30))) : 0;
  const start = Math.min(text.length - max, Math.max(0, pos - 200));
  return `${start > 0 ? '…' : ''}${text.slice(start, start + max)}${start + max < text.length ? '…' : ''}`;
}

const ref = (id: string, anchor: string) => `[record:${id}#${anchor}]`;

export function turnEvidence(record: RecordData, turn: Turn): Evidence {
  return { recordId: record.id, turnId: turn.id, title: record.title, createdAt: record.createdAt,
    speaker: speakerLabel(record, turn), timeMs: turn.timeMs, role: turn.role, section: turn.section,
    text: turn.text, reference: ref(record.id, turn.id) };
}

type SearchOptions = { previousQuery?: string; limit?: number; library?: boolean };

export function searchRecords(records: readonly RecordData[], query: string, scope: SearchScope = { mode: 'personal' },
  { previousQuery = '', limit = 6, library = false }: SearchOptions = {}): Evidence[] {
  const primaryTerms = queryWords(query);
  const terms = library && !primaryTerms.length ? words(query).slice(0, 14) : primaryTerms;
  const prior = anaphora.test(query) ? queryWords(previousQuery).filter(word => !terms.includes(word)) : [];
  if (limit <= 0 || (!terms.length && !prior.length)) return [];
  const ranked = records.filter(record => recordInScope(record, scope))
    .flatMap(record => recordMatches(record, terms, prior, library).slice(0, 3));
  return ranked.sort(compare).slice(0, Math.min(10, limit)).map(({ evidence }) => evidence);
}

export function recordInScope(record: RecordData, scope: SearchScope): boolean {
  if (scope.mode === 'meeting' && record.kind === 'personal' && !record.allowInMeetings) return false;
  const project = cleanProject(scope.project);
  return !project || record.id === scope.currentRecordId || cleanProject(record.project) === project;
}

type Ranked = { evidence: Evidence; score: number };
const compare = (a: Ranked, b: Ranked) => b.score - a.score || b.evidence.createdAt.localeCompare(a.evidence.createdAt);

export function isOriginalTurn(turn: Turn): boolean {
  return (turn.role === 'user' || turn.role === 'speaker') && safeId.test(turn.id) && turn.id !== 'summary' &&
    !turn.interrupted && Boolean(turn.text.trim());
}

const extraQuestionWords = /^(?:지난번|그거|그건|거기|그게|혹시|다시|정확히|짧게|때(?:는)?|무슨|뭐(?:가|를|라고|였지|였죠|였나요|였는지|였더라|였어|야|지)?|뭘|(?:얘기|내용)(?:였지|였나요|였어)|(?:회의|기록|원문|대화|메모)(?:에서(?:는)?|에는|을|를)|(?:알려|말해|정리해|설명해|찾아|얘기해|보여)(?:줘|줘요|주세요|줄래)?|(?:봐|줘|보기|주세요|건가요|이었나요|있나요|인가요|였지|했지|했나요|했는지|했어)|it|there|those|could|would|can|show|tell|find|record|meeting|previous|last|past|we|say|happened|discuss)$/;
const latestMeeting = /(?:가장\s*)?(?:최근(?:에\s*열린)?|지난(?:번)?|직전|마지막|바로\s*전)\s*회의(?:에서(?:는)?|에는|에|의|를|가|는|도)?(?=$|[^\p{L}\p{N}])|\b(?:(?:at|in|during|from)\s+)?(?:the\s+)?(?:(?:most\s+)?recent|latest|last|previous)\s+meeting\b/iu;
const topicWords = (text: string) => queryWords(text).filter(word => !extraQuestionWords.test(word));
const enoughTerms = (count: number) => Math.ceil(count * 0.6);

function newestMeetingOriginals(records: readonly RecordData[]): RecordData | undefined {
  let newest: RecordData | undefined;
  for (const record of records) {
    if (record.kind !== 'meeting' || (newest && newest.createdAt >= record.createdAt)) continue;
    const turns = record.turns.filter(turn => (turn.section === 'meeting' || turn.section === 'meeting-ai') && isOriginalTurn(turn));
    if (turns.length) newest = {...record, turns};
  }
  return newest;
}

export function searchHumanOriginals(records: readonly RecordData[], query: string, previousQuery = ''): Evidence[] {
  const normalized = query.normalize('NFKC');
  const meetingRequested = latestMeeting.test(normalized);
  const target = meetingRequested ? newestMeetingOriginals(records) : undefined;
  if (meetingRequested && !target) return [];
  const question = target ? normalized.replace(latestMeeting, ' ') : normalized;
  const terms = topicWords(question);
  const prior = anaphora.test(question) ? topicWords(previousQuery.normalize('NFKC').replace(latestMeeting, ' ')).filter(word => !terms.includes(word)) : [];
  if (!terms.length && !prior.length) {
    if (!target) return [];
    return [...target.turns].sort((a, b) => b.timeMs - a.timeMs).slice(0, 2)
      .map(turn => ({...turnEvidence(target,turn),text:clip(turn.text)}));
  }
  const ranked: Ranked[] = [];
  for (const record of target ? [target] : records) for (const turn of record.turns) {
    if (!isOriginalTurn(turn)) continue;
    const current = match(turn.text, terms, true);
    const previous = match(turn.text, prior, true);
    // shortcut: lexical overlap is enough for scoped excerpts; use semantic retrieval if low recall becomes a problem.
    if (current.strong < enoughTerms(terms.length) || previous.strong < enoughTerms(prior.length)) continue;
    ranked.push({ evidence: { ...turnEvidence(record, turn), text: clip(turn.text, current.matchWord || previous.matchWord) },
      score: current.score + previous.score * (terms.length ? 0.45 : 1) });
  }
  return ranked.sort(compare).slice(0, 2).map(item => item.evidence);
}

function recordMatches(record: RecordData, terms: string[], prior: string[], library: boolean): Ranked[] {
  const matches: Ranked[] = [];
  const labels = [record.title, record.project, library ? record.category?.join(' / ') : undefined]
    .filter(Boolean);
  const titleScore = match(labels.join(' '), terms).score;
  for (const turn of record.turns) {
    const evidence = turnEvidence(record, turn);
    const combined = `${turn.text} ${evidence.speaker ?? ''}`;
    const current = match(combined, terms);
    const previous = match(combined, prior);
    const score = current.score + previous.score * (terms.length ? 0.45 : 1);
    if (score < 2) continue;
    matches.push({ evidence: { ...evidence, text: clip(turn.text, current.matchWord || previous.matchWord) }, score: score + titleScore * 0.25 });
  }
  if (record.summary) {
    const current = match(record.summary, terms);
    const previous = match(record.summary, prior);
    const score = current.score + previous.score * (terms.length ? 0.45 : 1);
    if (score >= 2 || titleScore >= 3) matches.push({ evidence: {
      recordId: record.id, title: record.title, createdAt: record.createdAt,
      text: clip(record.summary, current.matchWord || previous.matchWord), reference: ref(record.id, 'summary'),
    }, score: score * 0.8 + titleScore * 0.5 });
  }
  if (!matches.length && titleScore >= 3 && record.turns[0]) {
    matches.push({ evidence: { ...turnEvidence(record, record.turns[0]), text: clip(record.turns[0].text) }, score: titleScore * 0.5 });
  }
  if (library && !matches.length && titleScore >= 3) {
    matches.push({ evidence: {recordId: record.id, title: record.title, createdAt: record.createdAt,
      text: labels.join(' · '), reference: ref(record.id, 'summary')}, score: titleScore * 0.5 });
  }
  return matches.sort(compare);
}

export function searchContext(evidence: readonly Evidence[]): string {
  return evidence.slice(0, 10).filter(item => safeId.test(item.recordId) && (!item.turnId || safeId.test(item.turnId)))
    .map(item => `${ref(item.recordId, item.turnId ?? 'summary')}\n${JSON.stringify({
      title: clip(item.title, '', 160), date: item.createdAt, section: item.section, role: item.role,
      speaker: item.speaker, timeMs: item.timeMs, excerpt: clip(item.text),
    }).replace(/\[record:/gi, '\\u005brecord:')}`).join('\n\n');
}
