import type * as XLSX from 'xlsx';
import { hasCjk, normalizeSpace } from '../core/text.ts';
import type { CardKind } from '../db/types.ts';
import { classifyKind } from './classify.ts';

export interface ParsedRow {
  hanzi: string;
  pinyin: string;
  spanish: string;
  /** Auto-classification; the user can override it in the preview. */
  kind: CardKind;
  sheet: string;
  /** 1-based row number in the source sheet, for error reporting. */
  sourceRow: number;
}

export interface SheetResult {
  sheet: string;
  /** Zero-based indices of the hanzi / pinyin / Spanish columns. */
  columns: [number, number, number];
  /** True when the columns were auto-detected rather than the default A/B/C. */
  detected: boolean;
  rows: ParsedRow[];
  /** Rows skipped because the hanzi cell held no CJK. */
  skipped: number;
}

export interface FileResult {
  fileName: string;
  /** Default deck name: the filename without its extension. */
  deckName: string;
  sheets: SheetResult[];
  error?: string;
}

/** Zero-based column index to spreadsheet letter: 0 -> A, 25 -> Z, 26 -> AA. */
export function columnLetter(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function cell(row: string[] | undefined, index: number): string {
  return normalizeSpace(row?.[index] ?? '');
}

/**
 * Pick the hanzi/pinyin/Spanish columns.
 *
 * The documented layout is column 1/2/3, and that is what we use whenever
 * column 1 genuinely holds Chinese. Some real workbooks put an index or
 * category column first (hanzi lands in D), which under a fixed A/B/C rule
 * would silently import zero rows — so when column 1 is empty of CJK we fall
 * back to the densest CJK column and report the choice in the preview.
 */
export function detectColumns(matrix: string[][]): {
  columns: [number, number, number];
  detected: boolean;
} {
  const width = matrix.reduce((max, row) => Math.max(max, row.length), 0);
  const scores: number[] = new Array(width).fill(0);
  for (const row of matrix) {
    for (let c = 0; c < width; c++) {
      if (hasCjk(row[c] ?? '')) scores[c] = (scores[c] ?? 0) + 1;
    }
  }

  const first = scores[0] ?? 0;
  let best = 0;
  let bestScore = first;
  for (let c = 1; c < width; c++) {
    const score = scores[c] ?? 0;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }

  if (bestScore === 0) return { columns: [0, 1, 2], detected: false };
  // Stay on A/B/C unless another column is clearly the real hanzi column.
  if (first > 0 && first >= bestScore * 0.5) return { columns: [0, 1, 2], detected: false };
  return { columns: [best, best + 1, best + 2], detected: true };
}

/**
 * Turn a sheet's cell matrix into rows. No header row is assumed: any row whose
 * hanzi cell contains no CJK character is skipped, which discards headers,
 * blank spacers and section titles alike.
 */
export function parseMatrix(
  matrix: string[][],
  sheet: string,
  forcedColumns?: [number, number, number],
): SheetResult {
  const { columns, detected } = forcedColumns
    ? { columns: forcedColumns, detected: false }
    : detectColumns(matrix);
  const [hanziCol, pinyinCol, spanishCol] = columns;

  const rows: ParsedRow[] = [];
  let skipped = 0;

  for (let r = 0; r < matrix.length; r++) {
    const row = matrix[r];
    const hanzi = cell(row, hanziCol);
    if (!hasCjk(hanzi)) {
      skipped++;
      continue;
    }
    const pinyin = cell(row, pinyinCol);
    const spanish = cell(row, spanishCol);
    rows.push({
      hanzi,
      pinyin,
      spanish,
      kind: classifyKind(hanzi, pinyin),
      sheet,
      sourceRow: r + 1,
    });
  }

  return { sheet, columns, detected, rows, skipped };
}

function sheetToMatrix(xlsx: typeof XLSX, worksheet: XLSX.WorkSheet): string[][] {
  const raw = xlsx.utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  });
  return raw.map((row) => (Array.isArray(row) ? row.map((v) => (v == null ? '' : String(v))) : []));
}

/**
 * Read every sheet in the workbook, not just the first.
 *
 * SheetJS is imported dynamically: it is by far the largest dependency and is
 * only needed while importing, so it stays out of the startup bundle.
 */
export async function parseFile(file: File): Promise<FileResult> {
  const deckName = file.name.replace(/\.[^.]+$/, '') || file.name;
  try {
    const xlsx = await import('xlsx');
    const extension = file.name.toLowerCase().split('.').pop() ?? '';
    let workbook: XLSX.WorkBook;
    if (extension === 'csv' || extension === 'tsv' || extension === 'txt') {
      // Read delimited files as text so UTF-8 hanzi survives regardless of BOM.
      workbook = xlsx.read(await file.text(), { type: 'string', raw: false });
    } else {
      workbook = xlsx.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
    }

    const sheets = workbook.SheetNames.map((name) => {
      const worksheet = workbook.Sheets[name];
      if (!worksheet) {
        return { sheet: name, columns: [0, 1, 2] as [number, number, number], detected: false, rows: [], skipped: 0 };
      }
      return parseMatrix(sheetToMatrix(xlsx, worksheet), name);
    }).filter((sheet) => sheet.rows.length > 0 || sheet.skipped > 0);

    return { fileName: file.name, deckName, sheets };
  } catch (error) {
    return {
      fileName: file.name,
      deckName,
      sheets: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
