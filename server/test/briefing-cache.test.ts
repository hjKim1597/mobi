import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  createBriefingCacheEntry,
  fingerprintCalendar,
  getCompatibleBriefing,
  type BriefingAudio,
  type BriefingCacheKey,
} from '../src/briefing-cache';
import type { TodayCalendar } from '../src/calendar';
import type { Env as WorkerEnv } from '../src/state';

declare module 'cloudflare:test' { interface ProvidedEnv extends WorkerEnv {} }

const now = Date.parse('2026-10-25T01:00:00.000Z');
const calendar: TodayCalendar = {
  date: '2026-10-25', timeZone: 'Asia/Seoul', events: [{
    id: 'event-1', title: '회의', start: { dateTime: '2026-10-25T05:00:00Z' },
    end: { dateTime: '2026-10-25T06:00:00Z' }, location: '회의실',
  }],
};
const key: BriefingCacheKey = {
  epoch: 4, tripId: 'trip-a', calendarDate: calendar.date, timeZone: calendar.timeZone,
  calendarFingerprint: 'f'.repeat(64), canonicalText: '오늘 일정은 한 개예요.', voice: 'voice-a', modelVersion: 'model-v1',
};
function wavData(dataBytes = 2): string {
  dataBytes += dataBytes % 2;
  const bytes = new Uint8Array(44 + dataBytes), view = new DataView(bytes.buffer);
  const put = (offset: number, value: string) => [...value].forEach((char, index) => { bytes[offset + index] = char.charCodeAt(0); });
  put(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); put(8, 'WAVE'); put(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  put(36, 'data'); view.setUint32(40, dataBytes, true);
  let raw = ''; for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}
const audio = { data: wavData(), mimeType: 'audio/wav' as const };

describe('briefing cache entry', () => {
  it('fingerprints Calendar content independent of event ordering', async () => {
    const swapped = { ...calendar, events: [...calendar.events].reverse() };
    await expect(fingerprintCalendar(swapped)).resolves.toBe(await fingerprintCalendar(calendar));
  });

  it('changes the fingerprint when event content changes', async () => {
    const changed = { ...calendar, events: [{ ...calendar.events[0], title: '다른 회의' }] };
    expect(await fingerprintCalendar(changed)).not.toBe(await fingerprintCalendar(calendar));
  });

  it('stores generated single-sentence audio and expires at the earliest validity boundary', () => {
    const entry = createBriefingCacheEntry({ key, audio, now, nextStartAt: now + 90_000 });
    expect(entry).toMatchObject({ ...key, audio, expiresAt: now + 30_000 });
  });

  it('expires at Calendar-local midnight or selected event start when earlier', () => {
    expect(createBriefingCacheEntry({ key, audio, now, nextStartAt: now + 1_000 })?.expiresAt).toBe(now + 1_000);
    const beforeMidnight = Date.parse('2026-10-25T14:59:50.000Z');
    expect(createBriefingCacheEntry({ key, audio, now: beforeMidnight })?.expiresAt).toBe(Date.parse('2026-10-25T15:00:00.000Z'));
  });

  it.each([
    ['different epoch', { ...key, epoch: 5 }],
    ['different trip', { ...key, tripId: 'trip-b' }],
    ['different date', { ...key, calendarDate: '2026-10-26' }],
    ['different timezone', { ...key, timeZone: 'UTC' }],
    ['different Calendar content', { ...key, calendarFingerprint: 'x'.repeat(64) }],
    ['different canonical text', { ...key, canonicalText: '다음 일정은 회의예요.' }],
    ['different voice', { ...key, voice: 'voice-b' }],
    ['different model version', { ...key, modelVersion: 'model-v2' }],
  ])('is a miss for %s', (label, mismatch) => {
    const entry = createBriefingCacheEntry({ key, audio, now });
    expect(getCompatibleBriefing(entry, mismatch, now)).toBeNull();
  });

  it('misses when expired and after Calendar fingerprint changes', () => {
    const entry = createBriefingCacheEntry({ key, audio, now });
    expect(getCompatibleBriefing(entry, key, now + 30_000)).toBeNull();
    expect(getCompatibleBriefing(entry, { ...key, calendarFingerprint: 'g'.repeat(64) }, now + 1)).toBeNull();
  });

  it.each([
    ['multi-sentence text', { ...key, canonicalText: '첫 문장이에요. 둘째 문장이에요.' }, audio],
    ['oversized text', { ...key, canonicalText: `${'가'.repeat(30)}예요.` }, audio],
    ['empty audio', key, { data: '', mimeType: 'audio/wav' as const }],
    ['wrong mime type', key, { data: audio.data, mimeType: 'audio/mpeg' as const }],
    ['invalid WAV', key, { data: btoa('RIFFfixture'), mimeType: 'audio/wav' as const }],
    ['oversized encoded entry', key, { data: wavData(513 * 1024), mimeType: 'audio/wav' as const }],
  ])('rejects %s', (_reason, candidateKey, candidateAudio) => {
    expect(createBriefingCacheEntry({ key: candidateKey, audio: candidateAudio as BriefingAudio, now })).toBeNull();
  });

  it('rejects stale Calendar dates and past next-start timestamps', () => {
    expect(createBriefingCacheEntry({ key: { ...key, calendarDate: '2026-10-24' }, audio, now })).toBeNull();
    expect(createBriefingCacheEntry({ key, audio, now, nextStartAt: now })).toBeNull();
  });
});

describe('DeviceAgent briefing cache RPC', () => {
  it('publishes only at the expected epoch and clears on disconnect', async () => {
    const stub = env.DEVICE_AGENTS.getByName(`briefing-cache-test-${crypto.randomUUID()}`);
    await stub.register('test-token-hash');
    const currentKey = { ...key, epoch: 0 };
    expect(await stub.publishBriefingCache({ key: currentKey, audio, now })).toBe(true);
    expect(await stub.getBriefingCache({ key: currentKey, now })).toMatchObject({ audio, canonicalText: currentKey.canonicalText });
    expect(await stub.publishBriefingCache({ key: { ...currentKey, epoch: 1 }, audio, now })).toBe(false);
    expect(await stub.getBriefingCache({ key: currentKey, now: now + 30_000 })).toBeNull();
    expect(await stub.getBriefingCache({ key: currentKey, now: now + 1 })).toBeNull();
    expect(await stub.publishBriefingCache({ key: currentKey, audio, now })).toBe(true);
    await stub.disconnectGoogle();
    expect(await stub.getBriefingCache({ key: currentKey, now: now + 1 })).toBeNull();
    expect(await stub.publishBriefingCache({ key: currentKey, audio, now: now + 1 })).toBe(false);
  });
});
