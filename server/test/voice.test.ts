import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectPcmWav, bytesToBase64 } from '../src/audio';
import { withDeadline, createVoiceDeadline } from '../src/deadline';
import { matchClosedSet, REPLIES, transcribe, synthesize, buildBriefing, handleConfirm } from '../src/voice';
import { WorkersAiLlmProvider, contentDelta, speechSentence } from '../src/llm';
import type { TodayCalendar } from '../src/calendar';

function wav(samples = 320, amplitude = 0): Uint8Array {
  const bytes = new Uint8Array(44 + samples * 2), v = new DataView(bytes.buffer);
  const put = (i: number, s: string) => [...s].forEach((c, j) => { bytes[i + j] = c.charCodeAt(0); });
  put(0, 'RIFF'); v.setUint32(4, bytes.length - 8, true); put(8, 'WAVE'); put(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  put(36, 'data'); v.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) v.setInt16(44 + i * 2, i % 2 ? amplitude : -amplitude, true);
  return bytes;
}
const calendar: TodayCalendar = { date: '2026-10-24', timeZone: 'Asia/Seoul', events: [1, 2, 3].map(i => ({
  id: String(i), title: `회의${i}`, start: { dateTime: `2026-10-24T0${i}:00:00Z` }, end: { dateTime: `2026-10-24T0${i}:30:00Z` },
})) };
const fakeAi = (run: (...args: any[]) => unknown) => ({ run: vi.fn(run) }) as unknown as Ai;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('voice stage hedges', () => {
  const audio = { data: bytesToBase64(wav(320, 2000)), mimeType: 'audio/wav' as const };
  const freshAudio = () => ({ ...audio });
  const later = <T>(ms: number, value: T, fail = false) => new Promise<T>((resolve, reject) => setTimeout(() => fail ? reject(Error('upstream')) : resolve(value), ms));
  it('hedges confirm at 1400ms, reserving before first-valid fallback wins', async () => {
    vi.useFakeTimers(); const reserve = vi.fn(), observe = vi.fn();
    const ai = fakeAi((model: string) => later(model.endsWith('turbo') ? 3000 : 100, { text: model.endsWith('turbo') ? '아니' : '보내' }));
    const pending = handleConfirm(ai, freshAudio(), Date.now() + 4800, { reserve, observe });
    await vi.advanceTimersByTimeAsync(1399); expect(ai.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(ai.run).toHaveBeenCalledTimes(2);
    expect((ai.run as any).mock.calls[1]).toMatchObject(['@cf/openai/whisper', { audio: Array.from(wav(320, 2000)) }]);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ transcript: '보내', match: { action: 'SEND', mode: 'exact' } });
    expect(reserve.mock.calls.map(x => x.slice(0, 2))).toEqual([['stt', 'primary'], ['stt', 'hedge']]);
    expect(observe).toHaveBeenLastCalledWith('stt', { hedged: true, winner: 'hedge' });
    await vi.advanceTimersByTimeAsync(1500);
  });
  it.each(['보내요', '바꿔요', '보내줘요', '바꿔줘요', '감사합니다 보내'])('keeps fallback confirm safe for %s', async text => {
    vi.useFakeTimers(); const ai = fakeAi((model: string) => later(model.endsWith('turbo') ? 4000 : 10, { text }));
    const pending = handleConfirm(ai, freshAudio(), Date.now() + 4800);
    await vi.advanceTimersByTimeAsync(2010);
    expect(['SEND', 'CHANGE']).not.toContain((await pending).match.action);
    await vi.advanceTimersByTimeAsync(1990);
  });
  it('returns the primary after a hedge starts, handles a late losing rejection, and tracks its lifetime', async () => {
    vi.useFakeTimers(); const work: Promise<unknown>[] = [], observe = vi.fn(); let hedgePayload: { audio: number[] } | undefined;
    const ai = fakeAi((model: string, payload: { audio: number[] }) => {
      if (!model.endsWith('turbo')) hedgePayload = payload;
      return later(model.endsWith('turbo') ? 1500 : 300, { text: '네' }, !model.endsWith('turbo'));
    });
    const pending = handleConfirm(ai, freshAudio(), Date.now() + 4800, { defer: p => work.push(p), observe });
    await vi.advanceTimersByTimeAsync(1500); expect((await pending).transcript).toBe('네');
    expect(hedgePayload?.audio.some(value => value !== 0)).toBe(true);
    expect(observe).toHaveBeenLastCalledWith('stt', { hedged: true, winner: 'primary' });
    await vi.advanceTimersByTimeAsync(200); await Promise.all(work);
    expect(hedgePayload?.audio.every(value => value === 0)).toBe(true);
    expect(work).toHaveLength(2);
  });
  it('releases the request audio after STT while keeping a losing inference input intact until it settles', async () => {
    vi.useFakeTimers(); const work: Promise<unknown>[] = [];
    const requestAudio = freshAudio();
    let primaryPayload: any;
    const ai = fakeAi((model: string, payload: any) => {
      if (model.endsWith('turbo')) { primaryPayload = payload; return later(3000, { text: '아니' }); }
      return later(100, { text: '응' });
    });
    const pending = handleConfirm(ai, requestAudio, Date.now() + 4800, { defer: p => work.push(p) });
    await vi.advanceTimersByTimeAsync(1500);
    expect((await pending).transcript).toBe('응');
    expect(requestAudio.data).toBe('');
    expect(primaryPayload.audio).toBe(audio.data);
    await vi.advanceTimersByTimeAsync(1500);
    await Promise.all(work);
  });
  it('releases request audio when validation or the STT deadline fails', async () => {
    const malformed = { data: 'bad', mimeType: 'audio/wav' as const };
    await expect(handleConfirm(fakeAi(() => ({ text: '네' })), malformed, Date.now() + 1000)).rejects.toThrow();
    expect(malformed.data).toBe('');

    vi.useFakeTimers(); const requestAudio = freshAudio();
    const pending = handleConfirm(fakeAi(() => new Promise<never>(() => {})), requestAudio, Date.now() + 1000);
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(requestAudio.data).toBe('');
  });
  it('does not let a losing hedge start after its reservation finishes past the primary winner', async () => {
    vi.useFakeTimers(); const requestAudio = freshAudio();
    const reserve = vi.fn((_stage: string, call: string) => call === 'hedge' ? later(200, undefined) : undefined);
    const ai = fakeAi((model: string) => later(model.endsWith('turbo') ? 1500 : 10, { text: '네' }));
    const pending = handleConfirm(ai, requestAudio, Date.now() + 4800, { reserve });
    await vi.advanceTimersByTimeAsync(1500);
    expect((await pending).transcript).toBe('네');
    expect(requestAudio.data).toBe('');
    await vi.advanceTimersByTimeAsync(200);
    expect(ai.run).toHaveBeenCalledTimes(1);
  });
  it('does not hedge when the remaining time cannot fit STT p50', async () => {
    vi.useFakeTimers(); const ai = fakeAi(() => later(2500, { text: '네' }));
    const pending = handleConfirm(ai, freshAudio(), Date.now() + 3400);
    await vi.advanceTimersByTimeAsync(2500); expect((await pending).transcript).toBe('네'); expect(ai.run).toHaveBeenCalledTimes(1);
  });
  it('does not start a call denied by the reservation hook', async () => {
    const ai = fakeAi(() => ({ text: '네' }));
    await expect(handleConfirm(ai, freshAudio(), Date.now() + 1000, { reserve: () => { throw Error('quota'); } })).rejects.toThrow('quota');
    expect(ai.run).not.toHaveBeenCalled();
  });
  it('rechecks p50 headroom after a slow hedge reservation before starting inference', async () => {
    vi.useFakeTimers(); const ai = fakeAi(() => later(3000, { text: '네' }));
    const pending = handleConfirm(ai, freshAudio(), Date.now() + 3500, { reserve: (_stage, call) => call === 'hedge' ? later(150, undefined) : undefined });
    await vi.advanceTimersByTimeAsync(3000);
    expect((await pending).transcript).toBe('네'); expect(ai.run).toHaveBeenCalledTimes(1);
  });
  it('requires the measured full TTS p50 including body validation before hedging', async () => {
    vi.useFakeTimers(); const ai = fakeAi(() => later(1200, new Response(wav())));
    const pending = synthesize(ai, '안녕.', Date.now() + 1300);
    await vi.advanceTimersByTimeAsync(1200); expect((await pending).audio.mimeType).toBe('audio/wav');
    expect(ai.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600);
  });
  it('allows a valid hedge to beat malformed LLM output with identical inputs', async () => {
    vi.useFakeTimers(); let calls = 0; const observe = vi.fn();
    const ai = fakeAi(() => later(++calls === 1 ? 700 : 80, { response: calls === 1 ? 'bad json' : JSON.stringify({ tool: 'decline', sentence: '네.' }) }));
    const pending = new WorkersAiLlmProvider(ai, { observe }).respond({ transcript: '조용히', calendar }, Date.now() + 4800);
    await vi.advanceTimersByTimeAsync(730); expect((await pending).text).toBe('지금은 조용히 있을게요.');
    expect((ai.run as any).mock.calls[0]).toEqual((ai.run as any).mock.calls[1]);
    expect(observe).toHaveBeenLastCalledWith('llm', { hedged: true, winner: 'hedge' });
  });
  it('lets only validated TTS audio win and cancels a late losing body', async () => {
    vi.useFakeTimers(); let calls = 0; const cancel = vi.fn(), observe = vi.fn();
    const ai = fakeAi(() => ++calls === 1 ? later(1000, new Response(new ReadableStream({ cancel }))) : later(10, new Response(wav())));
    const pending = synthesize(ai, '안녕.', Date.now() + 4800, { observe });
    await vi.advanceTimersByTimeAsync(610); expect((await pending).audio.mimeType).toBe('audio/wav');
    expect(observe).toHaveBeenLastCalledWith('tts', { hedged: true, winner: 'hedge' });
    await vi.advanceTimersByTimeAsync(390); expect(cancel).toHaveBeenCalledOnce();
  });
  it('rejects when both calls are invalid and never starts a third attempt', async () => {
    vi.useFakeTimers(); const ai = fakeAi(() => later(10, { wrong: true }));
    const pending = handleConfirm(ai, freshAudio(), Date.now() + 4800); const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(2010); await rejected; expect(ai.run).toHaveBeenCalledTimes(2);
  });
});

