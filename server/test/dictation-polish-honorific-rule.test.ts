import { describe, expect, it } from 'vitest';
import { createDictationEdits, polishReplyDictation, validateDictationEdits, type DictationEdit } from '../src/dictation-polish';
import verifier from './fixtures/dictation-polish-honorific-verifier.json';

describe('conservative last-honorific prefix rule', () => {
  // Synthetic verifier inputs with literal, reviewed coordinator-rule answers.
  // These fixtures do not read probe outputs or compute expected edits at runtime.
  it.each(verifier.cases)('honors the current policy for $probe: $raw', ({ raw, expected }) => {
    expect(polishReplyDictation(raw).body).toBe(expected);
  });
  it.each(verifier.rejected)('rejects direct unsafe span submissions: $raw', ({ raw, edits }) => {
    expect(validateDictationEdits(raw, edits as DictationEdit[])).toBeNull();
  });
  it.each([
    '어 오늘 자료를 정리해서 민수님께 보내겠습니다',
    '어 민서씨에게 전달하겠습니다',
    '어 님께서는 확인하셨습니다',
    '어 함께 자료를 보내겠습니다',
    '어 민서  씨에게 전달하겠습니다',
    '민수님께, 어 오늘 자료를 다은씨에게 전달하겠습니다',
  ])('does not infer phrase or particle boundaries before the last marker: %s', raw => {
    expect(createDictationEdits(raw)).toEqual([]);
    expect(polishReplyDictation(raw).body).toBe(`${raw}.`);
  });
  it.each([
    ['어 오늘은 못 갑니다', '오늘은 못 갑니다.'],
    ['어 견적서는 내일 아니 모레 보내드릴게요', '견적서는 모레 보내드릴게요.'],
    ['음 그 자료는 내일 보내드릴게요', '그 자료는 내일 보내드릴게요.'],
    ['어 민서씨에게, 어 오늘 오늘  자료를 보내겠습니다', '어 민서씨에게, 오늘 자료를 보내겠습니다.'],
    ['민수님께  자료 자료 전달하겠습니다', '민수님께 자료 전달하겠습니다.'],
    ['어 함께, 음 내일 내일  보내겠습니다', '어 함께, 내일 보내겠습니다.'],
    ['어 오늘 아니 내일 민서씨에게 전달하겠습니다', '어 내일 민서씨에게 전달하겠습니다.'],
    ['민서씨에게 오늘 아니 내일 전달하겠습니다', '민서씨에게 내일 전달하겠습니다.'],
    ['월요일 아니 화요일에 님께 전달하겠습니다', '화요일에 님께 전달하겠습니다.'],
    ['세 시 아니 네 시에 선생님께 전달하겠습니다', '네 시에 선생님께 전달하겠습니다.'],
    ['두 개 아니 세 개 함께 보내겠습니다', '세 개 함께 보내겠습니다.'],
    ['3명 말고 4명 민서씨에게 전달하겠습니다', '4명 민서씨에게 전달하겠습니다.'],
  ])('allows validated corrections anywhere and ordinary edits after the marker: %s', (raw, expected) => {
    expect(polishReplyDictation(raw).body).toBe(expected);
    expect(validateDictationEdits(raw, createDictationEdits(raw))).toBe(expected);
  });
  it('does not let a correction label bypass slot grammar or prefix protection', () => {
    const raw = '어 오늘 아니 내일 민서씨에게 전달하겠습니다';
    expect(createDictationEdits(raw)).toEqual([{ start: 2, end: 8, kind: 'correction' }]);
    expect(validateDictationEdits(raw, [{ start: 0, end: 2, kind: 'correction' }])).toBeNull();
    expect(validateDictationEdits(raw, [{ start: 0, end: 2, kind: 'filler' }, { start: 2, end: 8, kind: 'correction' }])).toBeNull();
    expect(validateDictationEdits(raw, [{ start: 2, end: 8, kind: 'correction' }])).toBe('어 내일 민서씨에게 전달하겠습니다.');
  });
});
