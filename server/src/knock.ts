import { knockAssets } from './knock-audio';
import { outputAudioSchema } from './schemas';

// These five public templates are immutable and validated once at startup.
const entries = Object.fromEntries(Object.entries(knockAssets).map(([id, asset]) => [id, Object.freeze({
  text: asset.text, audio: outputAudioSchema.parse({ data: asset.data, mimeType: 'audio/wav' }), sha256: asset.sha256,
})]));

export function selectKnock(eventCount: number, date: string, timeZone: string) {
  const key = eventCount === 0 ? '0' : eventCount === 1 ? '1' : 'many';
  const entry = (id: string) => {
    const entry = entries[id];
    if (!entry) throw Error('Missing generated knock asset');
    return entry;
  };
  return { version: 'knock-v1' as const, date, timeZone, eventCount,
    online: entry(key === '0' ? '0' : key + '-online'), offline: entry(key === '0' ? '0' : key + '-offline') };
}
