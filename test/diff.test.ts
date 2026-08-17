import { describe, expect, it } from 'vitest';
import { diffChars } from '../src/exercises/diff.ts';

function typedString(diff: ReturnType<typeof diffChars>): string {
  return diff.typed.map((c) => `${c.char}${c.ok ? '' : '×'}`).join('');
}

function expectedString(diff: ReturnType<typeof diffChars>): string {
  return diff.expected.map((c) => `${c.char}${c.ok ? '' : '!'}`).join('');
}

describe('diffChars', () => {
  it('accepts an exact match', () => {
    const diff = diffChars('我是学生', '我是学生');
    expect(diff.correct).toBe(true);
    expect(diff.matched).toBe(4);
  });

  it('ignores whitespace and CJK/Latin punctuation on both sides', () => {
    expect(diffChars('我 是 学生', '我是学生。').correct).toBe(true);
    expect(diffChars('你好吗', '你好吗？').correct).toBe(true);
    expect(diffChars('  你们都是中国人吗  ', '你们都是中国人吗？').correct).toBe(true);
  });

  it('flags a wrong character as extra in typed and missing in expected', () => {
    const diff = diffChars('我是字生', '我是学生');
    expect(diff.correct).toBe(false);
    expect(diff.matched).toBe(3);
    expect(typedString(diff)).toBe('我是字×生');
    expect(expectedString(diff)).toBe('我是学!生');
  });

  it('flags a missing character only on the expected side', () => {
    const diff = diffChars('我学生', '我是学生');
    expect(diff.correct).toBe(false);
    expect(typedString(diff)).toBe('我学生');
    expect(expectedString(diff)).toBe('我是!学生');
  });

  it('flags an extra character only on the typed side', () => {
    const diff = diffChars('我是的学生', '我是学生');
    expect(diff.correct).toBe(false);
    expect(typedString(diff)).toBe('我是的×学生');
    expect(expectedString(diff)).toBe('我是学生');
  });

  it('handles the empty answer', () => {
    const diff = diffChars('', '我是学生');
    expect(diff.correct).toBe(false);
    expect(diff.matched).toBe(0);
    expect(diff.typed).toHaveLength(0);
    expect(diff.expected.every((c) => !c.ok)).toBe(true);
  });

  it('handles a completely wrong answer', () => {
    const diff = diffChars('你好', '再见');
    expect(diff.correct).toBe(false);
    expect(diff.matched).toBe(0);
    expect(typedString(diff)).toBe('你×好×');
    expect(expectedString(diff)).toBe('再!见!');
  });

  it('does not report correct for two empty strings', () => {
    // An empty expected string should never happen, but must not read "correct".
    expect(diffChars('', '').correct).toBe(false);
  });

  it('requires equal length even when all typed characters match', () => {
    // Typed is a subsequence: matched chars but shorter -> incorrect.
    const diff = diffChars('我是学生', '我是学生的');
    expect(diff.correct).toBe(false);
    expect(diff.matched).toBe(4);
  });

  it('keeps alignment sensible with repeated characters', () => {
    const diff = diffChars('妈妈', '妈妈妈');
    expect(diff.matched).toBe(2);
    expect(expectedString(diff).match(/!/g)).toHaveLength(1);
  });
});
