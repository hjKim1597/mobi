import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchToday, MAX_EVENT_ID_LENGTH, MAX_EVENT_LOCATION_LENGTH, MAX_EVENT_TITLE_LENGTH, MAX_TODAY_EVENTS } from '../src/calendar';
import { authorizationUrl, exchangeCode, GOOGLE_SCOPES, googleJson, MAX_PROVIDER_RESPONSE_BYTES } from '../src/google';
import { buildBriefing, MAX_TTS_TEXT_LENGTH, synthesize } from '../src/voice';

afterEach(() => vi.unstubAllGlobals());

const dayEvent = (id = 'event', summary = 'Meeting', location = 'Office') => ({
  id, summary, location,
  start: { dateTime: '2026-10-24T09:00:00+09:00' },
  end: { dateTime: '2026-10-24T10:00:00+09:00' },
});
const signal = new AbortController().signal;

describe('provider payload bounds', () => {
  it('reads response streams only up to the byte limit before JSON parsing', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(MAX_PROVIDER_RESPONSE_BYTES + 1)); },
      cancel,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    await expect(googleJson(new URL('https://www.googleapis.com/test'), 'token', signal)).rejects.toMatchObject({ kind: 'upstream' });
    expect(cancel).toHaveBeenCalled();
  });

  it('cancels a provider response stream and fails when the request aborts during reading', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const pending = googleJson(new URL('https://www.googleapis.com/test'), 'token', controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'upstream' });
    expect(cancel).toHaveBeenCalled();
  });

  it('applies the same pre-parse byte bound to OAuth token responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { headers: { 'Content-Length': String(MAX_PROVIDER_RESPONSE_BYTES + 1) } })));
    await expect(exchangeCode({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', PUBLIC_ORIGIN: 'https://mobi.example' }, 'code', signal))
      .rejects.toMatchObject({ kind: 'upstream' });
  });

  it('returns deterministic partial calendar data when an event page exceeds the byte limit', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ timeZone: 'Asia/Seoul' }))
      .mockResolvedValueOnce(Response.json({ items: [dayEvent()], nextPageToken: 'next' }))
      .mockResolvedValueOnce(new Response('x'.repeat(32), { headers: { 'Content-Length': String(MAX_PROVIDER_RESPONSE_BYTES + 1) } }));
    vi.stubGlobal('fetch', fetch);
    const result = await fetchToday('token', new Date('2026-10-24T00:00:00Z'), signal);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe('event');
  });

  it('fails safely when the first event page is oversized instead of claiming the calendar is empty', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ timeZone: 'Asia/Seoul' }))
      .mockResolvedValueOnce(new Response('x', { headers: { 'Content-Length': String(MAX_PROVIDER_RESPONSE_BYTES + 1) } })));
    await expect(fetchToday('token', new Date('2026-10-24T00:00:00Z'), signal)).rejects.toMatchObject({ kind: 'upstream' });
  });

  it('stops after five event pages and returns only the bounded parsed prefix', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ timeZone: 'Asia/Seoul' }))
      .mockResolvedValueOnce(Response.json({ items: [dayEvent('page-1')], nextPageToken: 'p2' }))
      .mockResolvedValueOnce(Response.json({ items: [dayEvent('page-2')], nextPageToken: 'p3' }))
      .mockResolvedValueOnce(Response.json({ items: [dayEvent('page-3')], nextPageToken: 'p4' }))
      .mockResolvedValueOnce(Response.json({ items: [dayEvent('page-4')], nextPageToken: 'p5' }))
      .mockResolvedValueOnce(Response.json({ items: [dayEvent('page-5')], nextPageToken: 'p6' }));
    vi.stubGlobal('fetch', fetch);
    const result = await fetchToday('token', new Date('2026-10-24T00:00:00Z'), signal);
    expect(result.events.map(event => event.id)).toEqual(['page-1', 'page-2', 'page-3', 'page-4', 'page-5']);
    expect(fetch).toHaveBeenCalledTimes(6); // metadata plus five event pages
  });

  it('stops immediately at 200 items even when the page has a continuation token', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ timeZone: 'Asia/Seoul' }))
      .mockResolvedValueOnce(Response.json({ items: Array.from({ length: MAX_TODAY_EVENTS }, (_, i) => dayEvent(String(i))), nextPageToken: 'next' }));
    vi.stubGlobal('fetch', fetch);
    const result = await fetchToday('token', new Date('2026-10-24T00:00:00Z'), signal);
    expect(result.events).toHaveLength(MAX_TODAY_EVENTS);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get('maxResults')).toBe(String(MAX_TODAY_EVENTS));
  });

  it('rejects oversized continuation tokens after preserving any parsed prefix', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ timeZone: 'Asia/Seoul' }))
      .mockResolvedValueOnce(Response.json({ items: [dayEvent()], nextPageToken: 'x'.repeat(1025) }));
    vi.stubGlobal('fetch', fetch);
    const result = await fetchToday('token', new Date('2026-10-24T00:00:00Z'), signal);
    expect(result.events.map(event => event.id)).toEqual(['event']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('caps event count and each exposed provider field deterministically', async () => {
    const events = Array.from({ length: MAX_TODAY_EVENTS + 2 }, (_, i) => dayEvent('i'.repeat(MAX_EVENT_ID_LENGTH + 4) + i, 't'.repeat(MAX_EVENT_TITLE_LENGTH + 4), 'l'.repeat(MAX_EVENT_LOCATION_LENGTH + 4)));
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ timeZone: 'Asia/Seoul' }))
      .mockResolvedValueOnce(Response.json({ items: events })));
    const result = await fetchToday('token', new Date('2026-10-24T00:00:00Z'), signal);
    expect(result.events).toHaveLength(MAX_TODAY_EVENTS);
    expect(result.events[0].id).toHaveLength(MAX_EVENT_ID_LENGTH);
    expect(result.events[0].title).toHaveLength(MAX_EVENT_TITLE_LENGTH);
    expect(result.events[0].location).toHaveLength(MAX_EVENT_LOCATION_LENGTH);
  });
});

