import { describe, expect, it } from 'vitest';
import { classifyKind } from '../src/import/classify.ts';
import { detectColumns, parseMatrix } from '../src/import/parse.ts';
import { stableCardId } from '../src/core/hash.ts';
import { cleanLength, hasCjk, pinyinGroups, stripPunctuation, toCharacters } from '../src/core/text.ts';

describe('text helpers', () => {
  it('detects CJK in the U+4E00–U+9FFF range', () => {
    expect(hasCjk('苹果')).toBe(true);
    expect(hasCjk('manzana')).toBe(false);
    expect(hasCjk('')).toBe(false);
    expect(hasCjk('123')).toBe(false);
    // Pinyin with tone marks is Latin, not CJK.
    expect(hasCjk('píngguǒ')).toBe(false);
  });

  it('strips CJK and Latin punctuation, and whitespace along with it', () => {
    expect(stripPunctuation('你们都是中国人吗？')).toBe('你们都是中国人吗');
    expect(stripPunctuation('我 是 学生。')).toBe('我是学生');
    // Whitespace is removed too — dictation comparison must ignore spacing.
    expect(stripPunctuation('«Hola», dijo.')).toBe('Holadijo');
    expect(stripPunctuation('¿Qué tal?')).toBe('Quétal');
  });

  it('counts cleaned length in code points', () => {
    expect(cleanLength('一个小时有六十分钟。')).toBe(9);
    expect(cleanLength('苹果')).toBe(2);
  });

  it('splits into characters with punctuation removed', () => {
    expect(toCharacters('我是学生。')).toEqual(['我', '是', '学', '生']);
  });

  it('counts whitespace-separated pinyin groups', () => {
    expect(pinyinGroups('wǒ shì xuésheng')).toBe(3);
    expect(pinyinGroups('  píngguǒ  ')).toBe(1);
    expect(pinyinGroups('')).toBe(0);
  });
});

describe('classifyKind', () => {
  it('treats short hanzi as words', () => {
    expect(classifyKind('苹果', 'píngguǒ')).toBe('word');
    expect(classifyKind('图书馆', 'túshūguǎn')).toBe('word');
  });

  it('treats 6+ cleaned characters as a sentence regardless of pinyin', () => {
    expect(classifyKind('一个小时有六十分钟。', 'Yí ge xiǎoshí yǒu liù shí fēnzhōng.')).toBe('sentence');
    expect(classifyKind('你们都是中国人吗？', '')).toBe('sentence');
  });

  it('treats 4-5 characters with 3+ pinyin groups as a sentence', () => {
    expect(classifyKind('我是学生', 'wǒ shì xuésheng')).toBe('sentence');
    expect(classifyKind('我很高兴', 'wǒ hěn gāoxìng')).toBe('sentence');
  });

  it('keeps 4-character compounds with few pinyin groups as words', () => {
    expect(classifyKind('中华人民', 'zhōnghuá rénmín')).toBe('word');
  });

  it('ignores punctuation when measuring length', () => {
    // 3 characters once ？ is stripped, so it stays a word by the length rule.
    expect(classifyKind('你好吗？', 'nǐ hǎo ma')).toBe('word');
  });
});

