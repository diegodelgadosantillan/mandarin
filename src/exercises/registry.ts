import { MODES, type Mode } from '../db/types.ts';
import { dictationExercise } from './dictation.ts';
import { orderingExercise } from './ordering.ts';
import { productionExercise } from './production.ts';
import { recognitionExercise } from './recognition.ts';
import type { ExerciseAvailability, ExerciseModule } from './types.ts';

const REGISTRY = new Map<Mode, ExerciseModule>();

export function registerExercise(module: ExerciseModule): void {
  REGISTRY.set(module.mode, module);
}

export function getExercise(mode: Mode): ExerciseModule | null {
  return REGISTRY.get(mode) ?? null;
}

/** Registered modules, in the canonical mode order. */
export function listExercises(): ExerciseModule[] {
  return MODES.map((mode) => REGISTRY.get(mode)).filter((m): m is ExerciseModule => m !== undefined);
}

export async function checkAvailability(module: ExerciseModule): Promise<ExerciseAvailability> {
  if (!module.availability) return { available: true };
  return module.availability();
}

registerExercise(recognitionExercise);
registerExercise(productionExercise);
registerExercise(dictationExercise);
registerExercise(orderingExercise);
