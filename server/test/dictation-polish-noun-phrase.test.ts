import { describe, expect, it } from 'vitest';
import { createDictationEdits, polishReplyDictation, validateDictationEdits } from '../src/dictation-polish';

const longTitles = [
  '음 글로벌 사업 개발 본부장님께 전달해 주세요',
  '어 디지털 전환 전략 실장님께 전달해 주세요',
  '음 수석 소프트웨어 개발 팀장님께 전달해 주세요',
  '음 선임 연구 개발 실장님께 전달해 주세요',
];

describe('honorific prefix ignores noun-phrase and suffix guesses', () => {
  it.each([
    ...longTitles,
    '음   글로벌 사업 개발 본부장님께 전달해 주세요',
    '음  글로벌  사업  개발  본부장님께 전달해 주세요',
    '아 차세대 클라우드 플랫폼 보안 기술 총괄 책임자 님께 전달하겠습니다',
    '어 해외 신규 서비스 운영 지원 담당 민수 씨에게 전달하겠습니다',
    '음 미래 기술 전략 연구 개발 담당 선생 님께서 확인하셨습니다',
    '음 회의 전략 연구 개발 담당 팀장님께 전달하겠습니다',
    '오늘 오늘 글로벌 사업 개발 본부장님께 전달하겠습니다',
    '회의 회의 글로벌 사업 개발 본부장님께 전달하겠습니다',
  ])('preserves a possible name throughout an unbroken noun phrase: %s', raw => {
    expect(createDictationEdits(raw)).toEqual([]);
    expect(polishReplyDictation(raw).body).toBe(`${raw}.`);
  });

  it.each([
    ['오늘 아니 내일 경영 지원 부문 대표님께 전달하겠습니다', '내일 경영 지원 부문 대표님께 전달하겠습니다.'],
    ['두 개 아니 세 개 글로벌 사업 개발 본부장님께 전달하겠습니다', '세 개 글로벌 사업 개발 본부장님께 전달하겠습니다.'],
    ['세 시 아니 네 시 글로벌 사업 개발 본부장님께 전달하겠습니다', '네 시 글로벌 사업 개발 본부장님께 전달하겠습니다.'],
  ])('permits validated slot corrections before honorifics: %s', (raw, expected) => {
    expect(polishReplyDictation(raw).body).toBe(expected);
    expect(validateDictationEdits(raw, createDictationEdits(raw))).toBe(expected);
  });

  it.each(longTitles)('rejects a directly submitted deletion before a long title: %s', raw => {
    expect(validateDictationEdits(raw, [{ start: 0, end: 2, kind: 'filler' }])).toBeNull();
  });

  it.each([
    ['오늘 오늘 글로벌 사업 개발 본부장님께 전달하겠습니다', 3, 'repeat'],
    ['음   글로벌 사업 개발 본부장님께 전달해 주세요', 4, 'filler'],
  ] as const)('also rejects submitted repeat/correction/space variants: %s', (raw, end, kind) => {
    expect(validateDictationEdits(raw, [{ start: 0, end, kind }])).toBeNull();
  });

  // Particle-looking suffixes never release prefix protection.
  it.each(['을', '를', '이', '가', '은', '는', '에', '에게', '에서', '로', '으로', '와', '과', '도', '만', '의', '까지', '부터'])
    ('keeps prefix content despite a case-particle-looking ending: %s', particle => {
      const raw = `어 자료${particle} 민수님께 보내겠습니다`;
      expect(polishReplyDictation(raw).body).toBe(`${raw}.`);
      expect(validateDictationEdits(raw, [{ start: 0, end: 2, kind: 'filler' }])).toBeNull();
    });

  it.each([
    ['어 오늘 자료를 정리해서 민수님께 보내겠습니다', '어 오늘 자료를 정리해서 민수님께 보내겠습니다.'],
    ['어 정리하고 민수님께 보내겠습니다', '어 정리하고 민수님께 보내겠습니다.'],
    ['어 정리하며 민수님께 보내겠습니다', '어 정리하며 민수님께 보내겠습니다.'],
    ['어 정리하면 민수님께 보내겠습니다', '어 정리하면 민수님께 보내겠습니다.'],
    ['어 정리합니다 민수님께 보내겠습니다', '어 정리합니다 민수님께 보내겠습니다.'],
    ['어 정리해요 민수님께 보내겠습니다', '어 정리해요 민수님께 보내겠습니다.'],
    ['어 오늘, 민수님께 보내겠습니다', '어 오늘, 민수님께 보내겠습니다.'],
    ['어 오늘. 민수님께 보내겠습니다', '어 오늘. 민수님께 보내겠습니다.'],
    ['어 오늘? 민수님께 보내겠습니다', '어 오늘? 민수님께 보내겠습니다'],
    ['어 오늘! 민수님께 보내겠습니다', '어 오늘! 민수님께 보내겠습니다.'],
    ['어 오늘 자료를 정리해서,민수님께 보내겠습니다', '어 오늘 자료를 정리해서,민수님께 보내겠습니다.'],
    ['어 오늘 자료를 정리해서  민수님께 보내겠습니다', '어 오늘 자료를 정리해서  민수님께 보내겠습니다.'],
  ])('preserves the prefix across clause boundaries: %s', (raw, expected) => {
    expect(polishReplyDictation(raw).body).toBe(expected);
  });
});
