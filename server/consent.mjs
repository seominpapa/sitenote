// Match the entire utterance after removing ordinary speech punctuation and spacing.
const yes = /^(?:네|예){1,3}$/u;
const no = /^(?:아니|아니오|아니요|아니에요|아뇨){1,3}$/u;
const affirmative = /^(?:(?:네|예){1,2})?(?:(?:보충질문|질문)?(?:(?:시작|진행)해(?:줘|줘요|주세요|주십시오)?|해(?:줘|줘요|주세요|주십시오))|보충질문할게요|동의(?:해요|합니다))$/u;
const negative = /^(?:(?:아니요|아뇨))?(?:(?:보충질문|질문)?(?:하지마(?:요|세요)?|그만(?:해(?:줘|주세요|요)?|할게요)?|취소(?:해(?:줘|주세요|요)?)?)|이대로(?:마치기|마쳐요|마칠게요|마칩니다|마쳐주세요)|괜찮(?:아요|습니다))$/u;
const ambiguousRefusal = /^(?:괜찮아요|괜찮습니다)$/u;

export function compactSpoken(value) {
  return value.normalize('NFKC').replace(/[\s,.!…。、]/gu, '');
}

export function consentAnswer(value) {
  if (typeof value !== 'string' || value.length > 100 || /[?？]/u.test(value)) return;
  const phrase = compactSpoken(value);
  if (yes.test(phrase) || affirmative.test(phrase)) return true;
  if (no.test(phrase) || (!ambiguousRefusal.test(phrase) && negative.test(phrase))) return false;
}
