/**
 * Dev tool: run the legacy migrator against a real prototype backup in an
 * in-memory database and report what would happen. Read-only on the file;
 * nothing outside this process is touched.
 *
 *   node scripts/check-legacy-migration.ts "path\to\mandarin-backup.json"
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { detectFormat, importLegacy, type LegacyBackup } from '../src/backup/backup.ts';
import { db } from '../src/db/db.ts';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/check-legacy-migration.ts <backup.json>');
  process.exit(1);
}

const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
console.log('format:', detectFormat(raw));

const backup = raw as LegacyBackup;
console.log(`backup: ${backup.cards.length} cards, ${backup.logs?.length ?? 0} logs, exported ${backup.exportedAt}`);

const summary = await importLegacy(backup);
console.log('\nsummary:', JSON.stringify(summary, null, 2));

const decks = await db.decks.toArray();
console.log('\ndecks:');
for (const deck of decks) console.log(`  ${deck.name}: ${deck.cardCount} cards`);

const cards = await db.cards.toArray();
const words = cards.filter((c) => c.kind === 'word').length;
console.log(`\ncards: ${cards.length} total, ${words} words, ${cards.length - words} sentences`);

const reviews = await db.reviews.toArray();
const states = new Map<string, number>();
for (const review of reviews) states.set(review.state, (states.get(review.state) ?? 0) + 1);
console.log(`reviews: ${reviews.length}`, Object.fromEntries(states));
const leeches = reviews.filter((r) => r.leech === 1).length;
console.log(`leeches: ${leeches}`);

const due = reviews.filter((r) => r.due <= Date.now()).length;
console.log(`due now (recognition): ${due}`);

const logs = await db.reviewLogs.count();
console.log(`logs: ${logs}`);

// Sample a mature card to eyeball values.
const mature = reviews.filter((r) => r.stability > 30).sort((a, b) => b.stability - a.stability)[0];
if (mature) {
  const card = await db.cards.get(mature.cardId);
  console.log(
    `\nsample mature: ${card?.hanzi} S=${mature.stability} D=${mature.difficulty} reps=${mature.reps} due=${new Date(mature.due).toISOString().slice(0, 10)}`,
  );
}
