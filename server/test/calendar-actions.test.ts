import { afterEach, describe, expect, it, vi } from 'vitest';
import { calendarEventId, calendarReadback, insertCalendarEvent, resolveCalendarRequest, type CalendarPayload } from '../src/calendar-actions';
import { isSafeReplyBody, sanitizeTtsText } from '../src/tts';

const NOW = Date.parse('2026-10-24T01:00:00Z');
const payload: CalendarPayload = { kind: 'calendar_insert', title: '회의', start: '2026-10-25T14:00:00+09:00', end: '2026-10-25T14:30:00+09:00', timeZone: 'Asia/Seoul', eventId: 'mobiabc', defaultDuration: true };
afterEach(() => vi.unstubAllGlobals());

describe('calendar action resolution', () => {
  it.each([
    '11월 10일 오후 네 시에 팀 회의가 잡혔습니다.',
    '11월 10일 오후 네 시에 메일로 회의 안내를 드립니다.',
  ])('uses the supplied mail title without deriving a title from body leftovers: %s', body => {
    expect(resolveCalendarRequest(body, 'Asia/Seoul', Date.parse('2026-11-08T00:00:00Z'), undefined, '회의 일정 안내')).toEqual({
      status: 'awaiting_approval', payload: {
        title: '회의 일정 안내', start: '2026-11-10T16:00:00+09:00', end: '2026-11-10T16:30:00+09:00',
        timeZone: 'Asia/Seoul', defaultDuration: true,
      },
    });
  });
  it.each([
    ['2026-11-10T15:00:00+09:00', '2026-11-10T15:30:00+09:00', '팀 회의', 'Asia/Seoul', '11월 10일 오후 세 시부터 세 시 반까지 \'팀 회의\' 일정을 내 캘린더에 추가할게요. 추가하려면 \'추가해\'라고 말씀해 주세요.', '십일월 십일 오후 세 시부터 세 시 반까지 \'팀 회의\' 일정을 내 캘린더에 추가할게요. 추가하려면 \'추가해\'라고 말씀해 주세요.'],
    ['2026-11-10T10:00:00+09:00', '2026-11-10T10:30:00+09:00', '회의 일정 안내', 'Asia/Seoul', '11월 10일 오전 열 시부터 열 시 반까지 \'회의 일정 안내\' 일정을 내 캘린더에 추가할게요. 추가하려면 \'추가해\'라고 말씀해 주세요.', '십일월 십일 오전 열 시부터 열 시 반까지 \'회의 일정 안내\' 일정을 내 캘린더에 추가할게요. 추가하려면 \'추가해\'라고 말씀해 주세요.'],
    ['2026-11-10T10:15:00+09:00', '2026-11-10T11:00:00+09:00', '팀 회의', 'Asia/Seoul', '11월 10일 오전 열 시 십오 분부터 열한 시까지 \'팀 회의\' 일정을 내 캘린더에 추가할게요. 추가하려면 \'추가해\'라고 말씀해 주세요.', '십일월 십일 오전 열 시 십오 분부터 열한 시까지 \'팀 회의\' 일정을 내 캘린더에 추가할게요. 추가하려면 \'추가해\'라고 말씀해 주세요.'],
    ['2026-11-10T23:30:00+09:00', '2026-11-11T00:30:00+09:00', '팀 회의', 'Asia/Seoul', '11월 10일 오후 열한 시 반부터 11월 11일 오전 열두 시 반까지 \'팀 회의\' 일정을 내 캘린더에 추가할게요. 추가하려면 \'추가해\'라고 말씀해 주세요.', '십일월 십일 오후 열한 시 반부터 십일월 십일일 오전 열두 시 반까지 \'팀 회의\' 일정을 내 캘린더에 추가할게요. 추가하려면 \'추가해\'라고 말씀해 주세요.'],
    ['2027-01-10T15:00:00+09:00', '2027-01-10T15:30:00+09:00', '팀 회의', 'Asia/Seoul', '2027년 1월 10일 오후 세 시부터 세 시 반까지 \'팀 회의\' 일정을 내 캘린더에 추가할게요. 추가하려면 \'추가해\'라고 말씀해 주세요.', '이천이십칠년 일월 십일 오후 세 시부터 세 시 반까지 \'팀 회의\' 일정을 내 캘린더에 추가할게요. 추가하려면 \'추가해\'라고 말씀해 주세요.'],
  ])('creates natural calendar readback for %s', (start, end, title, zone, expected, spoken) => {
    const full = calendarReadback({ ...payload, start, end, title, timeZone: zone }, NOW);
    expect(full).toBe(expected);
    expect(sanitizeTtsText(full, 'reply_readback')).toBe(spoken);
  });
  it('keeps the date at each endpoint when the calendar timezone is not Seoul', () => {
    const full = calendarReadback({ ...payload, start: '2026-11-10T10:00:00-05:00', end: '2026-11-10T10:30:00-05:00', timeZone: 'America/New_York' }, NOW);
    expect(full).toContain('11월 10일 오전 열 시부터 열 시 반까지');
    expect(full).toContain('America 슬래시 New 밑줄 York 시간대');
    expect(sanitizeTtsText(full, 'reply_readback')).toContain('십일월 십일 오전 열 시부터 열 시 반까지');
  });
  it('compares event year with the current year in the calendar timezone', () => {
    const now = Date.parse('2026-12-31T16:00:00Z'); // 2027 in Seoul, still 2026 in UTC
    const readback = calendarReadback({ ...payload, start: '2027-01-02T15:00:00+09:00', end: '2027-01-02T15:30:00+09:00' }, now);
    expect(readback).toContain('1월 2일 오후 세 시부터 세 시 반까지');
    expect(readback).not.toContain('2027년');
  });
  it.each([
    ['내일 오후 두 시 무비 테스트 일정 추가해', '무비 테스트'],
    ['내일 오후 두 시 무비 테스트 일정을 추가해줘!', '무비 테스트'],
    ['내일 오후 두 시 일정 조율 회의 추가해', '일정 조율 회의'],
  ])('cleans only a trailing command noun from calendar title: %s', (text, title) => {
    expect(resolveCalendarRequest(text, 'Asia/Seoul', NOW)).toMatchObject({ status: 'awaiting_approval', payload: { title } });
  });
  it.each([
    ['2026년', '이천이십육년'], ['3명', '삼명'], ['10시', '십시'],
  ])('keeps every character except digit-run pronunciation in calendar title readback: %s', (title, spokenTitle) => {
    expect(isSafeReplyBody(title)).toBe(true);
    const readback = calendarReadback({ ...payload, title });
    expect(sanitizeTtsText(readback, 'reply_readback')).toBe(`십월 이십오일 오후 두 시부터 두 시 반까지 '${spokenTitle}' 일정을 내 캘린더에 추가할게요. 추가하려면 '추가해'라고 말씀해 주세요.`);
  });
  it('asks a single clarification for missing date or AM/PM, then resolves absolute details', () => {
    const first = resolveCalendarRequest('두 시 회의 추가해', 'Asia/Seoul', NOW);
    expect(first.status).toBe('needs_clarification');
    expect(resolveCalendarRequest('두 시 회의 추가해', 'Asia/Seoul', NOW, '내일 오후')).toMatchObject({ status: 'awaiting_approval', payload: { title: '회의', timeZone: 'Asia/Seoul' } });
  });
  it('uses an explicit 30 minute default in readback when no end is given', () => {
    const result = resolveCalendarRequest('내일 오후 두 시 회의 추가해', 'Asia/Seoul', NOW);
    expect(result.status).toBe('awaiting_approval');
    if (result.status === 'awaiting_approval') {
      const readback = calendarReadback({ ...result.payload, kind: 'calendar_insert', eventId: 'mobiabc', defaultDuration: true });
      expect(readback).toContain('두 시 반까지');
      expect(readback).not.toContain('삼십 분 일정으로');
      expect(readback).not.toContain('Asia 슬래시 Seoul');
    }
  });
  it('preserves meaningful title words and honors an explicit end time', () => {
    const result = resolveCalendarRequest('내일 오후 두 시부터 오후 네 시까지 팀 회의 추가해', 'Asia/Seoul', NOW);
    expect(result).toMatchObject({ status: 'awaiting_approval', payload: { title: '팀 회의', start: '2026-10-25T14:00:00+09:00', end: '2026-10-25T16:00:00+09:00', defaultDuration: false } });
  });
  it('inherits an unambiguous afternoon from the start for a bare Korean end hour', () => {
    expect(resolveCalendarRequest('내일 오후 두 시부터 세 시까지 팀 회의 추가해', 'Asia/Seoul', NOW)).toMatchObject({
      status: 'awaiting_approval', payload: { start: '2026-10-25T14:00:00+09:00', end: '2026-10-25T15:00:00+09:00', defaultDuration: false },
    });
  });
  it('does not infer the start period from an explicit end period', () => {
    expect(resolveCalendarRequest('내일 두 시부터 오후 세 시까지 팀 회의 추가해', 'Asia/Seoul', NOW)).toMatchObject({
      status: 'needs_clarification', reasonCode: 'ambiguous_time',
    });
  });
  it.each([
    ['내일 오전 두 시부터 세 시까지 회의', '2026-10-25T02:00:00+09:00', '2026-10-25T03:00:00+09:00'],
    ['내일 오후 두 시부터 오후 세 시까지 회의', '2026-10-25T14:00:00+09:00', '2026-10-25T15:00:00+09:00'],
    ['내일 오후 두 시부터 ~ 15:00 회의', '2026-10-25T14:00:00+09:00', '2026-10-25T15:00:00+09:00'],
    ['내일 오후 두 시 - 세 시 회의', '2026-10-25T14:00:00+09:00', '2026-10-25T15:00:00+09:00'],
  ])('honors explicit end syntax: %s', (text, start, end) => {
    expect(resolveCalendarRequest(text, 'Asia/Seoul', NOW)).toMatchObject({
      status: 'awaiting_approval', payload: { start: `${start.slice(0, 16)}:00+09:00`, end: `${end.slice(0, 16)}:00+09:00`, defaultDuration: false },
    });
  });
  it('does not apply the default when an explicit end is truncated or ambiguous', () => {
    expect(resolveCalendarRequest('내일 오후 두 시부터 시까지 회의', 'Asia/Seoul', NOW)).toMatchObject({ status: 'needs_clarification', reasonCode: 'explicit_end_unresolved' });
    expect(resolveCalendarRequest('내일 오후 두 시 ~ 회의', 'Asia/Seoul', NOW)).toMatchObject({ status: 'needs_clarification', reasonCode: 'explicit_end_unresolved' });
    expect(resolveCalendarRequest('내일 오후 두 시부터 시까지 회의', 'Asia/Seoul', NOW, '다섯 시')).toMatchObject({
      status: 'awaiting_approval', payload: { start: '2026-10-25T14:00:00+09:00', end: '2026-10-25T17:00:00+09:00', defaultDuration: false },
    });
  });
  it('does not treat ISO date hyphens as a time range separator', () => {
    expect(resolveCalendarRequest('2026-10-26T14:00 팀 회의 추가해', 'Asia/Seoul', NOW)).toMatchObject({
      status: 'awaiting_approval', payload: { start: '2026-10-26T14:00:00+09:00', end: '2026-10-26T14:30:00+09:00', defaultDuration: true },
    });
  });
  it('distinguishes an adjacent numeric time-range hyphen from ISO date hyphens', () => {
    expect(resolveCalendarRequest('2026-10-26T14:00-15:00 팀 회의 추가해', 'Asia/Seoul', NOW)).toMatchObject({
      status: 'awaiting_approval', payload: { title: '팀 회의', start: '2026-10-26T14:00:00+09:00', end: '2026-10-26T15:00:00+09:00', defaultDuration: false },
    });
  });
  it.each([
    ['내일 오후 두 시부터 세 시 30분까지 팀 회의 추가해', '2026-10-25T14:00:00+09:00', '2026-10-25T15:30:00+09:00'],
    ['내일 오후 두 시부터 세 시 반까지 팀 회의 추가해', '2026-10-25T14:00:00+09:00', '2026-10-25T15:30:00+09:00'],
    ['내일 14:00-15:00 팀 회의 추가해', '2026-10-25T14:00:00+09:00', '2026-10-25T15:00:00+09:00'],
    ['2026-11-10 14:00 팀 회의 추가해', '2026-11-10T14:00:00+09:00', '2026-11-10T14:30:00+09:00'],
  ])('parses bounded time endpoints: %s', (text, start, end) => {
    expect(resolveCalendarRequest(text, 'Asia/Seoul', NOW)).toMatchObject({
      status: 'awaiting_approval', payload: { title: '팀 회의', start, end },
    });
  });
  it('does not move unsupported time-like text into the title', () => {
    expect(resolveCalendarRequest('내일 오후 두 시 십오 분 회의 추가해', 'Asia/Seoul', NOW)).toMatchObject({
      status: 'needs_clarification', reasonCode: 'unsupported_time',
    });
    expect(resolveCalendarRequest('내일 오후 두 시 십오 분 회의 추가해', 'Asia/Seoul', NOW, '내일 오후')).toMatchObject({
      status: 'rejected', reasonCode: 'unclear_after_clarification',
    });
  });
  it.each([
    '오늘 아니 내일 오후 두 시 회의 추가해',
    '2026년 11월 10일 또는 11월 11일 오후 두 시 회의 추가해',
  ])('does not choose one of conflicting dates: %s', text => {
    expect(resolveCalendarRequest(text, 'Asia/Seoul', NOW)).toMatchObject({ status: 'needs_clarification', reasonCode: 'conflicting_date' });
    expect(resolveCalendarRequest(text, 'Asia/Seoul', NOW, '11월 12일')).toMatchObject({ status: 'rejected', reasonCode: 'unclear_after_clarification' });
  });
  it.each([
    '내일 오후 두 시 30반 회의 추가해',
    '내일 오후 두 시 30 회의 추가해',
    '내일 오후 두 시 삼십 분 회의 추가해',
    '내일 오후 두 시 삼십오 분 회의 추가해',
    '내일 오후 두 시 십오분 회의 추가해',
    '2026-11-10 14:00:30 팀 회의 추가해',
    '내일 오후 두 시부터 세 시까지 네 시 팀 회의 추가해',
    '내일 오후 오전 두 시 회의 추가해',
    '내일 오후 두 시 세 시 팀 회의 추가해',
    '내일 오후 두 시 세 시까지 팀 회의 추가해',
    '내일 오후 02:00 팀 회의 추가해',
    '내일 오전 12:00 팀 회의 추가해',
  ])('clarifies malformed clock fragments instead of accepting a prefix: %s', text => {
    expect(resolveCalendarRequest(text, 'Asia/Seoul', NOW)).toMatchObject({ status: 'needs_clarification', reasonCode: 'unsupported_time' });
    expect(resolveCalendarRequest(text, 'Asia/Seoul', NOW, '내일 오후 두 시')).toMatchObject({ status: 'rejected', reasonCode: 'unclear_after_clarification' });
  });
  it('uses the current calendar-local year for a month/day without a year', () => {
    expect(resolveCalendarRequest('11월 10일 오후 두 시 회의', 'Asia/Seoul', NOW)).toMatchObject({
      status: 'awaiting_approval', payload: { title: '회의', start: '2026-11-10T14:00:00+09:00' },
    });
    expect(resolveCalendarRequest('오후 두 시 회의', 'Asia/Seoul', NOW, '11월 10일')).toMatchObject({
      status: 'awaiting_approval', payload: { start: '2026-11-10T14:00:00+09:00' },
    });
  });
  it('accepts only the existing explicit half-hour duration phrase', () => {
    expect(resolveCalendarRequest('내일 오후 두 시 반 시간 회의', 'Asia/Seoul', NOW)).toMatchObject({ status: 'awaiting_approval', payload: { start: '2026-10-25T14:00:00+09:00', end: '2026-10-25T14:30:00+09:00', defaultDuration: false } });
  });
  it.each(['2026-03-08T02:30', '2026-11-01T01:30'])('rejects nonexistent or repeated local time %s', local => {
    expect(resolveCalendarRequest(`${local} 일정`, 'America/New_York', NOW).status).toBe('rejected');
  });
  it('rejects invalid zone and past requests', () => {
    expect(resolveCalendarRequest('내일 오후 두 시 회의', 'Mars/Olympus', NOW).status).toBe('rejected');
    expect(resolveCalendarRequest('2026년 10월 23일 오후 두 시 회의', 'Asia/Seoul', NOW).status).toBe('rejected');
  });
  it('derives stable Calendar-compatible IDs', async () => {
    const id = await calendarEventId('device:epoch:action');
    expect(id).toMatch(/^mobi[0-9a-f]{64}$/);
    expect(await calendarEventId('device:epoch:action')).toBe(id);
  });
});

