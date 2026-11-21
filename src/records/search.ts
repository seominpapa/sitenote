import { parseOriginalSourceRef, safeId, speakerLabel, summarySourceAnchor, transcriptText, type RecordData, type Turn } from './model.ts';

export type SearchScope = { mode: 'personal' | 'meeting'; project?: string; currentRecordId?: string };
export type VoiceSearchPlan = {
  scope: 'general' | 'current' | 'latest' | 'related' | 'newest_note' | 'clarify';
  range: 'overview' | 'opening' | 'topic' | 'prior-question';
  terms: string;
  sameProject: boolean;
};
export type Evidence = {
  recordId: string;
  turnId?: string;
  targetId?: string;
  title: string;
  createdAt: string;
  text: string;
  correctedText?: string;
  speaker?: string;
  originalFilename?: string;
  timeMs?: number;
  role?: Turn['role'];
  section?: Turn['section'];
  summaryOnly?: true;
  reference: string;
};

const stopWords = new Set(['이', '그', '저', '왜', '뭐', '어떤', '회의', '기록', '관련', '지난', '과거', '전에', '그때', '당시', '지금', '프로젝트', '알려줘', '정리해줘', '설명해줘', '해줘', '말해줘', '정리', '대해', '때문', 'the', 'was', 'were', 'is', 'and', 'did', 'what', 'when', 'why', 'then', 'that', 'for', 'who', 'how', 'from', 'with', 'this', 'about', 'our', 'please']);
const anaphora = /(?:그때|당시|그거|그건|거기|그 회의|그 일정|그 프로젝트|이 프로젝트|지난번|\b(?:it|that|then|there|those)\b)/i;
const concepts = [
  ['납기', '일정', '기한', '마감', '마감일', '배송일', '완료일', '시한', 'deadline', 'delivery', 'schedule', 'due'],
  ['변경', '연기', '조정', '미뤄', '미루', '밀려', '늦춰', '당겨', '바꿔', '바뀌', 'reschedule', 'postpone', 'delay'],
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
  const file = turn.section === 'meeting' && turn.id.startsWith('import-') ? record.originalFilename : undefined;
  return { recordId: record.id, turnId: turn.id, title: record.title, createdAt: record.createdAt,
    speaker: speakerLabel(record, turn), ...(file ? {originalFilename:file} : {timeMs:turn.timeMs}), role: turn.role, section: turn.section,
    text: turn.text, ...(turn.correctedText && {correctedText:turn.correctedText}), reference: ref(record.id, turn.id) };
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
  return (turn.role === 'user' || turn.role === 'speaker') && safeId.test(turn.id) && turn.id !== 'summary' && !summarySourceAnchor.test(turn.id) &&
    turn.entry !== 'typed-question' && !turn.interrupted && Boolean(turn.text.trim());
}

