import { toCharacters } from '../core/text.ts';

/**
 * Character-level comparison for dictation.
 *
 * Both strings are reduced to bare characters (whitespace and CJK/Latin
 * punctuation stripped) and aligned with a longest-common-subsequence pass, so
 * the result names exactly which characters were wrong, missing or extra —
 * "incorrect" alone teaches nothing.
 */

export interface DiffCell {
  char: string;
  /** In the typed row: false = extra/wrong. In the expected row: false = missing/not produced. */
  ok: boolean;
}

export interface CharDiff {
  correct: boolean;
  /** What the user typed, per character. */
  typed: DiffCell[];
  /** What was expected, per character. */
  expected: DiffCell[];
  /** Characters the user produced that match the expected sequence. */
  matched: number;
}

/** Standard LCS table over two character arrays (inputs here are short). */
function lcsTable(a: string[], b: string[]): Uint16Array {
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      table[i * width + j] =
        a[i - 1] === b[j - 1]
          ? (table[(i - 1) * width + (j - 1)] as number) + 1
          : Math.max(table[(i - 1) * width + j] as number, table[i * width + (j - 1)] as number);
    }
  }
  return table;
}

export function diffChars(typedRaw: string, expectedRaw: string): CharDiff {
  const typed = toCharacters(typedRaw.normalize('NFC'));
  const expected = toCharacters(expectedRaw.normalize('NFC'));

  const width = expected.length + 1;
  const table = lcsTable(typed, expected);

  // Walk the table back to mark LCS membership on both sides.
  const typedOk = new Array<boolean>(typed.length).fill(false);
  const expectedOk = new Array<boolean>(expected.length).fill(false);
  let i = typed.length;
  let j = expected.length;
  while (i > 0 && j > 0) {
    if (typed[i - 1] === expected[j - 1]) {
      typedOk[i - 1] = true;
      expectedOk[j - 1] = true;
      i--;
      j--;
    } else if ((table[(i - 1) * width + j] as number) >= (table[i * width + (j - 1)] as number)) {
      i--;
    } else {
      j--;
    }
  }

  const matched = typedOk.filter(Boolean).length;
  return {
    correct: typed.length === expected.length && matched === expected.length && expected.length > 0,
    typed: typed.map((char, index) => ({ char, ok: typedOk[index] as boolean })),
    expected: expected.map((char, index) => ({ char, ok: expectedOk[index] as boolean })),
    matched,
  };
}