describe('PCM audio guards', () => {
  it('measures silence, voiced frames, and the exact eight-second cap', () => {
    expect(inspectPcmWav(bytesToBase64(wav()))).toMatchObject({ activeRatio: 0, durationMs: 20 });
    expect(inspectPcmWav(bytesToBase64(wav(128000, 1000)))).toMatchObject({ activeRatio: 1, durationMs: 8000 });
    expect(() => inspectPcmWav(bytesToBase64(wav(128001)))).toThrow();
    expect(() => inspectPcmWav(bytesToBase64(wav(0)))).toThrow();
  });
  it.each([[20, 3, 2], [22, 2, 2], [24, 8000, 4], [28, 1, 4], [32, 4, 2], [34, 32, 2], [40, 641, 4], [4, 99999, 4]])('rejects corrupt or unsupported header at %s', (offset, value, width) => {
    const bytes = wav(); const v = new DataView(bytes.buffer);
    if (width === 2) v.setUint16(offset, value, true); else v.setUint32(offset, value, true);
    expect(() => inspectPcmWav(bytesToBase64(bytes))).toThrow();
  });
  it('accepts padded extension chunks and rejects duplicate data and truncation', () => {
    const base = wav(); const bytes = new Uint8Array(base.length + 10);
    bytes.set(base.subarray(0, 36)); bytes.set(new TextEncoder().encode('JUNK'), 36);
    new DataView(bytes.buffer).setUint32(40, 1, true); bytes.set(base.subarray(36), 46);
    new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
    expect(inspectPcmWav(bytesToBase64(bytes)).durationMs).toBe(20);
    expect(() => inspectPcmWav(bytesToBase64(bytes.subarray(0, -1)))).toThrow();
    const duplicate = new Uint8Array(base.length + 10); duplicate.set(base);
    duplicate.set(new TextEncoder().encode('data'), base.length); const v = new DataView(duplicate.buffer);
    v.setUint32(4, duplicate.length - 8, true); v.setUint32(base.length + 4, 2, true);
    expect(() => inspectPcmWav(bytesToBase64(duplicate))).toThrow();
  });
  it('does not call STT below RMS or active-ratio floor', async () => {
    const ai = fakeAi(() => { throw Error('must not call AI'); });
    for (const amplitude of [0, 164]) expect(await transcribe(ai, { data: bytesToBase64(wav(16000, amplitude)), mimeType: 'audio/wav' }, 'confirm', Date.now() + 1000)).toBe('');
    const bytes = wav(32000); const v = new DataView(bytes.buffer);
    for (let i = 0; i < 1600; i++) v.setInt16(44 + i * 2, 5000, true);
    expect(inspectPcmWav(bytesToBase64(bytes)).activeRatio).toBe(0.05);
    expect(await transcribe(ai, { data: bytesToBase64(bytes), mimeType: 'audio/wav' }, 'turn', Date.now() + 1000)).toBe('');
  });
  it('uses the binding model/options/hint and suppresses the whole hallucinated transcript', async () => {
    const calls: any[][] = []; const ai = fakeAi((...args) => { calls.push(args); return { text: '보내. 다음 영상 자막' }; });
    expect(await transcribe(ai, { data: bytesToBase64(wav(320, 1000)), mimeType: 'audio/wav' }, 'confirm', Date.now() + 1000)).toBe('');
    expect(calls[0][0]).toBe('@cf/openai/whisper-large-v3-turbo');
    expect(calls[0][1]).toMatchObject({ language: 'ko', task: 'transcribe', vad_filter: true, condition_on_previous_text: false,
      initial_prompt: '짧은 한국어 확인 응답입니다. 가능한 응답: ' + REPLIES.join('. ') + '.' });
  });
});

