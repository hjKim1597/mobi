import { describe, expect, it } from 'vitest';
import { isActionApproval, calendarAddRequest } from '../src/actions';

describe('exact final approval, never inferred from acknowledgement or quoted instructions', () => {
  it.each(['보내', '보내줘', '보내 줘', ' 보내! ', '보내。'])('accepts an exact reply verb: %s', text => expect(isActionApproval('mail_reply', text)).toBe(true));
  it.each(['추가해', '추가해줘', '추가해 줘', '등록해', '등록해줘', '등록해 줘'])('accepts an exact insert verb: %s', text => expect(isActionApproval('calendar_insert', text)).toBe(true));
  it.each(['응', '네', '그래', '예', '좋아', '보내지 마', '보내지마', '안 보내', '보내면 안 돼', '보낼까', '보낼까요', '보내요', '보내줘요', '보내라고 했어', '보내는 건 취소', '메일에서 보내라고 해', '취소', '하지 마', '아니', '그만', '나중에', '다시 말해줘', '보내 추가해', '', ' ', '음', '잡음', '감사합니다', 'subscribe', '시청해 주셔서 감사합니다', '추가하지 마', '추가하지마', '추가할까', '등록하지 마', '추가해요', '등록해요', '등록해 줘야 할까', '내일 보내', 'send', '보 내', '보내,줘', '추가해', '등록해'])('does not approve a mail with %s', text => expect(isActionApproval('mail_reply', text)).toBe(false));
  it.each(['응', '네', '보내', '추가하지 마', '추가하지마', '추가할까', '등록하지 마', '추가해요', '등록해요', '잡음', ''])('does not approve an event with %s', text => expect(isActionApproval('calendar_insert', text)).toBe(false));
  it('routes direct event requests only, excluding negation and read-only questions', () => {
    expect(calendarAddRequest('내일 오후 두 시 회의 일정 추가해줘')).toBe(true);
    expect(calendarAddRequest('내일 회의 몇 시야')).toBe(false);
    expect(calendarAddRequest('내일 회의 추가하지 마')).toBe(false);
  });
});