const extraQuestionWords = /^(?:지난번|그거|그건|거기|그게|혹시|다시|정확히|짧게|때(?:는)?|무슨|뭐(?:가|를|라고|였지|였죠|였나요|였는지|였더라|였어|야|지)?|뭘|(?:얘기|이야기|내용)(?:였지|였나요|였어|했어|했지|했나요|했죠|했는지)|(?:회의|기록|원문|대화|메모)(?:에서(?:는)?|에는|을|를)|(?:알려|말해|정리해|설명해|찾아|얘기해|보여)(?:줘|줘요|주세요|줄래)?|(?:봐|줘|보기|주세요|건가요|이었나요|있나요|인가요|였지|했지|했나요|했는지|했어)|it|there|those|could|would|can|show|tell|find|record|meeting|previous|last|past|we|say|happened|discuss)$/;
const recentQualifier = /(?:가장\s*)?(?:최근(?:에)?|최신|지난(?:\s*번)?|저\s*번|이전(?:에)?|전에|직전|마지막|바로\s*전)\s*(?:(?:열렸던|열린|진행했던|진행한|했던|한|녹음(?:했던|한|된)|저장(?:했던|한|된)|기록(?:했던|한|된))\s*)?/u;
const recentNoun = /(회의|노트|기록|메모)(?:에서(?:는)?|에는|에|의|를|가|는|도)?(?:\s*(?:내용|요약|원문)(?:은|는|을|를|이|가)?)?(?=$|[^\p{L}\p{N}])/u;
const recentEnglish = /\b(?:(?:at|in|during|from)\s+)?(?:the\s+)?(?:(?:most\s+)?recent|latest|last|previous)\s+(meeting|note|record)\b/iu;
const recentRecord = new RegExp(`${recentQualifier.source}${recentNoun.source}|${recentEnglish.source}`,'giu');
const recentNoteLocator = /(?:최근|최신)\s*노트(?:들)?(?:에서|에|\s*중)\s*(?:있는|저장된|기록된|중)?\s*/iu;
const savedMeetingNoun = /^(?:녹음(?:한|된)|저장(?:한|된)|기록(?:한|된))?\s*(?:회의|meeting)(?:에서(?:는)?|에는|에|의|를|가|는|도)?(?:\s*(?:내용|요약|원문)(?:은|는|을|를|이|가)?)?(?=$|[^\p{L}\p{N}])/iu;
const sameProjectCue = /(?:같은|동일한)\s*프로젝트|(?:이|이번|현재)\s*프로젝트/iu;
const relatedQualifier = /(?:(?:지금|현재|이번|이)\s*(?:회의(?:\s*(?:주제|안건))?|주제|안건|프로젝트)\s*(?:이랑|랑|와|과|에|에서|의|을|를)\s*)?(?:비슷(?:한|했던|했었던)|유사(?:한|했던)|연관(?:된|\s*있는)|관련(?:된|\s*있는)|다룬|(?:같은|동일한)\s*(?:주제|안건|내용|프로젝트)(?:(?:에서|의)|로\s*(?:한|했던))?|\b(?:similar|related)\b)\s*/u;
const relatedCue = new RegExp(`${relatedQualifier.source}(?=(?:${recentQualifier.source})?회의|(?:recent\\s+|last\\s+|previous\\s+)?meeting\\b)`,'iu');
export const meetingOpening = /(?:회의\s*)?(?:초반(?:에는|에|부에)?|(?:도입부|앞부분)(?:에서|에)?|시작\s*(?:부분|무렵|할\s*때|하고\s*나서|에)|처음(?:부터는|부터|에는|에|(?=\s+(?:뭐|무슨|어떤|얘기|이야기|논의|안건))))(?=$|[^\p{L}\p{N}])|\b(?:at the (?:start|beginning)|early in (?:this|the) meeting|opening remarks)\b/iu;
const genericRecencyWords = /^(?:요약(?:해(?:줘|주세요)?)?|내용|원문|(?:얘기|이야기|논의)(?:했어|했지|했나요|했죠|했는지|했던)?|어땠어|어땠지|했어|했지|있던|있(?:는지|나요)|있었(?:어|지|나요|던|는지)|summary|content)$/u;
const topicWords = (text: string) => queryWords(text).filter(word => !extraQuestionWords.test(word));
const enoughTerms = (count: number) => Math.ceil(count * 0.6);

export function asksForPastNote(query: string): boolean {
  return pastMeetingIntent(query) !== undefined || recentMatch(query.normalize('NFKC')) !== undefined;
}

const isMeeting = (match: RegExpMatchArray) => match[1] === '회의' || match[2]?.toLowerCase() === 'meeting';
function recentMatch(query: string) {
  const candidates = [...query.matchAll(recentRecord)];
  return candidates.find(isMeeting) ?? candidates[0];
}

export function pastMeetingIntent(query: string): 'latest' | 'related' | undefined {
  const text = query.normalize('NFKC').replace(recentNoteLocator,'').trim();
  if (relatedCue.test(text)) return 'related';
  const recent = recentMatch(text);
  return (recent && isMeeting(recent)) || (recentNoteLocator.test(query) && savedMeetingNoun.test(text)) ? 'latest' : undefined;
}

export function openingTurns(turns: readonly Turn[]) {
  const speech = turns.filter(turn => turn.section === 'meeting').sort((a,b) => a.timeMs - b.timeMs);
  const start = speech[0]?.timeMs ?? 0;
  return speech.filter(turn => turn.timeMs < start + 5*60_000);
}

export function matchMeetingHistory(turns: readonly Turn[], query: string, previousQuery: string) {
  const terms = topicWords(query.normalize('NFKC'));
  const prior = anaphora.test(query) ? topicWords(previousQuery.normalize('NFKC').replace(recentRecord, ' ')) : [];
  if (!terms.length && !prior.length) return [];
  return turns.flatMap(turn => {
    const hit = queryMatch(transcriptText(turn), terms, prior) ?? queryMatch(turn.text, terms, prior);
    return hit ? [{turn, excerpt:clip(transcriptText(turn),hit.word,480),score:hit.score}] : [];
  }).sort((a,b) => b.score - a.score || b.turn.timeMs - a.turn.timeMs).slice(0, 6);
}