describe('closed-set regression', () => {
  it.each(['보내', '보내줘', '바꿔', '바꿔줘'])('accepts only the full normalized write %s', text => {
    expect(matchClosedSet(text + ' .')).toMatchObject({ label: text, mode: 'exact', action: text.startsWith('보내') ? 'SEND' : 'CHANGE' });
  });
  it.each(['보네', '보내요', '보내죠', '보내줘요', '아쿠어', '바꿔요', '바꿔줘요', '응', '네', '보내지 마', '바꾸지 마', '보내 취소', 'send', '많이 해줘'])('never infers an outbound action from %s', text => {
    expect(['SEND', 'CHANGE']).not.toContain(matchClosedSet(text).action);
  });
  it('preserves all 20 normalized labels, cancellation, safe fuzzy, and ambiguity', () => {
    expect(REPLIES).toHaveLength(20);
    for (const label of REPLIES) expect(matchClosedSet(label + ' .')).toMatchObject({ label, mode: 'exact' });
    expect(matchClosedSet('보내지 마').action).toBe('CANCEL');
    expect(matchClosedSet('들러줘')).toMatchObject({ label: '들려줘', mode: 'fuzzy-safe' });
    expect(matchClosedSet('')).toEqual({ label: 'NONE', action: 'NOT_NOW', mode: 'none' });
    for (const label of REPLIES.filter(t => !['SEND', 'CHANGE'].includes(matchClosedSet(t).action))) {
      const clean = label.replaceAll(' ', '');
      for (let i = 0; i < clean.length; i++) for (const variant of [clean.slice(0, i) + clean.slice(i + 1), clean.slice(0, i) + '가' + clean.slice(i + 1)]) {
        const match = matchClosedSet(variant);
        if (['SEND', 'CHANGE'].includes(match.action)) expect(match.mode).toBe('exact');
      }
    }
  });
});

