import { describe, expect, it } from 'vitest';
import { createDictationEdits, polishReplyDictation, validateDictationEdits } from '../src/dictation-polish';

const mustKeep = [
  '음 연구원님께 전달해 주세요',
  '아 박사님께 연락해 주세요',
  '어 실장님께 전달해 주세요',
  '내일 내일 연구원님께 전달하겠습니다',
  '음 팀장님께 전달해 주세요',
  '아 선생님께 연락해 주세요',
  '어 민수 씨에게 전달하겠습니다',
  '어 민수 님께서 확인하셨습니다',
  '음 민수님께 전달해 주세요',
  '아 김민수님께 연락해 주세요',
  '어 Alex 씨에게 전달하겠습니다',
  '어 Alex님께 전달하겠습니다',
  '음 연구원 님께 전달해 주세요',
  '어 민수 연구원 님께 전달하겠습니다',
  '어 민수 신임연구원 님께 전달하겠습니다',
  '내일 내일 팀장님께 전달하겠습니다',
  '회의 회의 선생님께 전달하겠습니다',
  '내일 내일 민수 씨에게 전달하겠습니다',
  '내일 내일 민수 님께서 확인하셨습니다',
  '내일 내일 민수님께 전달하겠습니다',
  '내일 내일 내일 연구원님께 전달하겠습니다',
  '민수  님께 전달하겠습니다',
  '어  민수님께 전달하겠습니다',
  '내일  내일  연구원님께 전달하겠습니다',
  '어 오늘 견적서는 자료 자료 연구원님께 보내겠습니다',
];

describe('honorific adjacency protects original dictation without a title list', () => {
  it.each(mustKeep)('keeps every original character near a potential name: %s', raw => {
    // The existing optional terminal period is allowed; no deletion/collapse is.
    expect(polishReplyDictation(raw).body).toBe(`${raw}.`);
    expect(createDictationEdits(raw)).toEqual([]);
  });
  it.each([
    ['어 오늘은 못 갑니다', '오늘은 못 갑니다.'],
    ['어 견적서는 내일 아니 모레 보내드릴게요', '견적서는 모레 보내드릴게요.'],
    ['어 오늘 자료를 정리해서 민수님께 보내겠습니다', '어 오늘 자료를 정리해서 민수님께 보내겠습니다.'],
    ['오늘 아니 내일 연구원님께 전달하겠습니다', '내일 연구원님께 전달하겠습니다.'],
    ['오늘 아니 내일 팀장님께 전달하겠습니다', '내일 팀장님께 전달하겠습니다.'],
    ['오늘 아니 내일 선생님께 전달하겠습니다', '내일 선생님께 전달하겠습니다.'],
    ['오늘 아니 내일 민수님께 전달하겠습니다', '내일 민수님께 전달하겠습니다.'],
    ['오늘 아니 내일 민수 씨에게 전달하겠습니다', '내일 민수 씨에게 전달하겠습니다.'],
    ['두 개 아니 세 개 민수님께 전달하겠습니다', '세 개 민수님께 전달하겠습니다.'],
    ['민수님께  자료를 전달하겠습니다', '민수님께 자료를 전달하겠습니다.'],
    ['민수님께 자료 자료 전달하겠습니다', '민수님께 자료 전달하겠습니다.'],
    ['내일 아니 모레 갈게요', '모레 갈게요.'],
    ['두 개 아니 세 개 준비하겠습니다', '세 개 준비하겠습니다.'],
  ])('keeps legitimate cleanup away from name context: %s', (raw, expected) => {
    expect(polishReplyDictation(raw)).toMatchObject({ body: expected, reason: 'applied' });
  });
  it('independently rejects prefix deletions while permitting a validated correction', () => {
    expect(validateDictationEdits('어 민수 님께 전달하겠습니다', [{ start: 0, end: 2, kind: 'filler' }])).toBeNull();
    expect(validateDictationEdits('내일 내일 연구원님께 전달하겠습니다', [{ start: 0, end: 3, kind: 'repeat' }])).toBeNull();
    const corrected = '오늘 아니 내일 연구원님께 전달하겠습니다';
    expect(validateDictationEdits(corrected, [{ start: 0, end: corrected.indexOf('내일'), kind: 'correction' }])).toBe('내일 연구원님께 전달하겠습니다.');
    const spaced = '민수  님께 전달하겠습니다';
    const start = spaced.indexOf('  ') + 1;
    expect(validateDictationEdits(spaced, [{ start, end: start + 1, kind: 'whitespace' }])).toBeNull();
  });
});
