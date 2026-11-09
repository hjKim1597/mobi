import { describe, expect, it } from 'vitest';
import { actionWordingAssets, actionWordingSentences } from '../src/action-wording-audio';
import { base64ToBytes, inspectBase64Wav } from '../src/audio';
import { renderActionWordingSource, validateActionWordingSource } from '../scripts/action-wording-source-format.mjs';

const expected = {
  not_written_reply: '보내지 않았어요.',
  not_written_calendar: '일정을 추가하지 않았어요.',
  failed_reply: '보내지 못했어요.',
  failed_calendar: '일정을 추가하지 못했어요.',
  unknown_calendar: '처리 결과를 확인하지 못했어요. 중복을 막기 위해 다시 추가하지 않을게요.',
  offer_reply: '회신 내용을 작성할까요?',
  offer_calendar: '일정 내용을 확인할까요?',
};

describe('stage-specific fixed action wording assets', () => {
  it('round-trips emitted source and rejects wrong text, model, hash, rate and provenance without inference', () => {
    const assets = Object.fromEntries(Object.entries(expected).map(([id, text], index) => [id, {
      model: '@cf/myshell-ai/melotts', lang: 'kr', version: 'action-wording-v1', text, data: 'synthetic-fixture',
      sha256: String(index + 1).repeat(64), sampleRate: 16000, sourceAttempt: 1, sourceSha256: String(index + 2).repeat(64),
      sourceSampleRate: 44100,
      resample: 'ffmpeg libswresample (filter_size=64, cutoff=0.95): mono PCM16, 44100 Hz to 16000 Hz',
    }]));
    const rendered = renderActionWordingSource(assets);
    expect(validateActionWordingSource(rendered, expected)).toEqual(assets);
    for (const wrong of [
      { model: 'macOS Yuna' }, { lang: 'en' }, { version: 'other' }, { text: 'wrong sentence' },
      { sha256: 'x'.repeat(64) }, { sourceSha256: 'x'.repeat(64) }, { sampleRate: 44100 },
      { sourceSampleRate: 48000 }, { resample: 'unknown' },
    ]) {
      const changed = { ...assets, not_written_reply: { ...assets.not_written_reply, ...wrong } };
      expect(() => validateActionWordingSource(renderActionWordingSource(changed), expected)).toThrow();
    }
    expect(() => validateActionWordingSource(rendered.replace('Model:', 'Missing:'), expected)).toThrow();
  });

  it('ships the seven server sentences with MeloTTS provenance and matching wire sentences', async () => {
    expect(Object.keys(actionWordingAssets).sort()).toEqual(Object.keys(expected).sort());
    expect(actionWordingSentences.map(sentence => sentence.text)).toEqual(Object.values(expected));
    for (const [id, text] of Object.entries(expected) as Array<[keyof typeof actionWordingAssets, string]>) {
      const asset = actionWordingAssets[id];
      expect(asset).toMatchObject({ model: '@cf/myshell-ai/melotts', lang: 'kr', text,
        sampleRate: 16000, sourceSampleRate: 44100 });
      expect([1, 2]).toContain(asset.sourceAttempt);
      expect(asset.version).toBe('action-wording-v1');
      expect(asset.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
      const bytes = base64ToBytes(asset.data, 2 * 1024 * 1024);
      expect(inspectBase64Wav(asset.data)).toMatchObject({ channels: 1, bits: 16, sampleRate: 16000 });
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      expect(Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')).toBe(asset.sha256);
    }
    expect(actionWordingSentences).toEqual(Object.values(expected).map((text, i) => ({ text,
      audio: { data: actionWordingAssets[(Object.keys(expected) as Array<keyof typeof actionWordingAssets>)[i]].data, mimeType: 'audio/wav' } })));
  });
});