describe('absolute deadline', () => {
  it('races noncooperative work, aborts, and never starts expired work', async () => {
    vi.useFakeTimers(); let signal!: AbortSignal;
    const pending = withDeadline(Date.now() + 40, async s => { signal = s; return new Promise(() => {}); });
    const rejected = expect(pending).rejects.toThrow(); await vi.advanceTimersByTimeAsync(40); await rejected;
    expect(signal.aborted).toBe(true);
    const operation = vi.fn(); await expect(withDeadline(Date.now() - 1, operation)).rejects.toThrow(); expect(operation).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reserves client time and disposes its timer', () => {
    vi.useFakeTimers(); const start = Date.now(), d = createVoiceDeadline(start);
    expect(d.deadlineAt).toBe(start + 4800); expect(d.remainingMs()).toBe(4800); d.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects a late resolution without an unhandled rejection', async () => {
    vi.useFakeTimers(); let resolve!: (v: number) => void;
    const work = withDeadline(Date.now() + 10, async () => new Promise<number>(r => { resolve = r; }));
    const result = expect(work).rejects.toThrow(); await vi.advanceTimersByTimeAsync(10); await result; resolve(1); await Promise.resolve();
  });
});

describe('provider and briefing regression', () => {
  it('prefers canonical deltas and never includes reasoning', () => {
    expect(contentDelta({ choices: [{ delta: { content: '":"' } }], response: ':' })).toBe('\":\"');
    expect(contentDelta({ choices: [{ delta: { reasoning_content: 'secret' } }] })).toBe('');
  });
  it('keeps one sanitized sentence under the conservative speech cap', () => {
    expect(speechSentence('안녕하세요. 두 번째 문장.')).toBe('안녕하세요.');
    expect(speechSentence('가'.repeat(21))).toBe('정차하면 카드로 보여드릴게요.');
    expect(speechSentence('✅')).toBe('정차하면 카드로 보여드릴게요.');
  });
  it('parses UTF-8/chunk boundaries and normalizes only calendar tool calls', async () => {
    const payload = JSON.stringify({ tool: 'calendar_today', sentence: '오늘 일정은 세 개예요.' });
    const wire = new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'hidden' } }] }) + '\r\n' +
      'data: ' + JSON.stringify({ choices: [{ delta: { content: payload } }] }) + '\r\ndata: [DONE]\r\n');
    const ai = fakeAi(() => new ReadableStream({ start(c) { for (const byte of wire) c.enqueue(Uint8Array.of(byte)); c.close(); } }));
    const result = await new WorkersAiLlmProvider(ai).respond({ transcript: '오늘 일정', calendar }, Date.now() + 1000);
    expect(result.text).toBe('오늘 일정은 세 개예요.');
    expect(result.toolCalls).toEqual([{ id: expect.any(String), name: 'calendar_today', arguments: {} }]);
    expect((ai.run as any).mock.calls[0]).toMatchObject(['@cf/openai/gpt-oss-20b', { reasoning_effort: 'low', max_tokens: 128, stream: false, temperature: 0 }, { returnRawResponse: true }]);
  });
  it.each(['mail_send', 'calendar_apply_change', 'unknown'])('rejects unsupported tool %s instead of executing it', async tool => {
    const ai = fakeAi(() => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ tool, sentence: '보내요.' }) } }] }) + '\n')); c.close(); } }));
    await expect(new WorkersAiLlmProvider(ai).respond({ transcript: '보내', calendar }, Date.now() + 1000)).rejects.toThrow();
  });
  it.each([[180, 'short', 1], [600, 'summary', 2], [1800, 'full', 4], [null, 'summary', 2], [299, 'short', 1], [300, 'summary', 2], [899, 'summary', 2], [900, 'full', 4]] as const)('uses seconds and correct sentence count for %s', (seconds, bucket, sentences) => {
    const b = buildBriefing(calendar, seconds); expect(b.bucket).toBe(bucket); expect(b.text.match(/[.?!]/g)).toHaveLength(sentences);
    if (bucket === 'full') for (const e of calendar.events) expect(b.text).toContain(e.title);
    if (bucket !== 'short') expect(b.text).toContain('10:00');
  });
});


