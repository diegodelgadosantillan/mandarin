/** Pure logic for the character-ordering exercise, kept separate for testing. */

export interface Tile {
  /** Stable identity so duplicate characters remain distinct tiles. */
  id: number;
  char: string;
}

export function makeTiles(characters: string[]): Tile[] {
  return characters.map((char, id) => ({ id, char }));
}

/**
 * Fisher-Yates shuffle that never returns the tiles reading in the correct
 * order (by character value).
 *
 * When every character is identical (妈妈) no other reading exists, so the
 * guarantee is vacuous and the original order comes back; in every other case
 * an identity result is repaired by swapping the first two differing tiles.
 */
export function shuffleTiles(tiles: Tile[], rng: () => number = Math.random): Tile[] {
  const out = [...tiles];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i] as Tile;
    out[i] = out[j] as Tile;
    out[j] = a;
  }

  const readsCorrectly = out.every((tile, index) => tile.char === (tiles[index] as Tile).char);
  if (readsCorrectly) {
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if ((out[i] as Tile).char !== (out[j] as Tile).char) {
          const a = out[i] as Tile;
          out[i] = out[j] as Tile;
          out[j] = a;
          return out;
        }
      }
    }
  }
  return out;
}

/** Per-position verdict of a complete arrangement, compared by character value. */
export function checkOrder(placed: Tile[], expected: string[]): boolean[] {
  return expected.map((char, index) => placed[index]?.char === char);
}
