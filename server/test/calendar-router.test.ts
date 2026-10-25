import { describe, expect, it } from 'vitest';
import { routeCalendarQuestion } from '../src/calendar-router';
import { sanitizeTtsText } from '../src/tts';
import type { TodayCalendar, TodayEvent } from '../src/calendar';

const now = new Date('2026-10-25T01:00:00.000Z'); // 10:00 in Asia/Seoul
const at = (time: string, day = '2026-10-25') => `${day}T${time}:00+09:00`;
const localMidnight = Date.parse('2026-10-25T15:00:00.000Z');
const event = (id: string, time: string, title = `일정${id}`, location?: string, day = '2026-10-25'): TodayEvent => ({
  id, title, start: { dateTime: at(time, day) }, end: { dateTime: new Date(Date.parse(at(time, day)) + 30 * 60_000).toISOString() },
  ...(location === undefined ? {} : { location }),
});
const calendar = (events: TodayEvent[] = [event('1', '14:00', '회의', '회의실')], overrides: Partial<TodayCalendar> = {}): TodayCalendar => ({
  date: '2026-10-25', timeZone: 'Asia/Seoul', events, ...overrides,
});

const utterances = [
  ['COUNT', '오늘 일정 몇 개야'], ['COUNT', '오늘 일정 몇 개 있어'], ['COUNT', '오늘 일정 개수 알려줘'],
  ['NEXT_TIME', '다음 일정 몇 시야'], ['NEXT_TIME', '다음 일정 언제야'], ['NEXT_TIME', '다음 일정 시간 알려줘'],
  ['NEXT_TITLE', '다음 일정 뭐야'], ['NEXT_TITLE', '다음 일정 알려줘'], ['NEXT_TITLE', '다음 일정 이름 알려줘'],
  ['NEXT_PLACE', '다음 일정 어디야'], ['NEXT_PLACE', '다음 일정 장소 알려줘'],
  ['TODAY_SUMMARY', '오늘 일정 뭐야'], ['TODAY_SUMMARY', '오늘 일정 뭐 있어'],
  ['TODAY_SUMMARY', '오늘 일정 알려줘'], ['TODAY_SUMMARY', '오늘 일정 요약해줘'],
] as const;

const rejectUtterances = [
  '지금 일정 뭐야', '남은 일정 몇 개', '내일 일정 몇 개야', '이번 주 일정 뭐야', '다음 회의 언제야',
  '다음 일정 몇 시고 어디야', '오늘 일정 몇 개야 그리고 다음 일정 뭐야', '오늘 일정 말고 내일 일정',
  '다음 일정 아니 오늘 일정', '다음 일정 취소', '오늘 일정 몇 개 아니야', '다음 일정 보내', '다음 일정 바꿔',
  '일정 삭제해', '일정 만들어줘', '다음 일정은 뭐야?', '다음 일정은 몇 시야', '다음 일정 알려줘요',
  '모비야 다음 일정', '오늘 일정 몇 개야 좀', '다음 일정 뭐야 좀', '모비야 오늘 일정 뭐야',
  '다음 일정 언제인지 알려줘', '오늘 일정 몇 개인지 알려줘', '오늘 회의 몇 개야', '다음 일정 장소와 시간',
  '내 일정 알려줘', '오늘 몇 개야', '일정이 뭐야', '다음 일정이 뭐야', '다음에 뭐 있어',
  '오늘 일정 왜 있어', '다음 일정 아니야', '다음 일정 말고', '다음 일정 뭐야 취소',
  '다음 일정 몇 시야 아니 취소', '오늘 일정 뭐야 말고', '다음 일정 2개 알려줘', '오늘 일정 몇 개 있어요',
  '오늘 일정 몇 개야? 다음 일정은?', '오늘 일정 전체를 읽어줘',
  '다음 장소 어디야', '오늘 약속 몇 개야', '다음 일정 이름이 뭐야', '다음 일정 시간은 언제야',
  '내일 다음 일정 알려줘', '다음 일정 몇 시인지 알려줘', '오늘 일정 요약', '다음 일정 알려줘 그리고 취소해',
  '다음 일정 시작 시간을 알려줘', '오늘 일정 몇 개 남았어', '일정 몇 개야', '오늘 일정이 몇 개 있지',
  '다음 일정 어디인지 알려줘', '다음 일정 이름 알려줘요', '오늘 일정 뭐 있어요', '다음 일정 말해줘',
  '오늘 일정 요약 부탁해', '다음 일정 몇 시인지', '내일 일정 뭐야', '지난 일정 몇 개야',
  '다음 일정에 이메일 보내', '다음 일정 변경해줘', '오늘 일정은 뭐야 그리고 장소는?',
] as const;