describe('upstream audio failures', () => {
  it('rejects malformed or oversized TTS bytes as processing failures, not input errors', async () => {
    const ai = fakeAi(() => new Response('not a wav'));
    await expect(synthesize(ai, '안녕하세요.', Date.now() + 1000)).rejects.not.toBeInstanceOf((await import('../src/audio')).AudioInputError);
  });
  it('cancels a hanging model stream at the same absolute deadline', async () => {
    vi.useFakeTimers(); let cancelled = false;
    const ai = fakeAi(() => new ReadableStream({ cancel() { cancelled = true; } }));
    const pending = new WorkersAiLlmProvider(ai).respond({ transcript: '일정', calendar }, Date.now() + 10);
    const rejected = expect(pending).rejects.toThrow(); await vi.advanceTimersByTimeAsync(10); await rejected;
    expect(cancelled).toBe(true);
  });
  it('accepts a full 8-second input without a regex stack overflow', async () => {
    const { requestSchemas } = await import('../src/schemas');
    expect(requestSchemas.confirm.safeParse({ audio: { data: bytesToBase64(wav(128000, 1000)), mimeType: 'audio/wav' } }).success).toBe(true);
  });
});


describe('guard threshold boundaries', () => {
  it('requires both RMS and six percent active frames', async () => {
    const ai = fakeAi(() => ({ text: '응' }));
    const audio = (amplitude: number) => ({ data: bytesToBase64(wav(320, amplitude)), mimeType: 'audio/wav' as const });
    expect(await transcribe(ai, audio(184), 'confirm', Date.now() + 1000)).toBe('');
    expect(await transcribe(ai, audio(185), 'confirm', Date.now() + 1000)).toBe('응');
    const bytes = wav(32000), view = new DataView(bytes.buffer);
    for (let i = 0; i < 320 * 6; i++) view.setInt16(44 + i * 2, 5000, true);
    expect(inspectPcmWav(bytesToBase64(bytes)).activeRatio).toBe(0.06);
    expect(await transcribe(ai, { data: bytesToBase64(bytes), mimeType: 'audio/wav' }, 'confirm', Date.now() + 1000)).toBe('응');
  });
});

describe('nested deadline cancellation regression', () => {
  it('aborts the parent signal when a nested deadline wins the race', async () => {
    vi.useFakeTimers(); let parent!: AbortSignal;
    const pending = withDeadline(Date.now() + 50, async signal => {
      parent = signal;
      return withDeadline(Date.now() + 10, async () => new Promise(() => {}));
    });
    const rejected = expect(pending).rejects.toThrow(); await vi.advanceTimersByTimeAsync(10); await rejected;
    expect(parent.aborted).toBe(true);
  });
});

describe('test AI isolation', () => {
  it('replaces the configured AI binding with a failing local service', async () => {
    const { env } = await import('cloudflare:test');
    const response = await (env.AI as unknown as Fetcher).fetch('https://local.invalid/');
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Unmocked AI call');
  });
});

describe('measured MeloTTS provider envelope', () => {
  it('unwraps the real JSON audio field into WAV without changing the app response', async () => {
    const bytes = wav(320, 1000), data = bytesToBase64(bytes);
    const ai = fakeAi(() => Response.json({ audio: data }));
    expect(await synthesize(ai, '오늘 일정은 없어요.', Date.now() + 1000)).toEqual({
      text: '오늘 일정은 없어요.', audio: { data, mimeType: 'audio/wav' },
    });
  });
});

describe('generated knock asset integrity', () => {
  it('ships exactly five real WAVs with stable hashes, correct templates, and valid output schemas', async () => {
    const { knockAssets } = await import('../src/knock-audio');
    const { selectKnock } = await import('../src/knock');
    const { outputAudioSchema } = await import('../src/schemas');
    expect(Object.keys(knockAssets)).toHaveLength(5);
    for (const asset of Object.values(knockAssets)) {
      const bytes = Uint8Array.from(atob(asset.data), c => c.charCodeAt(0));
      expect(bytes.length).toBeGreaterThan(1000);
      expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('RIFF');
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      expect([...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('')).toBe(asset.sha256);
      expect(outputAudioSchema.safeParse({ data: asset.data, mimeType: 'audio/wav' }).success).toBe(true);
    }
    for (const n of [0, 1, 2, 100]) {
      const bundle = selectKnock(n, '2026-10-24', 'Asia/Seoul');
      expect(bundle.eventCount).toBe(n); expect(bundle.offline.text).not.toMatch(/[?？]|들을까요/);
      expect(selectKnock(n, '2026-10-24', 'Asia/Seoul')).toEqual(bundle);
    }
  });
});

describe('late TTS cleanup regression', () => {
  it('discards and cancels audio returned after the shared deadline', async () => {
    vi.useFakeTimers(); let resolve!: (response: Response) => void; let cancelled = false;
    const ai = fakeAi(() => new Promise<Response>(r => { resolve = r; }));
    const pending = synthesize(ai, '안녕하세요.', Date.now() + 10);
    const rejected = expect(pending).rejects.toThrow(); await vi.advanceTimersByTimeAsync(10); await rejected;
    resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled).toBe(true);
  });
});


describe('bounded base64 WAV container validation', () => {
  it('validates the same chunk map without decoding PCM samples', async () => {
    const { inspectWav, inspectBase64Wav } = await import('../src/audio');
    for (const count of [1, 320, 128000]) {
      const bytes = wav(count, 1000);
      expect(inspectBase64Wav(bytesToBase64(bytes))).toEqual(inspectWav(bytes));
    }
    const { knockAssets } = await import('../src/knock-audio');
    for (const asset of Object.values(knockAssets)) {
      const bytes = Uint8Array.from(atob(asset.data), c => c.charCodeAt(0));
      expect(inspectBase64Wav(asset.data)).toEqual(inspectWav(bytes));
    }
    for (const text of ['', '!!!!', 'AAAA=', bytesToBase64(wav()).slice(0, -4)]) expect(() => inspectBase64Wav(text)).toThrow();
    const bad = wav(); new DataView(bad.buffer).setUint32(40, 999999, true);
    expect(() => inspectBase64Wav(bytesToBase64(bad))).toThrow();
  });
});

