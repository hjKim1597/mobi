import { env, fetchMock, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { GOOGLE_SCOPES } from '../src/google';
import { encryptTokens } from '../src/token-crypto';
import type { Env } from '../src/state';

function pcmAudio() {
  const bytes = new Uint8Array(44 + 3200 * 2), view = new DataView(bytes.buffer);
  const put = (at: number, value: string) => [...value].forEach((char, i) => { bytes[at + i] = char.charCodeAt(0); });
  put(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); put(8, 'WAVE'); put(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  put(36, 'data'); view.setUint32(40, 6400, true);
  for (let i = 0; i < 3200; i++) view.setInt16(44 + i * 2, i % 2 ? 2000 : -2000, true);
  return { data: btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')), mimeType: 'audio/wav' as const };
}

const audio = pcmAudio();
let transcript = '';
let wavBytes = Uint8Array.from(atob(audio.data), char => char.charCodeAt(0));
const ai = { run: vi.fn(async (model: string) => {
  if (model.includes('whisper')) return { text: transcript };
  if (model.includes('melotts')) return new Response(wavBytes.slice(), { headers: { 'Content-Type': 'audio/wav' } });
  throw new Error('Unexpected AI model');
}) } as unknown as Ai;
const originalAiRun = ai.run;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-08T00:00:00Z'));
  wavBytes = Uint8Array.from(atob(audio.data), char => char.charCodeAt(0));
  transcript = '';
  fetchMock.activate(); fetchMock.disableNetConnect();
  fetchMock.get('https://www.googleapis.com').intercept({ path: '/calendar/v3/calendars/primary' }).reply(200, { timeZone: 'Asia/Seoul' }).persist();
  fetchMock.get('https://www.googleapis.com').intercept({ path: /\/calendar\/v3\/calendars\/primary\/events.*/ }).reply(200, { items: [] }).persist();
});
afterEach(() => { ai.run = originalAiRun; fetchMock.deactivate(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function connected() {
  const response = await worker.fetch(new Request('https://mobi.invalid/v1/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), env);
  const device = await response.json() as { deviceId: string; deviceToken: string };
  const stub = env.DEVICE_AGENTS.getByName(device.deviceId);
  const envelope = await encryptTokens(env.TOKEN_ENCRYPTION_KEY!, device.deviceId, {
    accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3_600_000, scopes: [...GOOGLE_SCOPES],
  });
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec('UPDATE device SET paired=1 WHERE id=1');
    state.storage.sql.exec('INSERT INTO google_connection(id,device_id,envelope) VALUES(1,?,?)', device.deviceId, JSON.stringify(envelope));
    vi.spyOn(Object.getPrototypeOf(state.storage), 'setAlarm').mockResolvedValue(undefined);
  });
  return { ...device, stub };
}

async function call<T = any>(deviceToken: string, path: string, body?: unknown) {
  const response = await worker.fetch(new Request(`https://mobi.invalid${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${deviceToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { ...env, AI: ai } as Env);
  const wireBody = await response.text();
  return { response, data: JSON.parse(wireBody) as T, bodyBytes: new TextEncoder().encode(wireBody).byteLength };
}

describe('calendar action two-step handoff', () => {
  it('cold-starts the short pending handoff without calling MeloTTS after 2.9 s STT', async () => {
    const d = await connected();
    const clockStart = Date.now();
    vi.useRealTimers(); vi.useFakeTimers(); vi.setSystemTime(clockStart);
    let announceStt!: () => void;
    const sttStarted = new Promise<void>(resolve => { announceStt = resolve; });
    let releaseStt!: () => void;
    const sttGate = new Promise<void>(resolve => { releaseStt = resolve; });
    let ttsCalls = 0;
    ai.run = vi.fn(async (model: string) => {
      if (model.includes('whisper')) { announceStt(); await sttGate; return { text: transcript }; }
      if (model.includes('melotts')) { ttsCalls++; throw new Error('cold-start handoff must use bundled audio'); }
      throw new Error('Unexpected AI model');
    }) as any;
    transcript = '11월 10일 오후 세 시 MOBI TEST 일정 추가해';
    const startedAt = Date.now();
    const pending = call<any>(d.deviceToken, '/v1/turns', { tripId: 'calendar-two-step-cold', audio });
    await sttStarted;
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(2_900);
    releaseStt();
    const result = await pending;

    expect(result.response.status).toBe(200);
    expect(Date.now() - startedAt).toBe(2_900);
    expect(result.data.sentences).toHaveLength(1);
    expect(result.data.sentences[0].text).toBe('일정 내용을 확인할게요.');
    expect(result.data.sentences[0].audio).toMatchObject({ mimeType: 'audio/wav', data: expect.stringMatching(/^[A-Za-z0-9+/]+={0,2}$/) });
    // The shipped 16 kHz handoff must fit well below the old ~338 KB response.
    expect(result.bodyBytes).toBeLessThan(130_000);
    expect(result.data.actionProposalPending).toMatchObject({ actionId: expect.any(String), version: expect.any(Number) });
    expect(ttsCalls).toBe(0);
  });

  it('returns a pending calendar action after 2.9 s STT without synthesizing its variable readback', async () => {
    const d = await connected();
    const clockStart = Date.now();
    vi.useRealTimers(); vi.useFakeTimers(); vi.setSystemTime(clockStart);
    let announceStt!: () => void;
    const sttStarted = new Promise<void>(resolve => { announceStt = resolve; });
    let releaseStt!: () => void;
    const sttGate = new Promise<void>(resolve => { releaseStt = resolve; });
    const prompts: string[] = [];
    ai.run = vi.fn(async (model: string, input: { prompt?: string }) => {
      if (model.includes('whisper')) { announceStt(); await sttGate; return { text: transcript }; }
      if (model.includes('melotts')) {
        prompts.push(input.prompt ?? '');
        return new Response(wavBytes.slice(), { headers: { 'Content-Type': 'audio/wav' } });
      }
      throw new Error('Unexpected AI model');
    }) as any;
    transcript = '11월 10일 오후 세 시 MOBI TEST 일정 추가해';
    const startedAt = Date.now();
    const pending = call<any>(d.deviceToken, '/v1/turns', { tripId: 'calendar-two-step-turn', audio });
    await sttStarted;
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(2_900);
    releaseStt();
    const result = await pending;

    expect(result.response.status).toBe(200);
    expect(Date.now() - startedAt).toBe(2_900);
    expect(result.data.sentences.map((sentence: { text: string }) => sentence.text).join(' ')).toBe('일정 내용을 확인할게요.');
    expect(result.data.actionProposalPending).toMatchObject({ actionId: expect.any(String), version: expect.any(Number) });
    expect(result.data).not.toHaveProperty('actionProposal');
    expect(prompts.some(prompt => prompt.includes('MOBI TEST'))).toBe(false);
    const stored = await d.stub.actionStatus(result.data.actionProposalPending.actionId);
    expect(stored).toMatchObject({ status: 'awaiting_approval', kind: 'calendar_insert' });
    const version = await runInDurableObject(d.stub, (_, state) => state.storage.sql.exec<{ version: number }>('SELECT version FROM actions WHERE id=?', result.data.actionProposalPending.actionId).one().version);
    expect(version).toBe(result.data.actionProposalPending.version);
  });

  it('returns the stored full split readback repeatedly without changing action state', async () => {
    const d = await connected();
    transcript = '내일 오후 두 시 팀 회의 추가해';
    const proposal = await call<any>(d.deviceToken, '/v1/actions/proposals', {
      tripId: 'calendar-two-step-readback', requestId: crypto.randomUUID(), kind: 'calendar_insert', audio,
    });
    expect(proposal.response.status).toBe(200);
    expect(proposal.data.status).toBe('awaiting_approval');
    const actionId = proposal.data.actionId;
    const before = await d.stub.actionStatus(actionId);
    const countsBefore = await runInDurableObject(d.stub, (_, state) => ({
      actions: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM actions').one().count,
      limits: state.storage.sql.exec<{ name: string; day: string; used: number }>('SELECT name,day,used FROM action_limits ORDER BY name').toArray(),
    }));

    const first = await call<any>(d.deviceToken, `/v1/actions/${actionId}/readback`, {});
    const second = await call<any>(d.deviceToken, `/v1/actions/${actionId}/readback`, {});
    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    expect(first.data).toMatchObject({ actionId, version: proposal.data.version, status: 'awaiting_approval', contentHash: proposal.data.contentHash });
    expect(first.data.sentences).toEqual(proposal.data.sentences);
    expect(second.data).toEqual(first.data);
    expect(first.data.sentences.map((sentence: { text: string }) => sentence.text).join(' ')).toContain('팀 회의');
    expect(await d.stub.actionStatus(actionId)).toEqual(before);
    expect(await runInDurableObject(d.stub, (_, state) => ({
      actions: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM actions').one().count,
      limits: state.storage.sql.exec<{ name: string; day: string; used: number }>('SELECT name,day,used FROM action_limits ORDER BY name').toArray(),
    }))).toEqual(countsBefore);
    expect((await call<any>(d.deviceToken, '/v1/actions/missing_calendar_action/readback', {})).response.status).toBe(404);
    expect((await call<any>(d.deviceToken, `/v1/actions/${actionId}/readback`, { extra: true })).response.status).toBe(400);
    const unauthorized = await worker.fetch(new Request(`https://mobi.invalid/v1/actions/${actionId}/readback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }), { ...env, AI: ai } as Env);
    expect(unauthorized.status).toBe(401);
  });

  it('returns 410 for an expired stored proposal readback', async () => {
    const d = await connected();
    transcript = '내일 오후 두 시 팀 회의 추가해';
    const proposal = await call<any>(d.deviceToken, '/v1/actions/proposals', {
      tripId: 'calendar-two-step-expired', requestId: crypto.randomUUID(), kind: 'calendar_insert', audio,
    });
    expect(proposal.response.status).toBe(200);
    await runInDurableObject(d.stub, (_, state) => {
      state.storage.sql.exec('UPDATE actions SET expires_at=? WHERE id=?', Date.now() - 1, proposal.data.actionId);
    });
    const expired = await call<any>(d.deviceToken, `/v1/actions/${proposal.data.actionId}/readback`, {});
    expect(expired.response.status).toBe(410);
  });

  it('preserves fixed cached speech for rejected and needs-clarification calendar turns', async () => {
    const d = await connected();
    transcript = '내일 두 시 팀 회의 추가해';
    const clarification = await call<any>(d.deviceToken, '/v1/turns', { tripId: 'calendar-two-step-clarify', audio });
    expect(clarification.response.status).toBe(200);
    expect(clarification.data.actionProposal).toMatchObject({ status: 'needs_clarification' });
    expect(clarification.data.sentences).toHaveLength(1);
    expect(clarification.data.sentences[0].text).toBe('오전인가요, 오후인가요?');
  });
});
