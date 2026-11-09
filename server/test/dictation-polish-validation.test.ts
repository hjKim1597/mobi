import { describe, expect, it } from 'vitest';
import { createDictationEdits, polishReplyDictation, validateDictationEdits } from '../src/dictation-polish';

describe('server-enforced dictation span validation', () => {
  it.each([
    ['내일 아니 모레 갈게요', '모레 갈게요.'],
    ['두 개 아니 세 개 준비하겠습니다', '세 개 준비하겠습니다.'],
  ])('excludes only a grammar-validated correction span from the length floor: %s', (raw, expected) => {
    expect(polishReplyDictation(raw)).toMatchObject({ body: expected, reason: 'applied' });
  });
  it.each(['어 음 아 내일 아니 모레 갈게요', '내일 내일 내일 내일 내일 아니 모레 갈게요'])('still counts filler/repeat deletions fully against the floor: %s', raw => {
    const edits = createDictationEdits(raw);
    expect(edits.some(edit => edit.kind === 'correction')).toBe(true);
    expect(edits.length).toBeLessThanOrEqual(6);
    expect(validateDictationEdits(raw, edits)).toBeNull();
    expect(polishReplyDictation(raw)).toMatchObject({ body: raw, reason: 'raw_kept' });
  });
  it('accepts only original, ordered, allowlisted deletion spans', () => {
    const raw = '어 내일 오후 세 시에 자료를 보내겠습니다';
    expect(validateDictationEdits(raw, createDictationEdits(raw))).toBe('내일 오후 세 시에 자료를 보내겠습니다.');
    expect(validateDictationEdits(raw, [{ start: 2, end: 5, kind: 'filler' }])).toBeNull();
    expect(validateDictationEdits(raw, [{ start: -1, end: 2, kind: 'filler' }])).toBeNull();
    expect(validateDictationEdits(raw, [{ start: 0, end: 2, kind: 'filler' }, { start: 0, end: 2, kind: 'filler' }])).toBeNull();
    expect(validateDictationEdits(raw, [{ start: 0.5, end: 2, kind: 'filler' }])).toBeNull();
  });
  it('cannot use a named edit kind to remove protected content, numbers or names', () => {
    for (const raw of ['가능하면 내일 보내겠습니다', '민수 님께 전달하겠습니다', '내일 세 시에 뵙겠습니다', '내일은 참석하지 못할 것 같아요']) {
      expect(validateDictationEdits(raw, [{ start: 0, end: 4, kind: 'correction' }])).toBeNull();
    }
  });
  it('rejects reordered spans and changes that exceed the deletion ratio', () => {
    const raw = '어 내일 내일 자료를 보내겠습니다';
    const edits = createDictationEdits(raw);
    expect(edits.length).toBeGreaterThan(1);
    expect(validateDictationEdits(raw, [...edits].reverse())).toBeNull();
    expect(polishReplyDictation('어 음 아 내일 갑니다')).toMatchObject({ body: '어 음 아 내일 갑니다', reason: 'raw_kept' });
  });
  it('never rescues an unsafe raw body or truncates to 120 code points', () => {
    for (const raw of ['어 A01로 진행하겠습니다', '어 01012345678로 보내 주세요', '어 ' + '가'.repeat(119), '자료\t보내겠습니다', '어 자료🙂 보내겠습니다']) {
      expect(polishReplyDictation(raw)).toMatchObject({ body: raw, reason: 'raw_invalid' });
      expect(validateDictationEdits(raw, [])).toBeNull();
    }
  });
  it('falls back atomically when optional punctuation breaches policy or length', () => {
    const raw = '어 ' + '가'.repeat(115) + '갑니다';
    expect([...raw]).toHaveLength(120);
    expect(polishReplyDictation(raw).body.length).toBeLessThanOrEqual(120);
    const full = '가'.repeat(117) + '갑니다';
    expect(polishReplyDictation(full)).toMatchObject({ body: full, reason: 'raw_kept' });
  });
  it('keeps terminal punctuation, quoted content, names and ambiguous questions', () => {
    for (const raw of ['어 내일 가나요', "'어 내일 내일 보내겠습니다'라고 말했습니다", '민수 민수 님께 전달하겠습니다', '3명 3명 참석합니다', '자료를 보낼까요?', '내일 가요']) {
      const result = polishReplyDictation(raw);
      if (raw.startsWith('어 ')) expect(result.body).toBe('내일 가나요');
      else expect(result.body.replace(/\.$/, '')).toBe(raw.replace(/\.$/, ''));
    }
  });
  it('keeps filler-looking or repeated words when an adjacent honorific makes them possible names', () => {
    for (const raw of ['아 님께 전달하겠습니다', '음 씨에게 전달하겠습니다', '어 팀장님께 전달하겠습니다', '아 아 님께 전달하겠습니다', '내일 내일 님께 전달하겠습니다', '내일 내일 내일 님께 전달하겠습니다']) {
      expect(polishReplyDictation(raw).body).toBe(`${raw}.`);
    }
    expect(polishReplyDictation('회의는 오늘 아니 내일 님께 전달하겠습니다').body).toBe('회의는 내일 님께 전달하겠습니다.');
  });
});
