/**
 * Dev tool: run the real import parser over a folder of spreadsheets and print
 * what it found — detected columns, row counts, classification split, samples.
 *
 * Guards against the failure mode where a fixed A/B/C column rule silently
 * imports zero rows from a workbook that has an index column first.
 *
 *   node scripts/check-parse.ts "C:\path\to\folder"
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseFile } from '../src/import/parse.ts';
import { columnLetter } from '../src/import/parse.ts';

const folder = process.argv[2];
if (!folder) {
  console.error('Usage: node scripts/check-parse.ts <folder>');
  process.exit(1);
}

const files = readdirSync(folder).filter((name) => /\.(xlsx|xls|xlsm|csv|tsv)$/i.test(name));
if (files.length === 0) {
  console.error(`No spreadsheets found in ${folder}`);
  process.exit(1);
}

let grandTotal = 0;

for (const name of files) {
  const buffer = readFileSync(join(folder, name));
  const file = new File([buffer], basename(name));
  const result = await parseFile(file);

  if (result.error) {
    console.log(`\n${name}\n  ERROR: ${result.error}`);
    continue;
  }

  const rows = result.sheets.flatMap((sheet) => sheet.rows);
  const words = rows.filter((row) => row.kind === 'word').length;
  grandTotal += rows.length;

  console.log(`\n${name}  ->  deck "${result.deckName}"`);
  for (const sheet of result.sheets) {
    const cols = sheet.columns.map(columnLetter).join('/');
    console.log(
      `  sheet "${sheet.sheet}": cols ${cols}${sheet.detected ? ' (DETECTED)' : ''}` +
        `, ${sheet.rows.length} rows, ${sheet.skipped} skipped`,
    );
  }
  console.log(`  total ${rows.length} rows: ${words} words, ${rows.length - words} sentences`);
  for (const row of rows.slice(0, 3)) {
    console.log(`    [${row.kind.padEnd(8)}] ${row.hanzi}  |  ${row.pinyin}  |  ${row.spanish}`);
  }
}

console.log(`\nGRAND TOTAL: ${grandTotal} rows across ${files.length} files`);
