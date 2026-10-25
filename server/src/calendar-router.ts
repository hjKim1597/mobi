import { dayBounds, MAX_EVENT_LOCATION_LENGTH, MAX_EVENT_TITLE_LENGTH, type TodayCalendar, type TodayEvent } from './calendar';
import { sanitizeTtsText } from './tts';

export type CalendarQuestionIntent = 'COUNT' | 'NEXT_TIME' | 'NEXT_TITLE' | 'NEXT_PLACE' | 'TODAY_SUMMARY';
export interface CalendarQuestionAnswer { intent: CalendarQuestionIntent; text: string; expiresAt: number }
export const ROUTER_MAX_SENTENCE_BYTES = 90;

const forms: ReadonlyArray<readonly [CalendarQuestionIntent, readonly string[]]> = [
  ['COUNT', ['오늘 일정 몇 개야', '오늘 일정 몇 개 있어', '오늘 일정 개수 알려줘']],
  ['NEXT_TIME', ['다음 일정 몇 시야', '다음 일정 언제야', '다음 일정 시간 알려줘']],
  ['NEXT_TITLE', ['다음 일정 뭐야', '다음 일정 알려줘', '다음 일정 이름 알려줘']],
  ['NEXT_PLACE', ['다음 일정 어디야', '다음 일정 장소 알려줘']],
  ['TODAY_SUMMARY', ['오늘 일정 뭐야', '오늘 일정 뭐 있어', '오늘 일정 알려줘', '오늘 일정 요약해줘']],
];
const NO_NEXT = '이후 시작할 일정은 없어요.';
const utf8Length = (value: string) => new TextEncoder().encode(value).length;

function normalizeTranscript(transcript: string): string {
  return transcript.normalize('NFKC').replace(/\s+/gu, ' ').trim().replace(/[.!?…。！？]+$/u, '').trim();
}

function intersectsDay(event: TodayEvent, date: string, dayStart: number, dayEnd: number): boolean {
  if (typeof event.id !== 'string' || !event.id) return false;
  if ('date' in event.start && 'date' in event.end) return event.start.date < nextDate(date) && event.end.date > date;
  if ('dateTime' in event.start && 'dateTime' in event.end) {
    const start = Date.parse(event.start.dateTime), end = Date.parse(event.end.dateTime);
    return Number.isFinite(start) && Number.isFinite(end) && end > start && start < dayEnd && end > dayStart;
  }
  return false;
}

function nextDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function timedStart(event: TodayEvent, dayStart: number, dayEnd: number, now: number): number | null {
  if (!('dateTime' in event.start)) return null;
  const value = Date.parse(event.start.dateTime);
  return Number.isFinite(value) && value > now && value >= dayStart && value < dayEnd ? value : null;
}

function uniqueIntersecting(events: TodayEvent[], date: string, dayStart: number, dayEnd: number): TodayEvent[] {
  const seen = new Set<string>(), result: TodayEvent[] = [];
  for (const event of events) {
    if (intersectsDay(event, date, dayStart, dayEnd) && !seen.has(event.id)) {
      seen.add(event.id);
      result.push(event);
    }
  }
  return result;
}

function safeCalendarText(value: string, maxLength: number): string | null {
  if (value.length > maxLength) return null;
  const normalized = value.normalize('NFKC').replace(/[\[\]()]/gu, ' ');
  if (!/^[\p{L}\p{N}\s,-]+$/u.test(normalized)) return null;
  const clean = sanitizeTtsText(normalized).trim();
  return clean && !/[.!?…]/u.test(clean) ? clean : null;
}

function copula(value: string): '이에요' | '예요' {
  const last = [...value].at(-1);
  if (!last) return '예요';
  const code = last.charCodeAt(0);
  return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0 ? '이에요' : '예요';
}

function singleSentence(value: string): boolean {
  return /[^.!?…]+[.!?…]$/u.test(value) && (value.match(/[.!?…]/gu)?.length ?? 0) === 1;
}

export function routeCalendarQuestion(transcript: string, calendar: TodayCalendar, now: Date): CalendarQuestionAnswer | null {
  const normalized = normalizeTranscript(transcript);
  const intent = forms.find(([, alternatives]) => alternatives.includes(normalized))?.[0];
  if (!intent || !Number.isFinite(now.getTime())) return null;

  let bounds: ReturnType<typeof dayBounds>;
  try { bounds = dayBounds(now, calendar.timeZone); } catch { return null; }
  if (calendar.date !== bounds.date || !Array.isArray(calendar.events)) return null;
  const dayStart = Date.parse(bounds.timeMin), dayEnd = Date.parse(bounds.timeMax), nowMs = now.getTime();
  const events = uniqueIntersecting(calendar.events, bounds.date, dayStart, dayEnd);
  const candidates = events.flatMap(event => {
    const start = timedStart(event, dayStart, dayEnd, nowMs);
    return start === null ? [] : [{ event, start }];
  }).sort((left, right) => left.start - right.start);
  const first = candidates[0];
  const tied = !!first && candidates.length > 1 && candidates[1].start === first.start;
  if (tied && intent !== 'COUNT') return null;
  const next = first && !tied ? first : null;
  let text: string;

  if ((intent === 'COUNT' || intent === 'TODAY_SUMMARY') && events.length === 0) text = '오늘 일정은 없어요.';
  else if (intent === 'COUNT') text = `오늘 일정은 ${events.length}개예요.`;
  else if (!next) {
    if (intent === 'TODAY_SUMMARY') {
      const summary = sanitizeTtsText(`오늘 ${events.length}개, 이후 시작할 일정은 없어요.`);
      text = utf8Length(summary) <= ROUTER_MAX_SENTENCE_BYTES ? summary : NO_NEXT;
    } else text = NO_NEXT;
  }
  else if (intent === 'NEXT_TIME' || intent === 'TODAY_SUMMARY') {
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: calendar.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(next.start);
    text = intent === 'NEXT_TIME'
      ? `다음 일정은 ${time}에 시작해요.`
      : `오늘 ${events.length}개, 다음은 ${time}${copula(sanitizeTtsText(time))}.`;
  } else if (intent === 'NEXT_TITLE') {
    const title = safeCalendarText(next.event.title, MAX_EVENT_TITLE_LENGTH);
    if (!title) return null;
    text = `다음 일정은 ${title}${copula(title)}.`;
  } else {
    if (next.event.location === undefined || !next.event.location.trim()) text = '다음 일정의 장소는 등록돼 있지 않아요.';
    else {
      const location = safeCalendarText(next.event.location, MAX_EVENT_LOCATION_LENGTH);
      if (!location) return null;
      text = `다음 일정 장소는 ${location}${copula(location)}.`;
    }
  }

  text = sanitizeTtsText(text);
  if (!text || utf8Length(text) > ROUTER_MAX_SENTENCE_BYTES || !singleSentence(text) || sanitizeTtsText(text) !== text) return null;
  return {
    intent,
    text,
    expiresAt: Math.min(nowMs + 30_000, dayEnd, first?.start ?? Number.POSITIVE_INFINITY),
  };
}