function recordedMeeting(record: RecordData) {
  return record.kind === 'meeting' && !record.originalFilename;
}

function noteOriginals(record: RecordData, meeting: boolean) {
  return record.turns.filter(turn => (!meeting || turn.section === 'meeting' || turn.section === 'meeting-ai') && isOriginalTurn(turn));
}

function newestOriginals(records: readonly RecordData[], meeting: boolean): RecordData | undefined {
  let newest: RecordData | undefined;
  for (const record of records) {
    if ((meeting && !recordedMeeting(record)) || (newest && (newest.createdAt > record.createdAt ||
      (newest.createdAt === record.createdAt && newest.id.localeCompare(record.id) <= 0)))) continue;
    const turns = noteOriginals(record,meeting);
    if (turns.length) newest = {...record, turns};
  }
  return newest;
}

const genericContext = /^(?:현장|점검|주간|정기|일반|중요|회의록|회의내용|이번|현재|최근|제목|요약|내용|안건|논의|업무|모두|오늘|이번에|일단|여기서|합니다|됩니다|있습니다|없습니다|하겠습니다|수고|감사|확인(?:했|하|할|해)?[가-힣]{0,6}|시작(?:했|하|할|해)?[가-힣]{0,6}|[\d]+(?:일|월|년|차)?)$/u;
function contextTerms(text: string) {
  return [...new Set(topicWords(text).map(koreanStem))].filter(word => !genericContext.test(word));
}

type MeetingContext = {title:string; project?:string; turns:readonly Turn[]};
const compactTitle = (text: string) => words(text).join('').replace(/(?:회의록|회의|meeting)$/iu,'');
const savedTopicWords = (text: string) => topicWords(text).filter(word => !genericRecencyWords.test(koreanStem(word)));

function relatedOriginals(records: readonly RecordData[], explicit: readonly string[], byProject: boolean, context?: MeetingContext) {
  const weighted = new Map(contextTerms(context?.title ?? '').map(word => [word,3]));
  for (const turn of context?.turns ?? []) {
    for (const word of contextTerms(transcriptText(turn))) if ((weighted.get(word) ?? 0) < 2) weighted.set(word,(weighted.get(word) ?? 0) + 1);
  }
  const terms = [...weighted].sort((a,b) => b[1] - a[1]).slice(0,20);
  const currentTitle = compactTitle(context?.title ?? '');
  if (context?.project && byProject && !explicit.length) return newestOriginals(records,true);
  if (!terms.length && !explicit.length) return;
  const candidates = records.filter(recordedMeeting).flatMap(record => {
    const turns = noteOriginals(record,true);
    if (!turns.length) return [];
    const title = new Set(contextTerms(record.title));
    const sameTitle = currentTitle.length >= 4 && currentTitle === compactTitle(record.title);
    const vocabulary = new Set([...title, ...words(record.summary ?? '').map(koreanStem)]);
    for (const turn of turns) for (const word of words(transcriptText(turn))) vocabulary.add(koreanStem(word));
    const hits = terms.filter(([word]) => vocabulary.has(word));
    const requested = explicit.filter(word => vocabulary.has(word));
    if (explicit.length && requested.length < enoughTerms(explicit.length)) return [];
    if (!explicit.length && !sameTitle && hits.length < 2 && !hits.some(([word, weight]) => word.length >= 3 && weight === 3 && title.has(word))) return [];
    const score = hits.reduce((total,[word,weight]) => total + weight * (title.has(word) ? 2 : 1),0) + requested.length * 4 + Number(sameTitle) * 8;
    return [{record:{...record,turns},score}];
  });
  const best = candidates.reduce((score, item) => Math.max(score,item.score),0);
  return candidates.filter(item => item.score >= best * 0.75).sort((a,b) =>
    b.record.createdAt.localeCompare(a.record.createdAt) || b.score - a.score || a.record.id.localeCompare(b.record.id))[0]?.record;
}

export function searchHumanOriginals(records: readonly RecordData[], query: string, previousQuery = ''): Evidence[] {
  return lookupHumanOriginals(records,query,previousQuery).evidence;
}

