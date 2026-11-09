import { describe, expect, it } from 'vitest';
import * as embedded from '../src/action-handoff-audio';
import { base64ToBytes, inspectBase64Wav } from '../src/audio';

type Asset = { model: string; lang: string; version: string; text: string; data: string; sha256: string; sampleRate: number;
  sourceSha256: string; sourceSampleRate: number; resample: string };
const asset = () => (embedded as unknown as { actionHandoffAsset?: Asset }).actionHandoffAsset;

describe('shipped calendar handoff speech', () => {
  it('has MeloTTS provenance and keeps the existing sentence wire shape', () => {
    expect(asset()?.model).toBe('@cf/myshell-ai/melotts');
    expect(asset()?.lang).toBe('kr');
    expect(asset()?.version).toBe('action-handoff-v2');
    expect(asset()).toMatchObject({ sourceSampleRate: 44100,
      resample: 'ffmpeg libswresample (filter_size=64, cutoff=0.95): mono PCM16, 44100 Hz to 16000 Hz' });
    expect(asset()?.sourceSha256).toBe('cf2e903e7315705795375668acd11171001c35c59c15199987dac67525c4ef78');
    expect(embedded.actionHandoffSentence).toEqual({ text: '일정 내용을 확인할게요.',
      audio: { data: asset()?.data, mimeType: 'audio/wav' } });
  });

  it('matches its recorded SHA-256 and validated PCM16 WAV metadata', async () => {
    const value = asset();
    expect(value).toBeDefined();
    if (!value) return;
    const info = inspectBase64Wav(value.data);
    expect(info).toMatchObject({ channels: 1, bits: 16, sampleRate: 16000 });
    expect(info.sampleRate).toBe(value.sampleRate);
    expect(info.size).toBeLessThan(253286 * 0.4);
    const digest = await crypto.subtle.digest('SHA-256', base64ToBytes(value.data, 2 * 1024 * 1024));
    expect(Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')).toBe(value.sha256);
  });
});
