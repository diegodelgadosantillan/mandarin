import { describe, expect, it } from 'vitest';
import { checkOrder, makeTiles, shuffleTiles, type Tile } from '../src/exercises/ordering-logic.ts';
import { toCharacters } from '../src/core/text.ts';

/** Tiny deterministic RNG (mulberry32) for reproducible shuffles. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function reading(tiles: Tile[]): string {
  return tiles.map((t) => t.char).join('');
}

describe('shuffleTiles', () => {
  it('preserves the multiset of characters', () => {
    const tiles = makeTiles(toCharacters('我们今天不去学校。'));
    const shuffled = shuffleTiles(tiles, seeded(1));
    expect([...reading(shuffled)].sort()).toEqual([...reading(tiles)].sort());
  });

  it('never reads in the correct order across many seeds', () => {
    const sentences = ['我是学生', '你好吗', '一个小时有六十分钟', '我的爱好是打篮球', '大家'];
    for (const sentence of sentences) {
      const characters = toCharacters(sentence);
      const tiles = makeTiles(characters);
      for (let seed = 0; seed < 500; seed++) {
        const shuffled = shuffleTiles(tiles, seeded(seed));
        expect(reading(shuffled)).not.toBe(characters.join(''));
      }
    }
  });

  it('survives the two-character worst case, where half of all shuffles are identity', () => {
    const tiles = makeTiles(['你', '好']);
    for (let seed = 0; seed < 200; seed++) {
      expect(reading(shuffleTiles(tiles, seeded(seed)))).toBe('好你');
    }
  });

  it('handles sentences with repeated characters', () => {
    const characters = toCharacters('妈妈是妈妈');
    const tiles = makeTiles(characters);
    for (let seed = 0; seed < 200; seed++) {
      const shuffled = shuffleTiles(tiles, seeded(seed));
      expect(reading(shuffled)).not.toBe(characters.join(''));
      expect([...reading(shuffled)].sort()).toEqual([...characters].sort());
    }
  });

  it('returns the identity only when no other reading exists', () => {
    // 妈妈: both tiles read 妈 — every arrangement is "correct"; must not loop or throw.
    const tiles = makeTiles(['妈', '妈']);
    expect(reading(shuffleTiles(tiles, seeded(7)))).toBe('妈妈');
    expect(reading(shuffleTiles(makeTiles(['好']), seeded(7)))).toBe('好');
    expect(shuffleTiles(makeTiles([]), seeded(7))).toEqual([]);
  });

  it('does not mutate its input', () => {
    const tiles = makeTiles(['我', '是', '学', '生']);
    const before = reading(tiles);
    shuffleTiles(tiles, seeded(3));
    expect(reading(tiles)).toBe(before);
  });
});

describe('checkOrder', () => {
  const expected = toCharacters('我是学生');

  it('marks every position green for a correct arrangement', () => {
    const placed = makeTiles(expected);
    expect(checkOrder(placed, expected)).toEqual([true, true, true, true]);
  });

  it('marks exactly the wrong positions red', () => {
    // 我学是生: positions 1 and 2 swapped.
    const tiles = makeTiles(expected);
    const placed = [tiles[0], tiles[2], tiles[1], tiles[3]] as Tile[];
    expect(checkOrder(placed, expected)).toEqual([true, false, false, true]);
  });

  it('compares by character value so duplicate tiles interchange freely', () => {
    const characters = toCharacters('妈妈好');
    const tiles = makeTiles(characters);
    // Swap the two 妈 tiles: still reads 妈妈好 -> all green.
    const placed = [tiles[1], tiles[0], tiles[2]] as Tile[];
    expect(checkOrder(placed, characters)).toEqual([true, true, true]);
  });
});
