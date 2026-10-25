import { dayBounds, type TodayCalendar } from './calendar';
import { inspectBase64Wav } from './audio';
import { sanitizeTtsText } from './tts';

export const MAX_BRIEFING_CACHE_BYTES = 512 * 1024;
export const BRIEFING_CACHE_TTL_MS = 30_000;

export interface BriefingCacheKey {
  epoch: number;
  tripId: string;
  calendarDate: string;
  timeZone: string;
  calendarFingerprint: string;
  canonicalText: string;
  voice: string;
  modelVersion: string;
}

export interface BriefingAudio { data: string; mimeType: 'audio/wav' }
export interface BriefingCacheEntry extends BriefingCacheKey { audio: BriefingAudio; expiresAt: number }

export async function fingerprintCalendar(calendar: TodayCalendar): Promise<string> {
  const events = [...calendar.events].map(event => ({
    id: event.id,
    title: event.title,
    start: event.start,
    end: event.end,
    ...(event.location === undefined ? {} : { location: event.location }),
  })).sort((left, right) => left.id.localeCompare(right.id) || JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const canonical = JSON.stringify({ date: calendar.date, timeZone: calendar.timeZone, events });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function validKey(key: BriefingCacheKey): boolean {
  return Number.isSafeInteger(key.epoch) && key.epoch >= 0
    && !!key.tripId && !!key.calendarDate && !!key.timeZone
    && /^[0-9a-f]{64}$/u.test(key.calendarFingerprint)
    && !!key.voice && !!key.modelVersion
    && sanitizeTtsText(key.canonicalText) === key.canonicalText
    && new TextEncoder().encode(key.canonicalText).length <= 60
    && /[^.!?…]+[.!?…]$/u.test(key.canonicalText)
    && (key.canonicalText.match(/[.!?…]/gu)?.length ?? 0) === 1;
}

function validAudio(audio: BriefingAudio): boolean {
  if (!audio || audio.mimeType !== 'audio/wav' || !audio.data || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(audio.data)) return false;
  try { inspectBase64Wav(audio.data, MAX_BRIEFING_CACHE_BYTES); return true; } catch { return false; }
}

export function createBriefingCacheEntry(input: {
  key: BriefingCacheKey;
  audio: BriefingAudio;
  now: number;
  nextStartAt?: number;
}): BriefingCacheEntry | null {
  const { key, audio, now, nextStartAt } = input;
  if (!validKey(key) || !validAudio(audio) || !Number.isFinite(now)) return null;
  let bounds: ReturnType<typeof dayBounds>;
  try { bounds = dayBounds(new Date(now), key.timeZone); } catch { return null; }
  if (bounds.date !== key.calendarDate) return null;
  const localMidnight = Date.parse(bounds.timeMax);
  if (nextStartAt !== undefined && (!Number.isFinite(nextStartAt) || nextStartAt <= now)) return null;
  const entry: BriefingCacheEntry = {
    ...key,
    audio: { data: audio.data, mimeType: audio.mimeType },
    expiresAt: Math.min(now + BRIEFING_CACHE_TTL_MS, localMidnight, nextStartAt ?? Number.POSITIVE_INFINITY),
  };
  if (!Number.isFinite(entry.expiresAt) || new TextEncoder().encode(JSON.stringify(entry)).length > MAX_BRIEFING_CACHE_BYTES) return null;
  return entry;
}

export function getCompatibleBriefing(entry: BriefingCacheEntry | null | undefined, key: BriefingCacheKey, now: number): BriefingCacheEntry | null {
  if (!entry || !Number.isFinite(now) || now >= entry.expiresAt || !validKey(key)) return null;
  const sameKey = entry.epoch === key.epoch && entry.tripId === key.tripId
    && entry.calendarDate === key.calendarDate && entry.timeZone === key.timeZone
    && entry.calendarFingerprint === key.calendarFingerprint && entry.canonicalText === key.canonicalText
    && entry.voice === key.voice && entry.modelVersion === key.modelVersion;
  if (!sameKey || !validAudio(entry.audio)) return null;
  return { ...entry, audio: { ...entry.audio } };
}