describe('calendar insert reconciliation', () => {
  it('inserts once and sends no attendees, reminders or updates', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await insertCalendarEvent('token', payload, new AbortController().signal)).toBe('succeeded');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.searchParams.get('sendUpdates')).toBe('none');
    expect(url.pathname).toBe('/calendar/v3/calendars/primary/events');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ id: 'mobiabc', reminders: { useDefault: false, overrides: [] } });
    expect(body).not.toHaveProperty('attendees');
  });
  it('reconciles a conflict by fetching and comparing the same event', async () => {
    let inserted: Record<string, any> | undefined;
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === 'POST') { inserted = JSON.parse(String(init.body)); return new Response('{}', { status: 409 }); }
      return new Response(JSON.stringify(inserted), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    expect(await insertCalendarEvent('token', payload, new AbortController().signal)).toBe('succeeded');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('retries a missing event sequentially at most once with the identical body', async () => {
    const bodies: string[] = [];
    const fetch = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === 'POST') { bodies.push(String(init.body)); return new Response('{}', { status: 503 }); }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetch);
    expect(await insertCalendarEvent('token', payload, new AbortController().signal)).toBe('unknown');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('checks the event again after the final retryable insert response', async () => {
    let inserted: Record<string, any> | undefined;
    const bodies: string[] = [];
    let getCount = 0;
    const fetch = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === 'POST') { inserted = JSON.parse(String(init.body)); bodies.push(String(init.body)); return new Response('{}', { status: 503 }); }
      if (++getCount === 1) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(inserted), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    expect(await insertCalendarEvent('token', payload, new AbortController().signal)).toBe('succeeded');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('fails closed when the same event id exists with different content', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: payload.eventId, summary: '다른 일정' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await insertCalendarEvent('token', payload, new AbortController().signal)).toBe('failed');
  });
});