export function lookupHumanOriginals(records: readonly RecordData[], query: string, previousQuery = '',
  active?: MeetingContext, plan?: VoiceSearchPlan): {evidence:Evidence[];meeting?:RecordData} {
  const request = plan ? {...plan, terms:plan.terms.normalize('NFKC').trim()} : inferVoiceSearch(query);
  const {scope,range} = request;
  if (scope === 'current' || scope === 'clarify' || (request.sameProject && !active?.project)) return {evidence:[]};
  const isSavedMeeting = scope === 'latest' || scope === 'related';
  const words = plan || scope === 'general' ? topicWords(request.terms) : savedTopicWords(request.terms);
  const relatedTerms = [...new Set(words.map(koreanStem))].filter(word => plan || !genericContext.test(word));
  const candidates = request.sameProject
    ? records.filter(record => cleanProject(record.project) === cleanProject(active?.project)) : records;
  const target = scope === 'related' ? relatedOriginals(candidates,relatedTerms,request.sameProject,active)
    : scope === 'latest' || scope === 'newest_note' ? newestOriginals(candidates,isSavedMeeting) : undefined;
  if (scope !== 'general' && !target) return {evidence:[]};
  const prior = !plan && anaphora.test(request.terms)
    ? topicWords(previousQuery.normalize('NFKC').replace(recentRecord, ' ')).filter(word => !words.includes(word)) : [];
  const terms = plan && range === 'overview' ? [] : words;
  if (plan && range === 'topic' && !terms.length) return {evidence:[]};
  if (plan && range === 'prior-question') {
    if (!target) return {evidence:[]};
    const evidence = target.turns.filter(turn => turn.section === 'meeting-ai')
      .flatMap(turn => {
        const hit = queryMatch(transcriptText(turn),terms,[]) ?? queryMatch(turn.text,terms,[]);
        return hit ? [{...turnEvidence(target,turn),text:clip(turn.text,hit.word)}] : [];
      }).sort((a,b) => (b.timeMs ?? 0) - (a.timeMs ?? 0)).slice(0,2);
    return {evidence};
  }
  if (range === 'opening') {
    if (!target || !recordedMeeting(target)) return {evidence:[]};
    const turns = openingTurns(target.turns);
    if (!terms.length && !prior.length) return {evidence:turns.slice(0,2).map(turn => ({...turnEvidence(target,turn),text:clip(turn.text)}))};
    return {evidence:turns.flatMap(turn => {
      const hit = queryMatch(transcriptText(turn),terms,prior) ?? queryMatch(turn.text,terms,prior);
      return hit ? [{evidence:{...turnEvidence(target,turn),text:clip(turn.text,hit.word)},score:hit.score}] : [];
    }).sort(compare).slice(0,2).map(item => item.evidence)};
  }
  if (!terms.length && !prior.length) {
    return target ? overviewEvidence(target,isSavedMeeting || Boolean(plan && recordedMeeting(target))) : {evidence:[]};
  }
  return {evidence:topicalEvidence(candidates,terms,prior,target)};
}

function inferVoiceSearch(query: string): VoiceSearchPlan {
  const normalized = query.normalize('NFKC');
  const recent = recentMatch(normalized);
  const meetingIntent = pastMeetingIntent(normalized);
  let question = meetingIntent ? normalized.replace(recentNoteLocator,'').trim() : normalized;
  if (meetingIntent === 'related') question = question.replace(relatedCue,'').trim();
  const selected = recentMatch(question);
  if (selected) question = question.replace(selected[0],' ').trim();
  else if (meetingIntent) question = question.replace(savedMeetingNoun,' ');
  const opening = meetingIntent && meetingOpening.test(question);
  if (opening) question = question.replace(meetingOpening,' ');
  return {scope:meetingIntent ?? (recent ? 'newest_note' : 'general'),range:opening ? 'opening' : 'topic',
    terms:question,sameProject:meetingIntent === 'related' && sameProjectCue.test(normalized)};
}

