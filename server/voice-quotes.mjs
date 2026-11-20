const normalizeWhitespace = value => value.replace(/\s+/gu, ' ').trim();
const quotation = /“([^“”]+)”|「([^「」]+)」|"([^"]+)"/gu;
const minQuoteCharacters = 8;

// Only an unambiguous, explicitly quoted span in a provided excerpt qualifies.
export function quotedReferences(transcript, excerpts) {
  const available = excerpts.map(({ reference, excerpt }) => ({ reference, text: normalizeWhitespace(excerpt) }));
  const verified = new Set();
  for (const match of transcript.matchAll(quotation)) {
    const quote = normalizeWhitespace(match[1] ?? match[2] ?? match[3]);
    if ([...quote.replace(/\s/gu, '')].length < minQuoteCharacters || !/[\p{L}\p{N}]/u.test(quote)) continue;
    const matches = new Set(available.filter(({text}) => text.includes(quote)).map(({reference}) => reference));
    if (matches.size === 1) verified.add(matches.values().next().value);
  }
  return [...verified];
}
