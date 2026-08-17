import type { Card, CardKind, Grade, Mode } from '../db/types.ts';

/**
 * The contract every exercise implements.
 *
 * The session runner knows nothing about individual exercises: it asks the
 * registry for the module matching a mode, mounts it, and waits for a reveal.
 * Adding a fifth exercise means adding a module and registering it — no change
 * to the runner.
 */
export interface ExerciseModule {
  readonly mode: Mode;
  readonly label: string;
  /** Card kinds this exercise can draw from. */
  readonly kinds: readonly CardKind[];
  /**
   * Whether the exercise can run right now. Dictation, for example, needs a
   * Chinese speech voice. Returning a reason disables the mode and explains why.
   */
  availability?(): Promise<ExerciseAvailability> | ExerciseAvailability;
  create(card: Card, host: ExerciseHost): ExerciseView;
}

export interface ExerciseAvailability {
  available: boolean;
  /** Shown to the user when unavailable. Should name the cause concretely. */
  reason?: string;
}

/** Callbacks an exercise can use to drive the session runner. */
export interface ExerciseHost {
  /**
   * Move to the answer side. `suggestedGrade` pre-selects a grade for
   * self-marking exercises (dictation compares the typed answer itself).
   */
  reveal(suggestedGrade?: Grade): void;
  /**
   * Speak Chinese text. No-op while `audioAvailable` is false. `auto: true`
   * marks automatic playback, which stays silent until the user's first manual
   * play of the session (iOS gesture rule; also just less startling).
   */
  speak(text: string, opts?: { auto?: boolean }): void;
  /** False until the audio layer (step 4) finds a Chinese voice. Exercises skip rendering replay buttons when false. */
  audioAvailable: boolean;
}

export interface ExerciseView {
  /** Render the question side. */
  renderPrompt(container: HTMLElement): void;
  /** Render the answer side, shown after reveal. */
  renderAnswer(container: HTMLElement): void;
  /**
   * Handle the primary key (Space / Enter) while the prompt is showing.
   * Return true if the exercise consumed it; false to let the runner reveal.
   */
  onPrimaryKey?(): boolean;
  /** Focus the first interactive element, if any. */
  focus?(): void;
  destroy?(): void;
}