describe('briefing and OAuth bounds', () => {
  it('limits briefing text to a stable maximum with an ellipsis', () => {
    const calendar = { date: '2026-10-24', timeZone: 'UTC', events: Array.from({ length: 200 }, (_, i) => ({ id: String(i), title: '일정'.repeat(100), start: { dateTime: '2026-10-24T09:00:00Z' }, end: { dateTime: '2026-10-24T10:00:00Z' } })) };
    const briefing = buildBriefing(calendar, 1800);
    expect(briefing.text).toHaveLength(MAX_TTS_TEXT_LENGTH);
    expect(briefing.text.endsWith('…')).toBe(true);
  });

  it('caps the final sanitized text sent to TTS', async () => {
    const bytes = new Uint8Array(46), view = new DataView(bytes.buffer);
    for (const [at, value] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) [...value].forEach((char, index) => { bytes[at + index] = char.charCodeAt(0); });
    view.setUint32(4, 38, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 44100, true); view.setUint32(28, 88200, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, 2, true);
    const run = vi.fn(async (..._args: unknown[]) => new Response(bytes));
    const result = await synthesize({ run } as unknown as Ai, '일정'.repeat(5000), Date.now() + 1000);
    expect(result.text).toHaveLength(MAX_TTS_TEXT_LENGTH);
    expect(result.text.endsWith('…')).toBe(true);
    expect(run.mock.calls[0][1]).toMatchObject({ prompt: result.text });
  });

  it('requests and requires Calendar scopes only', () => {
    const url = new URL(authorizationUrl({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', PUBLIC_ORIGIN: 'https://mobi.example' }, 'state'));
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(GOOGLE_SCOPES);
    expect(GOOGLE_SCOPES.some(scope => scope.includes('gmail'))).toBe(false);
  });
});
