import { describe, expect, it } from 'vitest';
import { isSafeReplyBody } from '../src/tts';
import {
  createDictationEdits,
  polishReplyDictation,
  validateDictationEdits,
  type DictationEdit,
} from '../src/dictation-polish';
import { dictationPolishCases } from './fixtures/dictation-polish';

const codepoints = (text: string) => [...text].length;

describe('deterministic reply dictation polish', () => {
  it('keeps the reviewed Korean gold set at or above the required category sizes', () => {
    expect(dictationPolishCases.length).toBeGreaterThanOrEqual(100);
    expect(new Set(dictationPolishCases.map(([, raw]) => raw)).size).toBeGreaterThanOrEqual(100);
    const minimums: Record<string, number> = {
      filler: 15,
      correction: 20,
      protected: 20,
      name: 15,
      number: 15,
      policy: 15,
    };
    for (const [category, minimum] of Object.entries(minimums)) {
      expect(dictationPolishCases.filter(([group]) => group === category).length, category).toBeGreaterThanOrEqual(minimum);
    }
    expect(dictationPolishCases.filter(([group]) => group === 'unchanged-table')).toHaveLength(12);
  });

  it.each(dictationPolishCases)('%s: preserves the reviewed meaning for %s', (_category, raw, expected) => {
    const result = polishReplyDictation(raw);
    expect(result.body).toBe(expected);
    expect(result.rawLength).toBe(codepoints(raw.trim()));
    expect(result.finalLength).toBe(codepoints(expected));
    if (result.reason !== 'raw_invalid') expect(isSafeReplyBody(result.body)).toBe(true);
  });

  it('only returns validated, non-overlapping deletion spans and reconstructs from the raw text', () => {
    for (const [, raw] of dictationPolishCases) {
      const baseline = raw.trim();
      const edits = createDictationEdits(baseline);
      let previousEnd = 0;
      for (const edit of edits) {
        expect(edit.start).toBeGreaterThanOrEqual(previousEnd);
        expect(edit.end).toBeGreaterThan(edit.start);
        expect(edit.end).toBeLessThanOrEqual(codepoints(baseline));
        previousEnd = edit.end;
      }
      const assembled = validateDictationEdits(baseline, edits);
      if (isSafeReplyBody(baseline)) expect(assembled ?? baseline).toBe(polishReplyDictation(raw).body);
    }
  });

  it('rejects malformed, out-of-bounds, and overlapping edit spans', () => {
    const raw = '내일 회신하겠습니다';
    const bad = [
      [{ start: 0, end: 2, kind: 'filler' }, { start: 1, end: 3, kind: 'repeat' }],
      [{ start: 0, end: 99, kind: 'filler' }],
      [{ start: 2, end: 1, kind: 'repeat' }],
      [{ start: 0, end: 1, kind: 'unknown' }],
    ] as unknown as DictationEdit[][];
    for (const edits of bad) expect(validateDictationEdits(raw, edits)).toBeNull();
  });

  it('does not turn policy-invalid numeric or mixed-letter dictation into an approved body', () => {
    for (const raw of ['01012345678로 보내 주세요', 'A1로 진행해요', '3.5로 할게요', '프로젝트 007 회의']) {
      const result = polishReplyDictation(raw);
      expect(result.reason).toBe('raw_invalid');
      expect(result.body).toBe(raw);
      expect(isSafeReplyBody(result.body)).toBe(false);
    }
  });

  it('keeps original digit runs and condition/negation/uncertainty markers in non-correction cases', () => {
    const protectedWords = ['못', '안', '않', '없', '가능하면', '면', '것 같', '수 있'];
    for (const [category, raw, expected] of dictationPolishCases) {
      if (category !== 'correction') {
        expect([...expected.matchAll(/\d+/gu)].map(m => m[0])).toEqual([...raw.matchAll(/\d+/gu)].map(m => m[0]));
      }
      for (const marker of protectedWords) {
        expect(expected.split(marker).length - 1).toBe(raw.split(marker).length - 1);
      }
    }
  });
});
