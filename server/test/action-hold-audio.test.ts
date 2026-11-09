import { describe, expect, it } from 'vitest';
import { actionHoldAsset as asset, actionHoldSentence as sentence } from '../src/action-hold-audio';
import { base64ToBytes, inspectBase64Wav } from '../src/audio';
import { holdAudioDurationMs } from '../src/action-http';

describe('bundled hold cancellation announcement', () => {
  it('ships the exact fixed sentence with real MeloTTS resampling provenance', () => {
    expect(asset).toMatchObject({ model: '@cf/myshell-ai/melotts', lang: 'kr', version: 'action-hold-v1',
      text: "취소하려면 '취소'라고 말씀하세요.", sampleRate: 16000, sourceSampleRate: 44100,
      resample: 'ffmpeg libswresample (filter_size=64, cutoff=0.95): mono PCM16, 44100 Hz to 16000 Hz' });
    expect(asset.sourceSha256).toBe('401b9157e707d3c652f5dd0c81f191c459ba5b68f61655e32b408ce0894e9aad');
    expect(asset.sha256).toBe('efafca4f52cfa42a83bf3d18737aca534e3ef748e958050f664c4b3b47a554f4');
    expect(sentence).toEqual({ text: asset.text, audio: { data: asset.data, mimeType: 'audio/wav' } });
  });
  it('verifies the embedded WAV digest and computes holdAudioMs from real PCM frames', async () => {
    const wav = inspectBase64Wav(asset.data);
    expect(wav).toMatchObject({ channels: 1, bits: 16, sampleRate: 16000 });
    expect(wav.size).toBeGreaterThan(32000);
    expect(wav.size).toBeLessThan(32000 * 5);
    expect(holdAudioDurationMs(sentence)).toBe(Math.ceil(wav.size / 32));
    const digest = await crypto.subtle.digest('SHA-256', base64ToBytes(asset.data, 2 * 1024 * 1024));
    expect(Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')).toBe(asset.sha256);
  });
  it('keeps the bundled audio payload substantially smaller than 44.1 kHz PCM', () => {
    const wav = inspectBase64Wav(asset.data);
    const payload = new TextEncoder().encode(JSON.stringify({ holdSentences: [sentence] })).length;
    const sourcePcmBytes = wav.size * 44100 / 16000;
    expect(payload).toBeLessThan(sourcePcmBytes * 4 / 3 * 0.4);
    expect(payload).toBeLessThan(180000);
  });
});