describe('performance: independent voice stages', () => {
  it('starts Calendar and STT together and waits for both before the LLM', async () => {
    const { handleTurn } = await import('../src/voice');
    let resolveStt!: (value: unknown) => void, resolveCalendar!: (value: TodayCalendar) => void;
    let calendarStarted = false, sttStarted = false;
    const stt = new Promise(r => { resolveStt = r; });
    const calendarWork = new Promise<TodayCalendar>(r => { resolveCalendar = r; });
    const ai = fakeAi((model: string) => {
      if (model.includes('whisper')) { sttStarted = true; return stt; }
      return Response.json({ audio: bytesToBase64(wav(320, 1000)) });
    });
    const provider = { respond: vi.fn(async () => ({ text: '오늘 일정은 세 개예요.', toolCalls: [] })) };
    const turn = handleTurn({ tripId: 'parallel', audio: { data: bytesToBase64(wav(320, 1000)), mimeType: 'audio/wav' } }, {
      ai, deadlineAt: Date.now() + 4800, responseReadyAt: Date.now() + 3900, provider,
      readCalendar: () => { calendarStarted = true; return calendarWork; }, check: async () => {},
    });
    try {
      await vi.waitFor(() => expect(sttStarted).toBe(true));
      expect(calendarStarted).toBe(true);
      resolveStt({ text: '오늘 일정 알려줘.' });
      await Promise.resolve(); expect(provider.respond).not.toHaveBeenCalled();
    } finally { resolveStt({ text: '오늘 일정 알려줘.' }); resolveCalendar(calendar); await turn; }
    expect(provider.respond).toHaveBeenCalledTimes(1);
  });
  it('does not prefetch Calendar or call AI for genuinely silent input', async () => {
    const { handleTurn } = await import('../src/voice');
    const readCalendar = vi.fn(async () => calendar), ai = fakeAi(() => { throw Error('Unexpected AI'); });
    const result = await handleTurn({ tripId: 'silent', audio: { data: bytesToBase64(wav()), mimeType: 'audio/wav' } }, {
      ai, deadlineAt: Date.now() + 4800, responseReadyAt: Date.now() + 3900, readCalendar, check: async () => {},
    });
    expect(result.sentences).toEqual([]); expect(readCalendar).not.toHaveBeenCalled(); expect(ai.run).not.toHaveBeenCalled();
  });
  it('handles a rejected speculative Calendar request when STT is suppressed', async () => {
    const { handleTurn } = await import('../src/voice');
    const readCalendar = vi.fn(async () => { throw Error('Calendar failed'); });
    const result = await handleTurn({ tripId: 'guard', audio: { data: bytesToBase64(wav(320, 1000)), mimeType: 'audio/wav' } }, {
      ai: fakeAi(() => ({ text: '구독 좋아요' })), deadlineAt: Date.now() + 4800, responseReadyAt: Date.now() + 3900, readCalendar, check: async () => {},
    });
    expect(readCalendar).toHaveBeenCalledTimes(1); expect(result.sentences).toEqual([]);
  });
});

describe('performance: nonstream LLM boundary', () => {
  it('uses a low token budget and parses final content once without exposing reasoning', async () => {
    const wire = JSON.stringify({ tool: 'calendar_today', sentence: '오늘 일정은 세 개예요.' });
    const ai = fakeAi(() => Response.json({ choices: [{ message: { content: wire, reasoning_content: 'private reasoning' } }] }));
    const result = await new WorkersAiLlmProvider(ai).respond({ transcript: '오늘 일정', calendar }, Date.now() + 1000);
    expect(result.text).toBe('오늘 일정은 세 개예요.');
    expect((ai.run as any).mock.calls[0]).toMatchObject(['@cf/openai/gpt-oss-20b', { stream: false, max_tokens: 128, reasoning_effort: 'low' }, { returnRawResponse: true }]);
  });
  it.each(['string', 'object'])('normalizes the native response %s wrapper', async kind => {
    const wire = { tool: 'calendar_today', sentence: '오늘 일정은 세 개예요.' };
    const ai = fakeAi(() => Response.json({ response: kind === 'string' ? JSON.stringify(wire) : wire }));
    expect((await new WorkersAiLlmProvider(ai).respond({ transcript: '일정', calendar }, Date.now() + 1000)).toolCalls).toHaveLength(1);
  });
  it('rejects provider HTTP failures and reasoning-only responses', async () => {
    for (const response of [new Response('failure', { status: 503 }), Response.json({ choices: [{ message: { reasoning_content: 'private' } }] })]) {
      await expect(new WorkersAiLlmProvider(fakeAi(() => response)).respond({ transcript: '일정', calendar }, Date.now() + 1000)).rejects.toThrow();
    }
  });
});

