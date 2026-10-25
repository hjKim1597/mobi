import { isBase64, outputAudioSchema } from './schemas';

export class AudioInputError extends Error {}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export function base64ToBytes(data: string, maxBytes = 270_000): Uint8Array {
  if (data.length > Math.ceil(maxBytes / 3) * 4) throw new AudioInputError('Audio too large');
  let decoded: string;
  try { decoded = atob(data); } catch { throw new AudioInputError('Invalid base64'); }
  if (decoded.length > maxBytes) throw new AudioInputError('Audio too large');
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}

type WavInfo = { offset: number; size: number; sampleRate: number; channels: number; bits: number; format: number };

// The container has no checksum over PCM data. Validate its complete chunk map
// using bounded header reads; TTS does not need to decode every audio sample.
function inspectWavHeaders(length: number, read: (offset: number, count: number) => Uint8Array): WavInfo {
  const invalid = () => { throw new AudioInputError('Invalid WAV'); };
  const tag = (bytes: Uint8Array, at = 0) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (length < 44) invalid();
  const header = read(0, 12);
  if (tag(header) !== 'RIFF' || tag(header, 8) !== 'WAVE' || new DataView(header.buffer, header.byteOffset, 12).getUint32(4, true) + 8 !== length) invalid();
  let fmt: Omit<WavInfo, 'offset' | 'size'> | undefined;
  let data: { offset: number; size: number } | undefined;
  let at = 12;
  while (at < length) {
    if (at + 8 > length) invalid();
    const chunk = read(at, 8), name = tag(chunk);
    const size = new DataView(chunk.buffer, chunk.byteOffset, 8).getUint32(4, true), start = at + 8, end = start + size;
    if (end + (size % 2) > length) invalid();
    if (name === 'fmt ') {
      if (fmt || size < 16) invalid();
      const bytes = read(start, 16), view = new DataView(bytes.buffer, bytes.byteOffset, 16);
      const format = view.getUint16(0, true), channels = view.getUint16(2, true);
      const sampleRate = view.getUint32(4, true), bits = view.getUint16(14, true);
      if (format !== 1 || channels < 1 || sampleRate < 1 || bits !== 16 ||
          view.getUint16(12, true) !== channels * bits / 8 || view.getUint32(8, true) !== sampleRate * channels * bits / 8) invalid();
      fmt = { format, channels, sampleRate, bits };
    } else if (name === 'data') {
      if (data || size === 0 || size % 2 !== 0) invalid();
      data = { offset: start, size };
    }
    at = end + (size % 2);
  }
  if (!fmt || !data || data.size % (fmt.channels * 2)) invalid();
  return { ...fmt!, ...data! };
}

export function inspectWav(bytes: Uint8Array): WavInfo {
  return inspectWavHeaders(bytes.length, (offset, count) => bytes.subarray(offset, offset + count));
}

export function inspectBase64Wav(data: string, maxBytes = 2 * 1024 * 1024): WavInfo {
  if (!isBase64(data)) throw new AudioInputError('Invalid audio base64');
  return inspectBase64WavHeaders(data, maxBytes);
}

function inspectBase64WavHeaders(data: string, maxBytes: number): WavInfo {
  if (!data.length || data.length % 4 || data.length > Math.ceil(maxBytes / 3) * 4) throw new AudioInputError('Invalid audio base64');
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const length = data.length / 4 * 3 - padding;
  if (length > maxBytes) throw new AudioInputError('Audio too large');
  return inspectWavHeaders(length, (offset, count) => {
    const start = Math.floor(offset / 3) * 3;
    const bytes = base64ToBytes(data.slice(start / 3 * 4, Math.ceil((offset + count) / 3) * 4), count + 5);
    return bytes.subarray(offset - start, offset - start + count);
  });
}

export function inspectPcmWav(data: string): { rmsDb: number; activeRatio: number; durationMs: number } {
  const bytes = base64ToBytes(data);
  try {
    const info = inspectWav(bytes);
    if (info.channels !== 1 || info.sampleRate !== 16_000 || info.size > 256_000) throw new AudioInputError('Expected at most eight seconds PCM16 16kHz mono WAV');
    const view = new DataView(bytes.buffer);
    let sum = 0, active = 0, frames = 0;
    for (let at = info.offset; at < info.offset + info.size; at += 640) {
      const end = Math.min(at + 640, info.offset + info.size);
      let energy = 0;
      for (let j = at; j < end; j += 2) { const x = view.getInt16(j, true) / 32768; energy += x * x; }
      sum += energy; frames++;
      if (Math.sqrt(energy / ((end - at) / 2)) > 0.00562) active++;
    }
    return { rmsDb: 20 * Math.log10(Math.sqrt(sum / (info.size / 2)) || 1e-12), activeRatio: active / frames, durationMs: info.size / 32 };
  } finally { bytes.fill(0); }
}

export async function readAudioResponse(response: Response, signal: AbortSignal): Promise<{ data: string; mimeType: 'audio/wav' }> {
  const decodedCap = 2 * 1024 * 1024;
  const jsonAudio = response.headers.get('Content-Type')?.split(';')[0].trim() === 'application/json';
  const maxBytes = jsonAudio ? Math.ceil(decodedCap / 3) * 4 + 128 : decodedCap;
  if (!response.ok || !response.body || Number(response.headers.get('Content-Length')) > maxBytes) throw Error('Invalid TTS response');
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (signal.aborted) throw Error('Aborted');
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw Error('Aborted');
      if (done) break;
      size += value.length; if (size > maxBytes) throw Error('TTS response too large'); chunks.push(value);
    }
    const bytes = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    if (jsonAudio) {
      const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!payload || typeof payload !== 'object' || !('audio' in payload) || typeof payload.audio !== 'string') throw Error('Missing TTS audio');
      const audio = outputAudioSchema.parse({ data: payload.audio, mimeType: 'audio/wav' });
      inspectBase64WavHeaders(audio.data, decodedCap);
      return audio;
    }
    inspectWav(bytes);
    return outputAudioSchema.parse({ data: bytesToBase64(bytes), mimeType: 'audio/wav' });
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); }
}