function overviewEvidence(target: RecordData, isMeeting: boolean) {
  const keyPassages = new Map<string, Evidence>();
  for (const passage of summaryPassages(target).slice(0, 6)) {
    if (!topicWords(passage.text).length) continue;
    const original = supportingTurn(passage, target.turns, [], []);
    if (original) keyPassages.set(original.turn.id,
      {...turnEvidence(target,original.turn),text:clip(original.turn.text,original.word)});
    if (!original?.supportsFacts && !keyPassages.has('summary')) {
      keyPassages.set('summary', {...summaryEvidence(target,passage), text:clip(passage.text)});
    }
    if (keyPassages.size >= 2) break;
  }
  const original = target.turns.filter(turn => !keyPassages.has(turn.id)).sort((a, b) => a.timeMs - b.timeMs);
  const passages = isMeeting ? [...new Set([original[0],original[Math.floor(original.length / 2)]])].filter(Boolean) : original.reverse();
  const evidence = [...keyPassages.values(), ...passages.slice(0,2).map(turn => ({...turnEvidence(target,turn),text:clip(turn.text)}))].slice(0,2);
  return {evidence,...(isMeeting ? {meeting:target} : {})};
}

function topicalEvidence(records: readonly RecordData[], terms: string[], prior: string[], target?: RecordData) {
  const ranked: Ranked[] = [];
  for (const record of target ? [records.find(item => item.id === target.id) ?? target] : records) {
    const originals = record.turns.filter(isOriginalTurn);
    if (!originals.length) continue;
    const passages = new Map<string, Ranked>();
    function add(turn: Turn, word: string, score: number) {
      if (score > (passages.get(turn.id)?.score ?? 0)) {
        passages.set(turn.id, {evidence:{...turnEvidence(record, turn), text:clip(turn.text, word)}, score});
      }
    }
    for (const turn of target?.turns ?? originals) {
      const hit = queryMatch(transcriptText(turn),terms,prior) ?? queryMatch(turn.text,terms,prior);
      if (hit) add(turn, hit.word, hit.score);
    }
    const summaries = summaryPassages(record).flatMap(passage => {
      const hit = queryMatch(passage.text, terms, prior);
      return hit ? [{passage,...hit}] : [];
    }).sort((a,b) => b.score - a.score).slice(0, 4);
    let fallback: Ranked | undefined;
    for (const {passage, word, score} of summaries) {
      const original = supportingTurn(passage, target && !passage.anchors.length ? target.turns : originals, terms, prior);
      if (original && original.supportsFacts) {
        add(original.turn, original.word, score * 0.9);
      } else {
        if (original) add(original.turn, original.word, score * 0.8);
        fallback ??= {evidence:{...summaryEvidence(record, passage), text:clip(passage.text, word)},score:score * 0.95};
      }
    }
    ranked.push(...passages.values(), ...(fallback ? [fallback] : []));
  }
  const best = ranked.sort(compare).slice(0, 2);
  const originalHit = ranked.find(item => !item.evidence.summaryOnly);
  if (originalHit && best.length === 2 && best.every(item => item.evidence.summaryOnly)) best[1] = originalHit;
  return best.sort((a,b) => Number(Boolean(a.evidence.summaryOnly)) - Number(Boolean(b.evidence.summaryOnly))).map(item => item.evidence);
}

function queryMatch(text: string, terms: string[], prior: string[]) {
  const current = match(text, terms, true);
  const previous = match(text, prior, true);
  if (current.strong < enoughTerms(terms.length) || previous.strong < enoughTerms(prior.length)) return;
  return {score:current.score + previous.score * (terms.length ? 0.45 : 1), word:current.matchWord || previous.matchWord};
}

const citationMarker = /\[record:[^\]\r\n]+\](?:\([^\r\n)]*\))?/giu;
const summaryReference = /\[record:[^\]\r\n]+\]/giu;
type SummaryPassage = {text: string; anchors: string[]; id: string};

function summaryPassages(record: RecordData): SummaryPassage[] {
  if (!record.summary) return [];
  return record.summary.split(/\r?\n/u).flatMap(line => {
    if (/^\s*#{1,6}\s/u.test(line)) return [];
    const text = line.replace(citationMarker, '').replace(/^\s*(?:[-*+]\s+|\d+\.\s+)/u, '').trim();
    if (!text) return [];
    const anchors = [...new Set([...line.matchAll(summaryReference)].flatMap(match => {
      const ref = parseOriginalSourceRef(match[0]);
      return ref?.recordId === record.id ? [ref.turnId] : [];
    }))];
    let fingerprint = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) fingerprint = Math.imul(fingerprint ^ text.charCodeAt(i), 0x01000193);
    const id = 'summary-only-' + (fingerprint >>> 0).toString(16).padStart(8,'0');
    return [{text, anchors, id}];
  });
}