describe('detectColumns', () => {
  it('uses columns A/B/C when column A holds hanzi', () => {
    const result = detectColumns([['苹果', 'píngguǒ', 'manzana']]);
    expect(result).toEqual({ columns: [0, 1, 2], detected: false });
  });

  it('ignores a header row and still picks A/B/C', () => {
    const result = detectColumns([
      ['Hanzi', 'Pinyin', 'Español'],
      ['苹果', 'píngguǒ', 'manzana'],
    ]);
    expect(result).toEqual({ columns: [0, 1, 2], detected: false });
  });

  it('falls back to the densest CJK column when column A is an index column', () => {
    const matrix = [
      ['#', 'Categoría', 'Subcategoría', 'Carácter', 'Pinyin', 'Español'],
      ['1', 'Comida', 'Fruta', '苹果', 'píngguǒ', 'manzana'],
      ['2', 'Comida', 'Fruta', '香蕉', 'xiāngjiāo', 'plátano'],
    ];
    expect(detectColumns(matrix)).toEqual({ columns: [3, 4, 5], detected: true });
  });

  it('prefers a strongly-populated column A over stray CJK elsewhere', () => {
    const matrix = [
      ['苹果', 'píngguǒ', 'manzana'],
      ['香蕉', 'xiāngjiāo', 'plátano'],
      ['水', 'shuǐ', 'agua', '注'],
    ];
    expect(detectColumns(matrix)).toEqual({ columns: [0, 1, 2], detected: false });
  });

  it('defaults to A/B/C when nothing has CJK at all', () => {
    expect(detectColumns([['a', 'b', 'c']])).toEqual({ columns: [0, 1, 2], detected: false });
    expect(detectColumns([])).toEqual({ columns: [0, 1, 2], detected: false });
  });
});

describe('parseMatrix', () => {
  it('skips rows whose hanzi cell has no CJK and counts them', () => {
    const result = parseMatrix(
      [
        ['Hanzi', 'Pinyin', 'Español'],
        ['苹果', 'píngguǒ', 'manzana'],
        ['', '', ''],
        ['-- sección --', '', ''],
        ['我是学生', 'wǒ shì xuésheng', 'Soy estudiante'],
      ],
      'Hoja1',
    );

    expect(result.rows.map((r) => r.hanzi)).toEqual(['苹果', '我是学生']);
    expect(result.skipped).toBe(3);
    expect(result.columns).toEqual([0, 1, 2]);
  });

  it('classifies each row and records its source position', () => {
    const result = parseMatrix(
      [
        ['苹果', 'píngguǒ', 'manzana'],
        ['我是学生', 'wǒ shì xuésheng', 'Soy estudiante'],
      ],
      'Hoja1',
    );
    expect(result.rows[0]?.kind).toBe('word');
    expect(result.rows[1]?.kind).toBe('sentence');
    expect(result.rows[1]?.sourceRow).toBe(2);
    expect(result.rows[0]?.sheet).toBe('Hoja1');
  });

  it('trims and collapses whitespace in cell values', () => {
    const result = parseMatrix([['  苹果 ', ' píng  guǒ ', '  manzana ']], 'Hoja1');
    expect(result.rows[0]).toMatchObject({ hanzi: '苹果', pinyin: 'píng guǒ', spanish: 'manzana' });
  });

  it('honours forced columns', () => {
    const result = parseMatrix([['1', '苹果', 'píngguǒ', 'manzana']], 'Hoja1', [1, 2, 3]);
    expect(result.rows[0]).toMatchObject({ hanzi: '苹果', pinyin: 'píngguǒ', spanish: 'manzana' });
  });
});

describe('stableCardId', () => {
  it('is stable for the same content', () => {
    expect(stableCardId('苹果', 'manzana')).toBe(stableCardId('苹果', 'manzana'));
  });

  it('ignores capitalisation and surrounding whitespace in the Spanish column', () => {
    expect(stableCardId('苹果', 'Manzana')).toBe(stableCardId('苹果', '  manzana '));
  });

  it('differs when the hanzi or the meaning differs', () => {
    expect(stableCardId('苹果', 'manzana')).not.toBe(stableCardId('香蕉', 'manzana'));
    expect(stableCardId('苹果', 'manzana')).not.toBe(stableCardId('苹果', 'pera'));
  });

  it('produces a 16-character hex id', () => {
    expect(stableCardId('苹果', 'manzana')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('does not collide across a realistic vocabulary size', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i++) ids.add(stableCardId(`词${i}`, `palabra ${i}`));
    expect(ids.size).toBe(5000);
  });
});
