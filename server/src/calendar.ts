import { GoogleError, GooglePayloadTooLarge, googleJson } from './google';

export const MAX_TODAY_EVENTS = 200;
export const MAX_TODAY_PAGES = 5;
export const MAX_PAGE_TOKEN_LENGTH = 1024;
export const MAX_EVENT_ID_LENGTH = 256;
export const MAX_EVENT_TITLE_LENGTH = 200;
export const MAX_EVENT_LOCATION_LENGTH = 200;

export type EventBoundary = { date: string } | { dateTime: string };
export interface TodayEvent {
  id: string;
  title: string;
  start: EventBoundary;
  end: EventBoundary;
  location?: string;
}
export interface TodayCalendar {
  date: string;
  timeZone: string;
  events: TodayEvent[];
}
export interface DayBounds {
  date: string;
  timeMin: string;
  timeMax: string;
}

function dateAt(instant: number, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(instant);
  const get = (type: string) => parts.find(part => part.type === type)?.value;
  const year = get('year'); const month = get('month'); const day = get('day');
  if (!year || !month || !day) throw new GoogleError('upstream');
  return `${year}-${month}-${day}`;
}

function nextDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function firstInstantOfDate(date: string, formatter: Intl.DateTimeFormat): number {
  const target = Date.parse(`${date}T00:00:00.000Z`);
  let low = target - 48 * 60 * 60 * 1000;
  let high = target + 48 * 60 * 60 * 1000;
  if (dateAt(low, formatter) >= date || dateAt(high, formatter) < date) throw new GoogleError('upstream');
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (dateAt(middle, formatter) < date) low = middle;
    else high = middle;
  }
  return high;
}

export function dayBounds(now: Date, timeZone: string): DayBounds {
  if (!Number.isFinite(now.getTime())) throw new GoogleError('upstream');
  let formatter: Intl.DateTimeFormat;
  let date: string;
  try {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    date = dateAt(now.getTime(), formatter);
  } catch { throw new GoogleError('upstream'); }
  const start = firstInstantOfDate(date, formatter);
  const end = firstInstantOfDate(nextDate(date), formatter);
  return { date, timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString() };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new GoogleError('upstream');
  return value as Record<string, unknown>;
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || !validDate(match[1])) return false;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  const offsetHour = match[6] ? Number(match[6]) : 0;
  const offsetMinute = match[7] ? Number(match[7]) : 0;
  return hour <= 23 && minute <= 59 && second <= 59
    && offsetHour <= 23 && offsetMinute <= 59
    && Number.isFinite(Date.parse(value));
}

function boundary(value: unknown): { value: EventBoundary; allDay: boolean; instant: number; date?: string } {
  const object = record(value);
  const keys = Object.keys(object);
  if (keys.some(key => key !== 'date' && key !== 'dateTime' && key !== 'timeZone')
    || (object.timeZone !== undefined && (typeof object.timeZone !== 'string' || !object.timeZone))) throw new GoogleError('upstream');
  if (validDate(object.date) && object.dateTime === undefined) {
    return { value: { date: object.date }, allDay: true, instant: Date.parse(`${object.date}T00:00:00.000Z`), date: object.date };
  }
  if (validDateTime(object.dateTime) && object.date === undefined) {
    return { value: { dateTime: object.dateTime }, allDay: false, instant: Date.parse(object.dateTime) };
  }
  throw new GoogleError('upstream');
}

interface ParsedEvent { event: TodayEvent; sortAt: number }

function parseEvent(value: unknown, bounds: DayBounds, next: string, formatter: Intl.DateTimeFormat): ParsedEvent | null {
  const item = record(value);
  if (item.status === 'cancelled') return null;
  if (typeof item.id !== 'string' || !item.id) throw new GoogleError('upstream');
  const start = boundary(item.start); const end = boundary(item.end);
  if (start.allDay !== end.allDay || end.instant <= start.instant) throw new GoogleError('upstream');
  const intersects = start.allDay
    ? start.date! < next && end.date! > bounds.date
    : start.instant < Date.parse(bounds.timeMax) && end.instant > Date.parse(bounds.timeMin);
  if (!intersects) return null;
  const event: TodayEvent = {
    id: item.id.slice(0, MAX_EVENT_ID_LENGTH),
    title: typeof item.summary === 'string' && item.summary.length > 0 ? item.summary.slice(0, MAX_EVENT_TITLE_LENGTH) : '제목 없는 일정',
    start: start.value,
    end: end.value,
  };
  if (typeof item.location === 'string') event.location = item.location.slice(0, MAX_EVENT_LOCATION_LENGTH);
  return { event, sortAt: start.allDay ? firstInstantOfDate(start.date!, formatter) : start.instant };
}

export async function fetchToday(accessToken: string, now: Date, signal: AbortSignal): Promise<TodayCalendar> {
  const primary = record(await googleJson(new URL('https://www.googleapis.com/calendar/v3/calendars/primary'), accessToken, signal));
  if (typeof primary.timeZone !== 'string' || !primary.timeZone || primary.timeZone.length > 100) throw new GoogleError('upstream');
  const timeZone = primary.timeZone;
  let bounds: DayBounds;
  try { bounds = dayBounds(now, timeZone); } catch { throw new GoogleError('upstream'); }
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  url.search = new URLSearchParams({
    timeMin: bounds.timeMin,
    timeMax: bounds.timeMax,
    timeZone,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(MAX_TODAY_EVENTS),
    showDeleted: 'false',
  }).toString();
  const seen = new Set<string>();
  const parsed: ParsedEvent[] = [];
  let itemsSeen = 0;
  const result = (): TodayCalendar => {
    parsed.sort((left, right) => left.sortAt - right.sortAt || left.event.id.localeCompare(right.event.id));
    return { date: bounds.date, timeZone, events: parsed.map(item => item.event) };
  };
  const truncatedResult = (): TodayCalendar => {
    if (signal.aborted) throw new GoogleError('upstream');
    if (parsed.length === 0) throw new GoogleError('upstream');
    return result();
  };
  for (let page = 0; page < MAX_TODAY_PAGES; page++) {
    let raw: unknown;
    try { raw = await googleJson(url, accessToken, signal); }
    catch (error) { if (error instanceof GooglePayloadTooLarge) return truncatedResult(); throw error; }
    const body = record(raw);
    if (!Array.isArray(body.items)) throw new GoogleError('upstream');
    for (const value of body.items) {
      if (itemsSeen >= MAX_TODAY_EVENTS) return result();
      itemsSeen++;
      const item = parseEvent(value, bounds, nextDate(bounds.date), formatter);
      if (item) parsed.push(item);
    }
    if (itemsSeen >= MAX_TODAY_EVENTS) return result();
    if (body.nextPageToken === undefined) {
      return result();
    }
    if (typeof body.nextPageToken !== 'string' || !body.nextPageToken || seen.has(body.nextPageToken)) throw new GoogleError('upstream');
    if (body.nextPageToken.length > MAX_PAGE_TOKEN_LENGTH) return truncatedResult();
    seen.add(body.nextPageToken);
    url.searchParams.set('pageToken', body.nextPageToken);
  }
  return truncatedResult();
}
