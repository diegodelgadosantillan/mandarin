import { cleanLength, pinyinGroups } from '../core/text.ts';
import type { CardKind } from '../db/types.ts';

/**
 * Auto-classify a row as a word or a sentence.
 *
 * Sentence when the cleaned hanzi is 6+ characters, or 4+ characters with at
 * least 3 whitespace-separated pinyin syllable groups (which catches short
 * sentences like 我是学生 that a length test alone would call a word).
 */
export function classifyKind(hanzi: string, pinyin: string): CardKind {
  const length = cleanLength(hanzi);
  if (length >= 6) return 'sentence';
  if (length >= 4 && pinyinGroups(pinyin) >= 3) return 'sentence';
  return 'word';
}
