/** Text helpers for CJK detection, cleaning and comparison. */

/** CJK Unified Ideographs. The range the import filter is specified against. */
const CJK_RANGE = /[一-鿿]/;
const CJK_RANGE_GLOBAL = /[一-鿿]/gu;

/**
 * Punctuation stripped before comparing or counting: CJK symbols (U+3000–303F),
 * fullwidth/halfwidth forms (U+FF00–FFEF), and ASCII punctuation.
 */
const PUNCTUATION =
  /[　-〿＀-￯!-/:-@[-`{-~‘’“”…–—¡¿«»‹›]/gu;

const WHITESPACE = /\s+/gu;

export function hasCjk(value: string): boolean {
  return CJK_RANGE.test(value);
}

export function countCjk(value: string): number {
  return value.match(CJK_RANGE_GLOBAL)?.length ?? 0;
}

/** Remove all whitespace and punctuation, leaving the bare characters. */
export function stripPunctuation(value: string): string {
  return value.replace(PUNCTUATION, '').replace(WHITESPACE, '');
}

/** Length in code points of the cleaned string (surrogate-pair safe). */
export function cleanLength(value: string): number {
  return Array.from(stripPunctuation(value)).length;
}

/** Split into individual characters, punctuation and whitespace removed. */
export function toCharacters(value: string): string[] {
  return Array.from(stripPunctuation(value));
}

/** Count whitespace-separated pinyin syllable groups. */
export function pinyinGroups(pinyin: string): number {
  const trimmed = pinyin.trim();
  if (!trimmed) return 0;
  return trimmed.split(WHITESPACE).filter((g) => g.length > 0).length;
}

/** Collapse whitespace and trim — for display and for hashing input. */
export function normalizeSpace(value: string): string {
  return value.replace(WHITESPACE, ' ').trim();
}

/** Canonical form used when comparing a typed answer against the expected hanzi. */
export function normalizeForCompare(value: string): string {
  return stripPunctuation(value.normalize('NFC'));
}