describe('performance: audio trust boundary', () => {
  it('reuses an immutable validated audio object without accepting forged or mutated input', async () => {
    const { outputAudioSchema, turnResponseSchema } = await import('../src/schemas');
    const raw = { data: bytesToBase64(wav(320, 1000)), mimeType: 'audio/wav' };
    const checked = outputAudioSchema.parse(raw);
    expect(Object.isFrozen(checked)).toBe(true);
    expect(Object.isFrozen(raw)).toBe(false);
    expect(outputAudioSchema.parse(checked)).toBe(checked);
    const turn = turnResponseSchema.parse({ turnId: crypto.randomUUID(), transcript: '일정', sentences: [{ text: '일정이에요.', audio: checked }] });
    expect(turn.sentences[0].audio).toBe(checked);
    expect(() => { (checked as { data: string }).data = '!!!!'; }).toThrow();
    for (const value of [Object.freeze({ data: '!!!!', mimeType: 'audio/wav' }), { ...checked, data: 'AAAA=' },
      { ...checked, mimeType: 'audio/mpeg' }, { ...checked, extra: true }, { ...checked, data: 'AAAA'.repeat(699052) }]) {
      expect(outputAudioSchema.safeParse(value).success).toBe(false);
    }
  });
  it('keeps the original base64 grammar including padding and rejects bad bytes outside WAV headers', async () => {
    const { outputAudioSchema, requestSchemas } = await import('../src/schemas');
    const legacy = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
    const samples = ['AAAA', 'AA==', 'AAA=', 'AB==', 'AAA', 'A===', '=AAA', 'AA=A', 'AA!A', 'AAAA\\n', 'AAAA ', 'AAAAé', 'AAAA😀', 'AAAA===='];
    for (const data of samples) {
      const valid = data.length >= 4 && legacy.test(data);
      expect(requestSchemas.confirm.safeParse({ audio: { data, mimeType: 'audio/wav' } }).success).toBe(valid);
      expect(outputAudioSchema.safeParse({ data, mimeType: 'audio/wav' }).success).toBe(valid);
    }
    const bytes = bytesToBase64(wav(320, 1000));
    const bad = bytes.slice(0, 200) + '!!!!' + bytes.slice(204);
    await expect(synthesize(fakeAi(() => Response.json({ audio: bad })), '안녕하세요.', Date.now() + 1000)).rejects.toThrow();
  });
});

describe('base64 true-end regression', () => {
  it('rejects actual LF, CRLF, and Unicode line separators even at divisible-by-four lengths', async () => {
    const { isBase64, outputAudioSchema, requestSchemas } = await import('../src/schemas');
    for (const suffix of [String.fromCharCode(10), String.fromCharCode(13), String.fromCharCode(13, 10), String.fromCharCode(0x2028), String.fromCharCode(0x2029)]) {
      for (const prefix of ['AA', 'AAA', 'AAAA']) {
        const data = prefix + suffix;
        expect(isBase64(data)).toBe(false);
        expect(requestSchemas.confirm.safeParse({ audio: { data, mimeType: 'audio/wav' } }).success).toBe(false);
        expect(outputAudioSchema.safeParse({ data, mimeType: 'audio/wav' }).success).toBe(false);
      }
    }
  });
});

describe('speculative Calendar request lifetime', () => {
  it('registers unused prefetch work with the host instead of detaching an RPC', async () => {
    const { handleTurn } = await import('../src/voice');
    let finish!: (value: TodayCalendar) => void;
    const pending = new Promise<TodayCalendar>(r => { finish = r; });
    const background: Promise<unknown>[] = [];
    const defer = vi.fn((work: Promise<unknown>) => { background.push(work); });
    const turn = handleTurn({ tripId: 'lifetime', audio: { data: bytesToBase64(wav(320, 1000)), mimeType: 'audio/wav' } }, {
      ai: fakeAi(() => ({ text: '구독 좋아요' })), deadlineAt: Date.now() + 4800, responseReadyAt: Date.now() + 3900,
      readCalendar: () => pending, check: async () => {}, defer,
    });
    try {
      expect((await turn).sentences).toEqual([]);
      expect(defer).toHaveBeenCalledTimes(2); // Calendar prefetch and the STT binding call.
    } finally { finish(calendar); await Promise.all(background); }
  });
});

describe('stage timing instrumentation', () => {
  it('measures elapsed time through a hedged winner and reports only fixed metadata', async () => {
    vi.useFakeTimers(); const measure = vi.fn(), observe = vi.fn();
    const ai = fakeAi((model: string) => new Promise(resolve => setTimeout(() => resolve({ text: '네' }), model.endsWith('turbo') ? 3000 : 100)));
    const result = handleConfirm(ai, { data: bytesToBase64(wav(320, 2000)), mimeType: 'audio/wav' }, Date.now() + 4800, { measure, observe });
    await vi.advanceTimersByTimeAsync(1500);
    expect((await result).match.action).toBe('LISTEN');
    expect(measure).toHaveBeenCalledExactlyOnceWith('stt', 1500);
    expect(observe).toHaveBeenLastCalledWith('stt', { hedged: true, winner: 'hedge' });
    await vi.advanceTimersByTimeAsync(1500);
    expect(measure).toHaveBeenCalledOnce();
  });
});

