import { describe, expect, it } from 'vitest';
import { calendarUnavailableAsset as asset, calendarUnavailableSentence as sentence } from '../src/calendar-unavailable-audio';
import { base64ToBytes, inspectBase64Wav } from '../src/audio';

describe('bundled calendar refusal speech', () => {
  it('ships the fixed sentence with MeloTTS provenance and the normal wire shape', () => {
    expect(asset).toMatchObject({ model: '@cf/myshell-ai/melotts', lang: 'kr', version: 'calendar-unavailable-v2',
      text: '지금은 일정을 추가할 수 없어요.', sourceSampleRate: 44100,
      resample: 'ffmpeg libswresample (filter_size=64, cutoff=0.95): mono PCM16, 44100 Hz to 16000 Hz' });
    expect(asset.sourceSha256).toBe('1e73c220cd965786fe5ca0930d28ac68cfff453115ae5e6e32f5b3719d54cfcc');
    expect(sentence).toEqual({ text: asset.text, audio: { data: asset.data, mimeType: 'audio/wav' } });
  });

  it('matches the recorded SHA-256 and validated PCM16 mono WAV metadata', async () => {
    const info = inspectBase64Wav(asset.data);
    expect(info).toMatchObject({ channels: 1, bits: 16, sampleRate: 16000 });
    expect(info.sampleRate).toBe(asset.sampleRate);
    expect(info.size).toBeLessThan(298342 * 0.4);
    const digest = await crypto.subtle.digest('SHA-256', base64ToBytes(asset.data, 2 * 1024 * 1024));
    expect(Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')).toBe(asset.sha256);
  });
});
