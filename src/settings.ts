import { db, getSetting, setSetting } from './db/db.ts';
import { FSRS5_DEFAULT_W } from './scheduler/fsrs.ts';

export interface AppSettings {
  /** New cards introduced per day, per mode. */
  newPerDay: number;
  /** Review-state cards shown per day, per mode. Learning cards are never capped. */
  reviewsPerDay: number;
  /** Hour at which the study day rolls over, so late-night sessions count as "today". */
  dayStartHour: number;
  requestRetention: number;
  learningSteps: number[];
  relearningSteps: number[];
  leechThreshold: number;
  /** Speech playback rate, 0.6–1.0. Used from step 4 onward. */
  speechRate: number;
  weights: number[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  newPerDay: 20,
  reviewsPerDay: 200,
  dayStartHour: 4,
  requestRetention: 0.9,
  learningSteps: [1, 10],
  relearningSteps: [10],
  leechThreshold: 8,
  speechRate: 0.9,
  weights: [...FSRS5_DEFAULT_W],
};

const KEY = 'settings';

export async function loadSettings(): Promise<AppSettings> {
  const stored = await getSetting<Partial<AppSettings>>(KEY, {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...(await loadSettings()), ...patch };
  await setSetting(KEY, next);
  return next;
}

export async function resetSettings(): Promise<void> {
  await db.settings.delete(KEY);
}
