export interface CalendarPayload {
  kind: 'calendar_insert'; title: string; start: string; end: string; timeZone: string; eventId: string; defaultDuration: boolean;
}
export type CalendarResolution =
  | { status: 'awaiting_approval'; payload: Omit<CalendarPayload, 'kind' | 'eventId'> }
  | { status: 'needs_clarification'; question: string; reasonCode: string }
  | { status: 'rejected'; reasonCode: string };

const HOUR_WORDS: Record<string, number> = { 한: 1, 하나: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 네: 4, 넷: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10, 열한: 11, 열두: 12 };
const pad = (n: number) => String(n).padStart(2, '0');
function localParts(epoch: number, zone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(epoch);
  const n = (type: string) => Number(parts.find(p => p.type === type)?.value);
  return { y: n('year'), m: n('month'), d: n('day') };
}
const formatters = new Map<string, Intl.DateTimeFormat>();
function zonedFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); formatters.set(zone, formatter); }
  return formatter;
}
function zoneOffsetMinutes(epoch: number, zone: string): number {
  const fields = Object.fromEntries(zonedFormatter(zone).formatToParts(epoch).map(p => [p.type, p.value]));
  return Math.round((Date.UTC(+fields.year, +fields.month - 1, +fields.day, +fields.hour, +fields.minute) - Math.floor(epoch / 60_000) * 60_000) / 60_000);
}
function localDateTime(date: string, hour: number, minute: number, zone: string): { epoch: number; offset: string } | null {
  const [y, m, d] = date.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d, hour, minute);
  const offsets = new Set([-180, -1, 0, 1, 180].map(days => zoneOffsetMinutes(target + days * 86_400_000, zone)));
  const matches = [...offsets].map(offset => target - offset * 60_000).filter(epoch => {
    const v = Object.fromEntries(zonedFormatter(zone).formatToParts(epoch).map(p => [p.type, p.value]));
    return +v.year === y && +v.month === m && +v.day === d && +v.hour === hour && +v.minute === minute;
  });
  if (matches.length !== 1) return null;
  const epoch = matches[0];
  const offsetMin = Math.round((target - epoch) / 60_000);
  const sign = offsetMin < 0 ? '-' : '+'; const abs = Math.abs(offsetMin);
  return { epoch, offset: `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}` };
}
function extractDate(text: string, now: number, zone: string): string | null {
  let m = text.match(/\b(20\d{2})-(\d{2})-(\d{2})(?!\d)/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const base = localParts(now, zone);
  let delta = text.includes('모레') ? 2 : text.includes('내일') ? 1 : text.includes('오늘') ? 0 : -1;
  m = text.match(/(20\d{2})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = text.match(/(?:^|\D)(\d{1,2})월\s*(\d{1,2})일/);
  if (m) return `${base.y}-${pad(+m[1])}-${pad(+m[2])}`;
  if (delta < 0) return null;
  const d = new Date(Date.UTC(base.y, base.m - 1, base.d + delta));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function hasConflictingDateTokens(text: string): boolean {
  const dateTokens = [...text.matchAll(/(?<!\d)(?:20\d{2}-\d{2}-\d{2}|20\d{2}년\s*\d{1,2}월\s*\d{1,2}일|\d{1,2}월\s*\d{1,2}일|오늘|내일|모레)(?!\d)/g)];
  return dateTokens.length > 1;
}
type Period = 'afternoon' | 'morning';
interface ClockToken { start: number; end: number; hour: number; minute: number; period?: Period; kind: 'korean' | 'numeric'; }
const HOUR_TOKEN = '(?:열한|열두|열|아홉|여덟|일곱|여섯|다섯|넷|네|셋|세|둘|두|하나|한|\\d{1,2})';
const CLOCK_TOKEN = new RegExp(`(?:(오전|오후|아침|저녁|밤)\\s*)?(${HOUR_TOKEN})\\s*시\\s*(?:(\\d{1,2})\\s*분|(반)(?!\\s*시간))?(?!간|\\d|분|반|초|정각|십오|십|이십|삼십)`, 'g');
const NUMERIC_CLOCK_TOKEN = /(?<!\d)(\d{1,2}):(\d{2})(?![:\d])/g;
function periodValue(value?: string): Period | undefined {
  if (value && /오후|저녁|밤/.test(value)) return 'afternoon';
  if (value && /오전|아침/.test(value)) return 'morning';
  return undefined;
}
function parseClockTokens(text: string): ClockToken[] {
  const tokens: ClockToken[] = [];
  const covered = new Set<number>();
  for (const match of text.matchAll(CLOCK_TOKEN)) {
    const start = match.index ?? 0;
    const hourText = match[2];
    const numeric = /^\d+$/.test(hourText);
    const hour = numeric ? Number(hourText) : HOUR_WORDS[hourText];
    if (!hour || hour < 1 || hour > 12) continue;
    const minute = match[4] ? 30 : match[3] ? Number(match[3]) : 0;
    if (minute > 59) continue;
    for (let i = start; i < start + match[0].length; i++) covered.add(i);
    tokens.push({ start, end: start + match[0].length, hour, minute, period: periodValue(match[1]), kind: 'korean' });
  }
  for (const match of text.matchAll(NUMERIC_CLOCK_TOKEN)) {
    const start = match.index ?? 0;
    if (covered.has(start) || Number(match[1]) > 23 || Number(match[2]) > 59) continue;
    tokens.push({ start, end: start + match[0].length, hour: Number(match[1]), minute: Number(match[2]), kind: 'numeric' });
  }
  return tokens.sort((a, b) => a.start - b.start);
}
function hasUnsupportedTimeLike(text: string, clocks: ClockToken[]): boolean {
  if (/(?:오전|오후|아침|저녁|밤)\s*\d{1,2}:\d{2}/.test(text)) return true;
  const numericCandidates = [...text.matchAll(/(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?!\d)/g)];
  if (numericCandidates.some(match => !clocks.some(clock => clock.start === match.index && clock.end === (match.index ?? 0) + match[0].length))) return true;
  if (/(?:오전|오후|아침|저녁|밤)\s*(?:오전|오후|아침|저녁|밤)\s*(?:열한|열두|열|아홉|여덟|일곱|여섯|다섯|넷|네|셋|세|둘|두|하나|한|\d{1,2})\s*시/.test(text)) return true;
  const timeWords = /(?:열한|열두|열|아홉|여덟|일곱|여섯|다섯|넷|네|셋|세|둘|두|하나|한|\d{1,2})\s*시/g;
  for (const match of text.matchAll(timeWords)) {
    const start = match.index ?? 0;
    if (!clocks.some(clock => clock.start <= start && clock.end >= start + match[0].length)) return true;
    const rest = text.slice(start + match[0].length);
    const unsupportedSuffix = rest.match(/^\s*(?:(?:\d+|[영일이삼사오육칠팔구십백천만]+)\s*분|반)/)?.[0];
    if (unsupportedSuffix && !/^\s*반 시간/.test(rest) && !clocks.some(clock => clock.start <= start && clock.end >= start + match[0].length + unsupportedSuffix.length)) return true;
  }
  for (const clock of clocks) {
    const next = clocks.find(candidate => candidate.start >= clock.end);
    const remainder = text.slice(clock.end, next?.start ?? text.length);
    if (/^\s*(?:\d+|[영일이삼사오육칠팔구십백천만]+\s*(?:분|반|초))/.test(remainder) && !/^\s*반 시간/.test(remainder)) return true;
  }
  return false;
}
function safeTitle(text: string, clocks: ClockToken[]): string | null {
  let cleaned = text.replace(/\b20\d{2}-\d{2}-\d{2}T\d{1,2}:\d{2}\b/g, match => ' '.repeat(match.length));
  for (const clock of [...clocks].sort((a, b) => b.start - a.start)) cleaned = `${cleaned.slice(0, clock.start)} ${cleaned.slice(clock.end)}`;
  cleaned = cleaned.replace(/\b20\d{2}-\d{2}-\d{2}(?:T\d{1,2}:\d{2})?\b/g, ' ').replace(/\b\d{1,2}:\d{2}\b/g, ' ').replace(/20\d{2}년\s*\d{1,2}월\s*\d{1,2}일/g, ' ').replace(/(?:^|\D)\d{1,2}월\s*\d{1,2}일/g, ' ').replace(/(오늘|내일|모레|오전|오후|아침|저녁|밤)\s*/g, ' ').replace(/(?:삼십 분|반 시간|30분)/g, ' ').replace(/\s+(?:일정|일정을)\s*(?:추가해\s*줘|추가해|추가|등록해\s*줘|등록해|등록)[.!?。！？]*\s*$/u, ' ').replace(/(?:추가해\s*줘|추가해|추가|등록해\s*줘|등록해|등록|잡아\s*줘|잡아줘?)/g, ' ').replace(/(?:부터|까지|~|∼|–|-)/g, ' ').replace(/\s+/g, ' ').trim();
  const title = cleaned || (text.includes('회의') ? '회의' : text.includes('약속') ? '약속' : '일정');
  if (title.length > 60 || /@|참석자|초대|메일|https?:|<|>|\bto\b/i.test(title)) return null;
  return title;
}
export function resolveCalendarRequest(text: string, timeZone: string, now: number, clarification?: string, mailTitle?: string): CalendarResolution {
  try { new Intl.DateTimeFormat('en', { timeZone }); } catch { return { status: 'rejected', reasonCode: 'invalid_time_zone' }; }
  const joined = `${text} ${clarification ?? ''}`.normalize('NFKC');
  if (hasConflictingDateTokens(joined)) {
    if (clarification) return { status: 'rejected', reasonCode: 'unclear_after_clarification' };
    return { status: 'needs_clarification', question: '어느 날짜로 일정을 잡을까요?', reasonCode: 'conflicting_date' };
  }
  const date = extractDate(joined, now, timeZone);
  const clocks = parseClockTokens(joined);
  if (hasUnsupportedTimeLike(joined, clocks)) {
    if (clarification) return { status: 'rejected', reasonCode: 'unclear_after_clarification' };
    return { status: 'needs_clarification', question: '시작과 종료 시각을 숫자로 말씀해 주세요.', reasonCode: 'unsupported_time' };
  }
  const first = clocks[0];
  const between = first && clocks[1] ? joined.slice(first.end, clocks[1].start) : '';
  const afterFirst = first ? joined.slice(first.end, clocks[1]?.start ?? joined.length) : '';
  const explicitEnd = !!first && ((!!clocks[1] && (/(?:부터|~|∼|–)/.test(between) || /-/.test(between))) || /부터|~|∼|–|-/.test(afterFirst));
  if (clocks.length > (explicitEnd ? 2 : 1) || (clocks.length === 2 && !explicitEnd)) {
    if (clarification) return { status: 'rejected', reasonCode: 'unclear_after_clarification' };
    return { status: 'needs_clarification', question: '시작과 종료 시각을 숫자로 말씀해 주세요.', reasonCode: 'unsupported_time' };
  }
  const second = explicitEnd ? clocks[1] : undefined;
  const firstPeriod = first?.period ?? (first?.kind === 'numeric' ? first.hour < 12 ? 'morning' : 'afternoon' : first && clarification ? periodValue(clarification) : undefined);
  const secondPeriod = second?.period ?? (firstPeriod && second?.kind === 'korean' ? firstPeriod : undefined);
  const hourInPeriod = (clock: ClockToken | undefined, period: Period | undefined) => clock?.kind !== 'korean' ? clock?.hour : period === 'afternoon' ? clock.hour % 12 + 12 : period === 'morning' ? clock.hour % 12 : clock.hour;
  const firstHour = hourInPeriod(first, firstPeriod);
  const secondHour = hourInPeriod(second, secondPeriod);
  const invalidPeriod = (first?.kind === 'korean' && !firstPeriod) || (second?.kind === 'korean' && !secondPeriod);
  const title = mailTitle ?? safeTitle(text, parseClockTokens(text));
  if (!date || !first || invalidPeriod || !title) {
    if (clarification) return { status: 'rejected', reasonCode: 'unclear_after_clarification' };
    return { status: 'needs_clarification', question: !date ? '몇 월 며칠 일정인가요?' : '오전인가요, 오후인가요?', reasonCode: !date ? 'missing_date' : 'ambiguous_time' };
  }
  if (explicitEnd && !second) {
    if (clarification) return { status: 'rejected', reasonCode: 'unclear_after_clarification' };
    return { status: 'needs_clarification', question: '몇 시까지 일정인가요?', reasonCode: 'explicit_end_unresolved' };
  }
  const start = localDateTime(date, firstHour!, first.minute, timeZone);
  if (!start) return { status: 'rejected', reasonCode: 'ambiguous_or_nonexistent_local_time' };
  const duration = /삼십 분|반 시간|30분/.test(joined) ? 30 : null;
  const endEpoch = second ? localDateTime(date, secondHour!, second.minute, timeZone)?.epoch : duration ? start.epoch + duration * 60_000 : start.epoch + 30 * 60_000;
  if (!endEpoch || endEpoch <= start.epoch || start.epoch <= now) return { status: 'rejected', reasonCode: start.epoch <= now ? 'past_event' : 'invalid_interval' };
  const endOffset = new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'longOffset' }).formatToParts(endEpoch).find(p => p.type === 'timeZoneName')?.value.replace('GMT', '') || '+00:00';
  const endParts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(endEpoch);
  const part = (type: string) => endParts.find(p => p.type === type)?.value ?? '00';
  return { status: 'awaiting_approval', payload: { title, start: `${date}T${pad(firstHour!)}:${pad(first.minute)}:00${start.offset}`, end: `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:00${endOffset}`, timeZone, defaultDuration: !second && duration === null } };
}

export async function calendarEventId(identity: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return `mobi${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')}`;
}
function koreanMinute(value: number): string {
  const digits = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
  if (value < 10) return digits[value];
  if (value === 10) return '십';
  if (value < 20) return `십${digits[value % 10]}`;
  const tens = Math.floor(value / 10), ones = value % 10;
  return `${digits[tens]}십${ones ? digits[ones] : ''}`;
}
function koreanHour(value: number): string {
  return ['', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열', '열한', '열두'][value];
}
function calendarDateTime(epoch: number, zone: string, currentYear: number) {
  const fields = Object.fromEntries(zonedFormatter(zone).formatToParts(epoch).map(p => [p.type, p.value]));
  const year = Number(fields.year), month = Number(fields.month), day = Number(fields.day);
  const hour = Number(fields.hour), minute = Number(fields.minute);
  const hour12 = hour % 12 || 12;
  return {
    year, month, day,
    date: `${year !== currentYear ? `${year}년 ` : ''}${month}월 ${day}일`,
    period: hour < 12 ? '오전' : '오후',
    time: `${koreanHour(hour12)} 시${minute === 0 ? '' : minute === 30 ? ' 반' : ` ${koreanMinute(minute)} 분`}`,
  };
}
export function calendarReadbackParts(payload: Pick<CalendarPayload, 'title' | 'start' | 'end' | 'timeZone' | 'defaultDuration'>, now = Date.now()): Array<{ text: string; fixed: boolean }> {
  const currentYear = localParts(now, payload.timeZone).y;
  const start = calendarDateTime(Date.parse(payload.start), payload.timeZone, currentYear);
  const end = calendarDateTime(Date.parse(payload.end), payload.timeZone, currentYear);
  const dateChanged = start.year !== end.year || start.month !== end.month || start.day !== end.day;
  const sharedPeriod = start.period === end.period;
  const timeText = `${start.date} ${start.period} ${start.time}부터 ${dateChanged ? `${end.date} ` : ''}${sharedPeriod ? '' : `${end.period} `}${end.time}까지`;
  // Speak identifier separators explicitly; the lossless sanitizer removes none.
  const zone = payload.timeZone.replaceAll('/', ' 슬래시 ').replaceAll('_', ' 밑줄 ').replaceAll('+', ' 플러스 ').replaceAll('-', ' 마이너스 ');
  return [
    { text: timeText, fixed: false },
    { text: `'${payload.title}' 일정을${payload.timeZone === 'Asia/Seoul' ? '' : ` ${zone} 시간대`} 내 캘린더에 추가할게요.`, fixed: false },
    { text: "추가하려면 '추가해'라고 말씀해 주세요.", fixed: true },
  ];
}
export function calendarReadback(payload: CalendarPayload, now = Date.now()): string {
  return calendarReadbackParts(payload, now).map(part => part.text).join(' ');
}

/** Exact formatter used by pre-natural-readback pending calendar rows. */
export function legacyCalendarReadback(payload: Pick<CalendarPayload, 'title' | 'start' | 'end' | 'timeZone' | 'defaultDuration'>): string {
  const fmt = (iso: string) => {
    const parts = new Intl.DateTimeFormat('ko-KR', { timeZone: payload.timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true }).formatToParts(new Date(iso));
    const n = (type: string) => Number(parts.find(part => part.type === type)?.value);
    const period = parts.find(part => part.type === 'dayPeriod')?.value;
    return `${n('year')}년 ${n('month')}월 ${n('day')}일 ${period} ${n('hour')}시 ${n('minute')}분`;
  };
  const zone = payload.timeZone.replaceAll('/', ' 슬래시 ').replaceAll('_', ' 밑줄 ').replaceAll('+', ' 플러스 ').replaceAll('-', ' 마이너스 ');
  return `${fmt(payload.start)}부터 ${fmt(payload.end)}까지 '${payload.title}' 일정을 ${zone} 시간대${payload.defaultDuration ? ', 삼십 분 일정으로' : ''} 내 캘린더에 추가할게요. 추가하려면 '추가해'라고 말씀해 주세요.`;
}

const MAX_JSON_BYTES = 1_048_576;
async function jsonResponse(response: Response): Promise<Record<string, any> | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) { void response.body?.cancel().catch(() => {}); return null; }
  if (!response.body) return null;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { const value = JSON.parse(new TextDecoder().decode(bytes)); return value && typeof value === 'object' ? value : null; } catch { return null; }
}
function eventBody(payload: CalendarPayload, fingerprint: string) {
  return { id: payload.eventId, summary: payload.title, start: { dateTime: payload.start, timeZone: payload.timeZone }, end: { dateTime: payload.end, timeZone: payload.timeZone }, reminders: { useDefault: false, overrides: [] }, extendedProperties: { private: { mobiFingerprint: fingerprint } } };
}
export async function insertCalendarEvent(accessToken: string, payload: CalendarPayload, signal: AbortSignal): Promise<'succeeded' | 'unknown' | 'failed'> {
  const canonical = JSON.stringify({ title: payload.title, start: payload.start, end: payload.end, timeZone: payload.timeZone });
  const dig = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const fingerprint = Array.from(new Uint8Array(dig), b => b.toString(16).padStart(2, '0')).join('');
  const body = eventBody(payload, fingerprint);
  const collection = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  const eventUrl = new URL(`${collection}/${encodeURIComponent(payload.eventId)}`);
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const matches = (v: Record<string, any> | null) => !!v && v.id === payload.eventId && v.summary === payload.title && v.start?.dateTime === payload.start && v.start?.timeZone === payload.timeZone && v.end?.dateTime === payload.end && v.end?.timeZone === payload.timeZone && v.extendedProperties?.private?.mobiFingerprint === fingerprint;
  // Two total inserts at most (the initial call plus one same-id retry).
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) return 'unknown';
    let response: Response;
    try { response = await fetch(new URL(`${collection}?sendUpdates=none`), { method: 'POST', headers, body: JSON.stringify(body), signal }); }
    catch { response = new Response(null, { status: 599 }); }
    if (response.ok) return 'succeeded';
    if (![409, 500, 502, 503, 504, 599].includes(response.status)) return 'failed';
    await new Promise(resolve => setTimeout(resolve, 150));
    try {
      const get = await fetch(eventUrl, { headers: { Authorization: `Bearer ${accessToken}` }, signal });
      if (get.ok) return matches(await jsonResponse(get)) ? 'succeeded' : 'failed';
      if (get.status !== 404) return 'unknown';
    } catch { return 'unknown'; }
    if (attempt === 1) return 'unknown';
  }
  return 'unknown';
}