function summaryEvidence(record: RecordData, passage: SummaryPassage): Evidence {
  return {recordId:record.id, title:record.title, createdAt:record.createdAt, text:passage.text,
    reference:ref(record.id, passage.id), targetId:passage.id, summaryOnly:true};
}

export function summarySourceEvidence(record: RecordData, targetId: string): Evidence | undefined {
  if (!summarySourceAnchor.test(targetId)) return;
  const passages = summaryPassages(record).filter(item => item.id === targetId);
  if (passages.length && passages.every(item => item.text === passages[0].text)) return summaryEvidence(record, passages[0]);
}

const factTokens = (text: string) => [...new Set(text.normalize('NFKC').match(/\d+(?:[.,:/-]\d+)*(?:년|월|일|시|분|명|개|회|톤|원|%|mm|cm|m|kg)?|[월화수목금토일]요일|오전|오후/giu) ?? [])];
const contradiction = /(?:^|\s)(?:안\s|못\s|\S*(?:아니|없|않|못|불가|취소|미정|보류))/u;

function topicalTypo(keyword: string, original: readonly string[], topics: readonly string[]) {
  const stem = koreanStem(keyword);
  if (stem.length < 3 || !topics.some(topic => koreanStem(topic) === stem)) return false;
  return original.some(value => {
    const target = koreanStem(value);
    return stem.length === target.length && [...stem].filter((letter,index) => letter !== target[index]).length === 1;
  });
}

function supportingTurn(passage: SummaryPassage, turns: readonly Turn[], terms: string[], prior: string[]) {
  const keywords = topicWords(passage.text);
  const summaryFacts = factTokens(passage.text);
  const near = turns.flatMap(turn => {
    const overlap = match(turn.text, keywords, true);
    const grounded = passage.anchors.includes(turn.id);
    if (overlap.strong < Math.max(grounded ? 1 : 2, enoughTerms(keywords.length) - Number(grounded))) return [];
    const originalFacts = factTokens(turn.text);
    const originalWords = words(turn.text);
    const supportsFacts = summaryFacts.every(token => originalFacts.includes(token)) &&
      contradiction.test(passage.text) === contradiction.test(turn.text) &&
      keywords.every(keyword => originalWords.some(word => similarity(keyword,word,true) >= 2.8) ||
        topicalTypo(keyword,originalWords,terms));
    const score = overlap.score + (queryMatch(turn.text, terms, prior)?.score ?? 0) * 0.35;
    return [{turn,word:overlap.matchWord,supportsFacts,score:score + (grounded ? 2 : 0)}];
  });
  return near.sort((a,b) => Number(b.supportsFacts) - Number(a.supportsFacts) || b.score - a.score)[0];
}

function recordMatches(record: RecordData, terms: string[], prior: string[], library: boolean): Ranked[] {
  const matches: Ranked[] = [];
  const labels = [record.title, record.project, library ? record.category?.join(' / ') : undefined]
    .filter(Boolean);
  const titleScore = match(labels.join(' '), terms).score;
  for (const turn of record.turns) {
    const evidence = turnEvidence(record, turn);
    const combined = `${transcriptText(turn)} ${evidence.speaker ?? ''}`;
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

export function localCalendarDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return [date.getFullYear(),date.getMonth()+1,date.getDate()].map(part => String(part).padStart(2,'0')).join('-');
}

export function searchContext(evidence: readonly Evidence[]): string {
  return evidence.slice(0, 10).filter(item => safeId.test(item.recordId) && (!item.turnId || safeId.test(item.turnId))
      && (!item.summaryOnly || summarySourceAnchor.test(item.targetId ?? '')))
    .map(item => `${ref(item.recordId, item.targetId ?? item.turnId ?? 'summary')}\n${JSON.stringify({
      title: clip(item.title, '', 160), date: item.createdAt, displayDate:localCalendarDate(item.createdAt), section: item.section, role: item.role,
      speaker: item.speaker, timeMs: item.timeMs, excerpt: clip(item.text),
      correctedText:item.correctedText ? clip(item.correctedText) : undefined, summaryOnly:item.summaryOnly,
    }).replace(/\[record:/gi, '\\u005brecord:')}`).join('\n\n');
}