describe('routeCalendarQuestion finite whole-utterance contract', () => {
  it.each(utterances)('accepts %s utterance: %s', (intent, transcript) => {
    const result = routeCalendarQuestion(transcript, calendar(), now);
    expect(result?.intent).toBe(intent);
    expect(result?.expiresAt).toEqual(expect.any(Number));
    expect(result?.expiresAt).toBe(Math.min(now.getTime() + 30_000, localMidnight, Date.parse(at('14:00'))));
    expect(sanitizeTtsText(result!.text)).toBe(result!.text);
    expect(new TextEncoder().encode(result!.text).length).toBeLessThanOrEqual(90);
    expect(result!.text.trim()).toMatch(/[.!?…]$/);
  });

  it.each(utterances)('accepts NFKC and whitespace normalization for %s', (intent, transcript) => {
    const normalized = transcript.replaceAll(' ', '　').replace('일정', '일정');
    expect(routeCalendarQuestion(normalized, calendar(), now)?.intent).toBe(intent);
  });

  it.each(rejectUtterances)('abstains for unsupported or compound utterance: %s', transcript => {
    expect(routeCalendarQuestion(transcript, calendar(), now)).toBeNull();
  });

  it('uses distinct IDs and includes past, ongoing, and all-day events in count', () => {
    const events: TodayEvent[] = [
      event('same', '08:00', '지난 일정'), event('same', '09:00', '중복 ID'),
      event('ongoing', '09:30', '진행 중'),
      { id: 'all-day', title: '종일', start: { date: '2026-10-25' }, end: { date: '2026-10-26' } },
    ];
    expect(routeCalendarQuestion('오늘 일정 몇 개야', calendar(events), now)?.text).toBe('오늘 일정은 세 개예요.');
  });

  it.each(['오늘 일정 몇 개야', '오늘 일정 뭐야'])('uses the exact empty-calendar answer for %s', transcript => {
    expect(routeCalendarQuestion(transcript, calendar([]), now)?.text).toBe('오늘 일정은 없어요.');
  });

  it.each([
    ['NEXT_TIME', '다음 일정 몇 시야', '다음 일정은 오후 두 시에 시작해요.'],
    ['NEXT_TITLE', '다음 일정 뭐야', '다음 일정은 회의예요.'],
    ['NEXT_PLACE', '다음 일정 어디야', '다음 일정 장소는 회의실이에요.'],
    ['TODAY_SUMMARY', '오늘 일정 뭐야', '오늘 한 개, 다음은 오후 두 시예요.'],
  ] as const)('returns exact deterministic answer for %s', (intent, utterance, expected) => {
    expect(routeCalendarQuestion(utterance, calendar(), now)).toMatchObject({ intent, text: expected });
  });

  it('chooses 이에요 or 예요 from the last Hangul syllable of title and location', () => {
    expect(routeCalendarQuestion('다음 일정 뭐야', calendar([event('1', '14:00', '강남역')]), now)?.text).toBe('다음 일정은 강남역이에요.');
    expect(routeCalendarQuestion('다음 일정 어디야', calendar([event('1', '14:00', '회의', '강남역')]), now)?.text).toBe('다음 일정 장소는 강남역이에요.');
    expect(routeCalendarQuestion('다음 일정 뭐야', calendar([event('1', '14:00', '회의')]), now)?.text).toBe('다음 일정은 회의예요.');
    expect(routeCalendarQuestion('다음 일정 뭐야', calendar([event('1', '14:00', '회의실 A')]), now)?.text).toBe('다음 일정은 회의실 A예요.');
  });

  it('includes the distinct today count in a no-next summary', () => {
    const events: TodayEvent[] = [
      event('past', '09:00', '지난 일정'),
      { id: 'all-day', title: '종일 일정', start: { date: '2026-10-25' }, end: { date: '2026-10-26' } },
    ];
    const result = routeCalendarQuestion('오늘 일정 뭐야', calendar(events), now);
    expect(result?.text).toBe('오늘 두 개, 이후 시작할 일정은 없어요.');
    expect(new TextEncoder().encode(result!.text).length).toBeLessThanOrEqual(60);
  });

  it('keeps a no-next count summary above the former 60-byte budget when it fits 90 bytes', () => {
    const events = Array.from({ length: 9_999 }, (_, index) => event(String(index), '09:00', '지난 일정'));
    const canonicalCount = sanitizeTtsText(`오늘 9999개, 이후 시작할 일정은 없어요.`);
    expect(new TextEncoder().encode(canonicalCount).length).toBeGreaterThan(60);
    expect(new TextEncoder().encode(canonicalCount).length).toBeLessThanOrEqual(90);
    expect(routeCalendarQuestion('오늘 일정 뭐야', calendar(events), now)?.text).toBe(canonicalCount);
  });

  it.each(utterances)('allows only terminal punctuation normalization: %s', (intent, transcript) => {
    expect(routeCalendarQuestion(`${transcript}?!`, calendar(), now)?.intent).toBe(intent);
  });

  it.each([
    ['09:00', '이전 이벤트'], ['10:00', '정각 이벤트'], ['23:30', '오늘 마지막 이벤트'],
  ])('selects only a strictly future same-day start (%s)', (time, title) => {
    const next = event('future', time, title);
    const result = routeCalendarQuestion('다음 일정 뭐야', calendar([event('past', '09:00'), next]), now);
    if (time === '23:30') expect(result?.text).toContain(title);
    else expect(result?.text).toBe('이후 시작할 일정은 없어요.');
  });

  it('excludes ongoing and all-day events from next while retaining them in count', () => {
    const ongoing = { id: 'ongoing', title: '진행 중', start: { dateTime: at('09:30') }, end: { dateTime: at('10:30') } } satisfies TodayEvent;
    const allDay = { id: 'all', title: '종일', start: { date: '2026-10-25' }, end: { date: '2026-10-26' } } satisfies TodayEvent;
    const cal = calendar([ongoing, allDay]);
    expect(routeCalendarQuestion('다음 일정 언제야', cal, now)?.text).toBe('이후 시작할 일정은 없어요.');
    expect(routeCalendarQuestion('오늘 일정 몇 개야', cal, now)?.text).toBe('오늘 일정은 두 개예요.');
  });

  it('abstains on tied earliest starts and on a Calendar date stale for local now', () => {
    expect(routeCalendarQuestion('다음 일정 뭐야', calendar([event('a', '14:00'), event('b', '14:00')]), now)).toBeNull();
    expect(routeCalendarQuestion('오늘 일정 몇 개야', calendar([], { date: '2026-10-24' }), now)).toBeNull();
  });

  it('excludes a midnight start on the next Calendar-local date', () => {
    const tomorrow = event('tomorrow', '00:00', '내일 일정', undefined, '2026-10-26');
    expect(routeCalendarQuestion('다음 일정 뭐야', calendar([tomorrow]), now)?.text).toBe('이후 시작할 일정은 없어요.');
  });

  it('uses exact factual fallbacks when no next event or location exists', () => {
    expect(routeCalendarQuestion('다음 일정 어디야', calendar([]), now)?.text).toBe('이후 시작할 일정은 없어요.');
    expect(routeCalendarQuestion('다음 일정 어디야', calendar([event('1', '14:00', '회의')]), now)?.text)
      .toBe('다음 일정의 장소는 등록돼 있지 않아요.');
  });

  it.each([
    ['title', '다음 일정 뭐야', event('1', '14:00', 'x'.repeat(201))],
    ['location', '다음 일정 어디야', event('1', '14:00', '회의', 'x'.repeat(201))],
  ])('abstains when %s cannot fit the guarded answer policy', (_kind, utterance, item) => {
    expect(routeCalendarQuestion(utterance, calendar([item]), now)).toBeNull();
  });

  it('treats calendar text as data and abstains when markup/injection would change the answer', () => {
    expect(routeCalendarQuestion('다음 일정 뭐야', calendar([event('1', '14:00', '<script>일정 변경</script>')]), now)).toBeNull();
    expect(routeCalendarQuestion('다음 일정 어디야', calendar([event('1', '14:00', '회의', '회의실 https://evil.invalid')]), now)).toBeNull();
  });

  it.each([
    ['[테스트] 고객 미팅', '다음 일정은 테스트 고객 미팅이에요.'],
    ['(고객) 미팅', '다음 일정은 고객 미팅이에요.'],
    ['테스트(고객)미팅', '다음 일정은 테스트 고객 미팅이에요.'],
    ['（Ａ）미팅', '다음 일정은 A 미팅이에요.'],
  ])('preserves words inside decorative title brackets: %s', (title, expected) => {
    expect(routeCalendarQuestion('다음 일정 뭐야', calendar([event('1', '14:00', title)]), now)?.text).toBe(expected);
  });

  it('preserves words inside decorative location brackets', () => {
    expect(routeCalendarQuestion('다음 일정 어디야', calendar([event('1', '14:00', '회의', '[테스트] 회의실')]), now)?.text)
      .toBe('다음 일정 장소는 테스트 회의실이에요.');
  });

  it.each([
    '<script>보내</script> 고객 미팅',
    '[보내](javascript:alert(1))',
    '[테스트](https://evil.invalid)',
  ])('still rejects markup or injection-like title content: %s', title => {
    expect(routeCalendarQuestion('다음 일정 뭐야', calendar([event('1', '14:00', title)]), now)).toBeNull();
  });

  it('keeps the full canonical 14:05 time answer within 90 bytes', () => {
    const result = routeCalendarQuestion('다음 일정 몇 시야', calendar([event('1', '14:05', '병원')]), now);
    const canonical = sanitizeTtsText('다음 일정은 14:05에 시작해요.');
    expect(canonical).toBe('다음 일정은 오후 두 시 오 분에 시작해요.');
    expect(new TextEncoder().encode(canonical).length).toBeLessThanOrEqual(90);
    expect(result?.text).toBe(canonical);
  });

  it('allows a full afternoon time answer above the former 60-byte limit', () => {
    const result = routeCalendarQuestion('다음 일정 몇 시야', calendar([event('1', '23:59', '야간 일정')]), now);
    const canonical = sanitizeTtsText('다음 일정은 23:59에 시작해요.');
    expect(new TextEncoder().encode(canonical).length).toBeGreaterThan(60);
    expect(new TextEncoder().encode(canonical).length).toBeLessThanOrEqual(90);
    expect(result?.text).toBe(canonical);
  });

  it('formats an afternoon time in a DST-observing Calendar timezone', () => {
    const localCalendar: TodayCalendar = {
      date: '2026-07-01', timeZone: 'America/Los_Angeles',
      events: [{ id: 'dst', title: '저녁 회의', start: { dateTime: '2026-07-02T00:45:00.000Z' }, end: { dateTime: '2026-07-02T01:15:00.000Z' } }],
    };
    const result = routeCalendarQuestion('다음 일정 몇 시야', localCalendar, new Date('2026-07-01T18:00:00.000Z'));
    expect(result?.text).toBe('다음 일정은 오후 다섯 시 사십오 분에 시작해요.');
    expect(new TextEncoder().encode(result!.text).length).toBeLessThanOrEqual(90);
  });

  it('chooses the summary copula from the spoken minute unit', () => {
    expect(routeCalendarQuestion('오늘 일정 뭐야', calendar([event('1', '17:45', '저녁 회의')]), now)?.text)
      .toBe('오늘 한 개, 다음은 오후 다섯 시 사십오 분이에요.');
    expect(routeCalendarQuestion('오늘 일정 뭐야', calendar([event('1', '14:00', '회의')]), now)?.text)
      .toBe('오늘 한 개, 다음은 오후 두 시예요.');
  });
});