describe('real-account turn latency regression', () => {
  it('keeps the turn fallback at 1000ms and restores confirm to 1400ms', async () => {
    vi.useFakeTimers();
    const audio = { data: bytesToBase64(wav(320, 2000)), mimeType: 'audio/wav' as const };
    const responder = (model: string) => new Promise(resolve => setTimeout(() => resolve({ text: '네' }), model.endsWith('turbo') ? 3000 : 100));
    const turnAi = fakeAi(responder), confirmAi = fakeAi(responder);
    const turn = transcribe(turnAi, audio, 'turn', Date.now() + 4800);
    const confirm = handleConfirm(confirmAi, audio, Date.now() + 4800);
    await vi.advanceTimersByTimeAsync(999);
    expect(turnAi.run).toHaveBeenCalledTimes(1); expect(confirmAi.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(turnAi.run).toHaveBeenCalledTimes(2); expect(confirmAi.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100); expect(await turn).toBe('네');
    await vi.advanceTimersByTimeAsync(300); expect(confirmAi.run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100); expect((await confirm).match.action).toBe('LISTEN');
    await vi.advanceTimersByTimeAsync(1500);
  });
});

describe('three-day confirm quality veto', () => {
  it('restores its first-valid fallback at 1400ms without replacing Turbo primary', async () => {
    vi.useFakeTimers(); const observe = vi.fn();
    const ai = fakeAi((model: string) => new Promise(resolve => setTimeout(() => resolve({text: '보내지 마'}), model.endsWith('turbo') ? 3000 : 100)));
    const pending = handleConfirm(ai, {data:bytesToBase64(wav(320,2000)),mimeType:'audio/wav'}, Date.now()+3900, {observe});
    await vi.advanceTimersByTimeAsync(1399); expect(ai.run).toHaveBeenCalledTimes(1);
    expect((ai.run as any).mock.calls[0][0]).toBe('@cf/openai/whisper-large-v3-turbo');
    await vi.advanceTimersByTimeAsync(1); expect(ai.run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100); expect((await pending).match.action).toBe('CANCEL');
    expect(observe).toHaveBeenLastCalledWith('stt',{hedged:true,winner:'hedge'});
    await vi.advanceTimersByTimeAsync(1900);
  });
});


describe('hedge failure precedence through production adapters', () => {
  it.each(['llm', 'tts'] as const)('keeps the first real %s failure when the other reservation expires', async stage => {
    vi.useFakeTimers();
    const first = Error('first provider failure');
    const reserve = vi.fn(async (_stage: string, call: string) => {
      if (call === 'hedge') await new Promise(resolve => setTimeout(resolve, 2000));
    });
    const ai = fakeAi(() => { throw first; });
    const deadline = Date.now() + 4800;
    const pending = stage === 'llm'
      ? new WorkersAiLlmProvider(ai, { reserve, minimumRemaining: { llm: 2300 } }).respond({ transcript: '질문', calendar }, deadline)
      : synthesize(ai, '일정이 있어요.', deadline, { reserve, minimumRemaining: { tts: 2300 } });
    const outcome = pending.then(() => null, cause => cause);
    await vi.advanceTimersByTimeAsync(2800);
    expect(await outcome).toBe(first);
    expect(ai.run).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledTimes(2);
  });

  it.each(['llm', 'tts'] as const)('retains the first non-deadline %s failure when both attempts fail', async stage => {
    vi.useFakeTimers();
    const first = Error('first provider failure'), second = Error('second provider failure');
    let calls = 0;
    const ai = fakeAi(() => { throw ++calls === 1 ? first : second; });
    const pending = stage === 'llm'
      ? new WorkersAiLlmProvider(ai).respond({ transcript: '질문', calendar }, Date.now() + 4800)
      : synthesize(ai, '일정이 있어요.', Date.now() + 4800);
    const outcome = pending.then(() => null, cause => cause);
    await vi.advanceTimersByTimeAsync(650);
    expect(await outcome).toBe(first);
    expect(ai.run).toHaveBeenCalledTimes(2);
  });

  it.each(['llm', 'tts'] as const)('skips a now-inadmissible %s hedge without reserving or masking the error', async stage => {
    vi.useFakeTimers();
    const first = Error('quota denied');
    const reserve = vi.fn(() => { throw first; });
    const ai = fakeAi(() => { throw Error('must not infer'); });
    const deadline = Date.now() + 4800;
    const pending = stage === 'llm'
      ? new WorkersAiLlmProvider(ai, { reserve, minimumRemaining: { llm: 2300 } }).respond({ transcript: '질문', calendar }, deadline)
      : synthesize(ai, '일정이 있어요.', deadline, { reserve, minimumRemaining: { tts: 1200 } });
    const outcome = pending.then(() => null, cause => cause);
    await vi.advanceTimersByTimeAsync(0);
    // Simulate an event-loop stall before the scheduled hedge gets its start turn.
    vi.setSystemTime(Date.now() + 3100);
    await vi.advanceTimersByTimeAsync(650);
    expect(await outcome).toBe(first);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(ai.run).not.toHaveBeenCalled();
  });
});
