import { env, SELF, runInDurableObject, fetchMock, createExecutionContext, waitOnExecutionContext, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { digest, DeviceAgent } from '../src/index';
import { additionalResponseSchemas, deviceResponseSchema, responseSchemas, requestSchemas } from '../src/schemas';
import type { Env } from '../src/state';
import { decryptTokens, encryptTokens, validateEncryptionKey } from '../src/token-crypto';
import { createDeadline, googleJson } from '../src/google';
import { routeCalendarQuestion } from '../src/calendar-router';
import { fingerprintCalendar } from '../src/briefing-cache';
import { failureSentences } from '../src/failure-audio';
import { GOOGLE_SCOPES } from '../src/google';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

type Device = { deviceId: string; deviceToken: string };
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
function fakeRequestClock(): void {
  const now = Date.now();
  vi.useRealTimers(); vi.useFakeTimers(); vi.setSystemTime(now);
}
// DO RPCs run on the real event loop. Poll without advancing the request clock.
async function settleRpc(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) return;
    await new Promise<void>(resolve => realSetTimeout(resolve, 1));
  }
  throw Error('DO RPC did not settle');
}
// Hold real provider responses until the test releases them, without a delay
// or advancing timers owned by a different Durable Object.
function heldJson(matches: (url: URL) => boolean, payload: unknown, expectedStarts = 1) {
  const original = globalThis.fetch;
  let starts = 0, announce!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { announce = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!matches(url)) return original(input, init);
    if (++starts === expectedStarts) announce();
    await gate;
    return Response.json(payload);
  });
  return { entered, release, restore: () => spy.mockRestore(), get starts() { return starts; } };
}
function pcmAudio(amplitude = 0, samples = 320) {
  const bytes = new Uint8Array(44 + samples * 2), v = new DataView(bytes.buffer);
  const put = (i: number, text: string) => [...text].forEach((c, j) => { bytes[i + j] = c.charCodeAt(0); });
  put(0, 'RIFF'); v.setUint32(4, bytes.length - 8, true); put(8, 'WAVE'); put(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  put(36, 'data'); v.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) v.setInt16(44 + i * 2, i % 2 ? amplitude : -amplitude, true);
  let raw = ''; for (const byte of bytes) raw += String.fromCharCode(byte);
  return { data: btoa(raw), mimeType: 'audio/wav' as const };
}
const audio = pcmAudio();
const mockAi = (text = '오늘 일정 알려줘.') => ({ run: vi.fn(async (model: string) => {
  if (model.includes('whisper')) return { text };
  if (model.includes('melotts')) return new Response(Uint8Array.from(atob(audio.data), c => c.charCodeAt(0)), { headers: { 'Content-Type': 'audio/mpeg' } });
  const data = JSON.stringify({ tool: 'calendar_today', sentence: '오늘 일정은 세 개예요.' });
  return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: data } }] }) + '\n')); c.close(); } });
}) }) as unknown as Ai;
const aiRoutes = [
  { path: '/v1/briefings', body: { tripId: 'trip-1', remainingSeconds: 180 } },
  { path: '/v1/confirm', body: { audio } },
  { path: '/v1/turns', body: { tripId: 'trip-1', audio } },
];
const protectedRoutes = [
  { method: 'POST', path: '/v1/pairing', body: {} },
  { method: 'GET', path: '/v1/pairing/ABC123' },
  { method: 'DELETE', path: '/v1/connections/google' },
  { method: 'DELETE', path: '/v1/connections/slack' },
  { method: 'GET', path: '/v1/today' },
  ...aiRoutes.map(route => ({ ...route, method: 'POST' })),
  { method: 'POST', path: '/v1/actions/action-1/approve', body: { contentHash: 'a'.repeat(64) } },
  { method: 'POST', path: '/v1/actions/action-1/cancel', body: {} },
];

// Every helper-mediated response is checked against the single schema module.
async function call(path: string, options: {
  method?: string; body?: unknown; token?: string; ip?: string; bindings?: Partial<Env>; headers?: Record<string, string>;
} = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
  if (options.ip) headers.set('CF-Connecting-IP', options.ip);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const execution = createExecutionContext();
  const response = await worker.fetch(new Request(`https://mobi.invalid${path}`, {
    method: options.method ?? 'GET', headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }), { ...env, AI: mockAi(), ...options.bindings }, execution);
  await waitOnExecutionContext(execution);
  await check(response);
  return response;
}

function startVoiceRequest(path: '/v1/turns' | '/v1/confirm', device: Device, body: unknown, bindings: Partial<Env> = {}) {
  const execution = createExecutionContext();
  const pending = worker.fetch(new Request(`https://mobi.invalid${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${device.deviceToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), { ...env, ...bindings }, execution);
  return { pending, execution };
}

async function advancePastHedgedStt(ai: { run: ReturnType<typeof vi.fn> }, delayMs: number, finishPrimary: () => void): Promise<void> {
  const sttCalls = () => ai.run.mock.calls.filter((args: unknown[]) => String(args[0]).includes('whisper')).length;
  await settleRpc(() => sttCalls() >= 1);
  await vi.advanceTimersByTimeAsync(1000);
  await settleRpc(() => sttCalls() >= 2);
  await vi.advanceTimersByTimeAsync(delayMs - 1000);
  finishPrimary();
}

async function check(response: Response): Promise<void> {
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  if (response.headers.get('Content-Type')?.startsWith('text/html')) return;
  const schemas = { ...responseSchemas, ...additionalResponseSchemas };
  const schema = schemas[String(response.status) as keyof typeof schemas];
  expect(schema, `Missing schema for ${response.status}`).toBeDefined();
  schema.parse(await response.clone().json());
}

async function register(ip = '192.0.2.1'): Promise<Device> {
  const response = await call('/v1/devices', { method: 'POST', body: {}, ip });
  expect(response.status).toBe(201);
  return deviceResponseSchema.parse(await response.json());
}

async function pair(device: Device): Promise<void> {
  // Fixture only: there is no public route/RPC for marking a device paired.
  await runInDurableObject(env.DEVICE_AGENTS.getByName(device.deviceId), (_instance, state) => {
    state.storage.sql.exec('UPDATE device SET paired = 1 WHERE id = 1');
  });
}

// Historical DST/UTC test dates must not drive workerd's wall-clock scheduler.
// Stub scheduling only; the expiry regression restores it and runs a real alarm.
let alarmScheduler: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  await runInDurableObject(env.PAIRING.getByName('admission'), (_instance, state) => {
    alarmScheduler = vi.spyOn(Object.getPrototypeOf(state.storage), 'setAlarm').mockResolvedValue(undefined);
  });
  fetchMock.activate();
  fetchMock.disableNetConnect();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-23T23:59:58Z'));
});
afterEach(() => {
  try { fetchMock.assertNoPendingInterceptors(); }
  finally { fetchMock.deactivate(); vi.useRealTimers(); vi.restoreAllMocks(); }
});

describe('registration', () => {
  it('returns 201, unique credentials, and persists only the token digest in SQLite', async () => {
    const first = await register();
    const second = await register();
    expect(first.deviceToken).not.toBe(second.deviceToken);
    const stored = await runInDurableObject(env.DEVICE_AGENTS.getByName(first.deviceId), (_instance, state) =>
      state.storage.sql.exec('SELECT * FROM device').toArray(),
    );
    expect(stored).toEqual([{ id: 1, token_hash: await digest(first.deviceToken), paired: 0 }]);
    expect(JSON.stringify(stored)).not.toContain(first.deviceToken);
  });

  it('permits exactly five devices/IP/day, separates IPs and resets at 09:00 KST', async () => {
    for (let i = 0; i < 5; i++) await register();
    const limited = await call('/v1/devices', { method: 'POST', body: {}, ip: '192.0.2.1' });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({
      error: { code: 'REGISTRATION_LIMIT' }, fallback: 'cached_knock_or_silence', retryAfterSeconds: 2,
    });
    expect(limited.headers.get('Retry-After')).toBe('2');
    await register('192.0.2.2');
    vi.setSystemTime(new Date('2026-10-24T00:00:00Z'));
    await register();
  });

  it('serializes concurrent registrations without exceeding five', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () =>
      call('/v1/devices', { method: 'POST', body: {}, ip: '192.0.2.10' }),
    ));
    expect(responses.filter(response => response.status === 201)).toHaveLength(5);
    expect(responses.filter(response => response.status === 429)).toHaveLength(3);
  });

  it('uses one fallback IP bucket locally and ignores X-Forwarded-For', async () => {
    for (let i = 0; i < 6; i++) {
      const response = await worker.fetch(new Request('https://mobi.invalid/v1/devices', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `192.0.2.${i}` }, body: '{}',
      }), env);
      await check(response);
      expect(response.status).toBe(i < 5 ? 201 : 429);
    }
  });

  it('rejects client-selected fields without consuming registration slots', async () => {
    for (let i = 0; i < 6; i++) {
      expect((await call('/v1/devices', { method: 'POST', body: { paired: true }, ip: '192.0.2.1' })).status).toBe(400);
    }
    for (let i = 0; i < 5; i++) await register();
  });
});

describe('authentication and routes', () => {
  it.each(protectedRoutes)('requires authentication for $method $path', async route => {
    expect((await call(route.path, route)).status).toBe(401);
  });

  it('rejects malformed, unregistered and forged device credentials', async () => {
    const device = await register();
    const tokens = ['bad-token', `${crypto.randomUUID()}.${'a'.repeat(64)}`, `${device.deviceId}.${'0'.repeat(64)}`];
    for (const token of tokens) expect((await call('/v1/today', { token })).status).toBe(401);
  });

  it.each(aiRoutes)('blocks an unpaired device at $path', async route => {
    const device = await register();
    expect((await call(route.path, { method: 'POST', body: route.body, token: device.deviceToken })).status).toBe(403);
  });

  it.each(protectedRoutes)('returns the documented result for valid $method $path', async route => {
    const device = await register();
    await pair(device);
    const response = await call(route.path, { ...route, token: device.deviceToken });
    const status = route.path === '/v1/pairing' ? 200
      : route.path === '/v1/pairing/ABC123' ? 404
      : route.path === '/v1/connections/google' ? 200
      : route.path === '/v1/today' || route.path === '/v1/briefings' ? 403
      : route.path.startsWith('/v1/actions/') ? 404
      : route.path === '/v1/confirm' || route.path === '/v1/turns' ? 200 : 501;
    expect(response.status).toBe(status);
    if (status === 501) expect(await response.json()).toMatchObject({ error: { code: 'NOT_IMPLEMENTED' } });
  });

  it.each(['/pair/ABC123', '/oauth/google/callback?code=fake&state=fake', '/oauth/slack/callback?error=access_denied'])('reserves public page/callback %s', async path => {
    expect((await call(path)).status).toBe(path.startsWith('/pair/') ? 404 : path.startsWith('/oauth/google/') ? 400 : 501);
  });

  it('returns documented 404/405 responses and Allow header', async () => {
    expect((await call('/v1/missing')).status).toBe(404);
    expect((await call('/oauth/unknown/callback')).status).toBe(404);
    const response = await call('/v1/devices');
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });

  it('exercises the bundled Worker through SELF and real Durable Objects', async () => {
    const response = await SELF.fetch('https://mobi.invalid/v1/devices', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.90' }, body: '{}',
    });
    await check(response);
    expect(response.status).toBe(201);
    const device = deviceResponseSchema.parse(await response.json());
    const auth = await SELF.fetch('https://mobi.invalid/v1/turns', {
      method: 'POST', headers: { Authorization: `Bearer ${device.deviceToken}` },
    });
    await check(auth);
    expect(auth.status).toBe(403);
  });
});

describe('validation', () => {
  it.each([
    ['malformed', '{', 'application/json', 400],
    ['wrong content type', '{}', 'text/plain', 400],
    ['empty', '', 'application/json', 400],
    ['oversized', ' '.repeat(512 * 1024 + 1), 'application/json', 413],
  ])('validates JSON: %s', async (_label, body, contentType, status) => {
    const response = await worker.fetch(new Request('https://mobi.invalid/v1/devices', {
      method: 'POST', headers: { 'Content-Type': contentType }, body,
    }), env);
    await check(response);
    expect(response.status).toBe(status);
  });

  it('wipes the just-read request chunk when it exceeds the body limit', async () => {
    const chunk = new Uint8Array(512 * 1024 + 1).fill(65);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(chunk); } });
    const request = { url: 'https://mobi.invalid/v1/devices', method: 'POST',
      headers: new Headers({ 'Content-Type': 'application/json' }), body } as Request;
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(413);
    expect(chunk.every(value => value === 0)).toBe(true);
  });

  it.each([
    ['/v1/briefings', { tripId: 'trip', remainingSeconds: -1 }],
    ['/v1/briefings', { tripId: 'trip' }],
    ['/v1/confirm', { audio: { data: 'not base64!', mimeType: 'audio/wav' } }],
    ['/v1/turns', { tripId: 'trip', audio: { ...audio, mimeType: 'text/plain' } }],
    ['/v1/actions/action-1/approve', { contentHash: 'bad' }],
    ['/v1/pairing', { paired: true }],
    ['/v1/actions/action-1/cancel', { execute: true }],
  ])('rejects invalid body at %s', async (path, body) => {
    const device = await register();
    await pair(device);
    expect((await call(path, { method: 'POST', body, token: device.deviceToken })).status).toBe(400);
  });
});

describe('daily AI quotas', () => {
  it('reserves neuron amounts atomically without rewinding UTC days', async () => {
    const bucket = env.PAIRING.getByName('quota:neurons');
    const admitted = await Promise.all(Array.from({ length: 8 }, () => bucket.reserveNeurons('2026-10-23', 3000)));
    expect(admitted.filter(Boolean)).toHaveLength(3);
    expect(await bucket.reserveNeurons('2026-10-23', 1000)).toBe(true);
    expect(await bucket.reserveNeurons('2026-10-23', 1)).toBe(false);
    expect(await bucket.reserveNeurons('2026-10-24', 1)).toBe(true);
    expect(await bucket.reserveNeurons('2026-10-23', 1)).toBe(false);
    for (const amount of [0, -1, NaN, 0.5, 10001]) expect(await bucket.reserveNeurons('2026-10-24', amount)).toBe(false);
  });
  it('does not call AI when the neuron reservation is exhausted', async () => {
    const device = await register(); await pair(device);
    await env.PAIRING.getByName('quota:neurons').reserveNeurons('2026-10-23', 10000);
    const ai = mockAi();
    const response = await call('/v1/confirm', { method: 'POST', token: device.deviceToken, body: { audio: pcmAudio(2000) }, bindings: { AI: ai } });
    expect(response.status).toBe(502); expect(ai.run).not.toHaveBeenCalled();
  });
  it('charges two STT calls to neurons but only one daily request when hedging', async () => {
    const device = await register(); await pair(device); fakeRequestClock();
    let invocation = 0;
    const ai = { run: vi.fn((_model: string) => {
      const callNumber = invocation++;
      return new Promise(resolve => setTimeout(() => resolve({ text: '보내' }), callNumber === 0 ? 2300 : 10));
    }) } as unknown as Ai;
    const neuronReservations: number[] = [];
    const neuronLedger = env.PAIRING.getByName('quota:neurons');
    const pairings = { getByName: (name: string) => name === 'quota:neurons' ? {
      reserveNeurons: async (day: string, neurons: number) => {
        neuronReservations.push(neurons);
        return neuronLedger.reserveNeurons(day, neurons);
      },
    } : env.PAIRING.getByName(name) } as unknown as Env['PAIRING'];
    const pending = call('/v1/confirm', { method: 'POST', token: device.deviceToken, body: { audio: pcmAudio(2000) }, bindings: { AI: ai, PAIRING: pairings, DEVICE_DAILY_CAP: '1' } });
    await settleRpc(() => (ai.run as any).mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(1400); await settleRpc(() => (ai.run as any).mock.calls.length === 2);
    await vi.advanceTimersByTimeAsync(1000);
    const response = await pending; expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ match: { action: 'SEND', mode: 'exact' } });
    const sttCalls = (ai.run as any).mock.calls;
    expect(sttCalls.map(([model]: [string]) => model)).toEqual([
      '@cf/openai/whisper-large-v3-turbo', '@cf/openai/whisper-large-v3-turbo',
    ]);
    expect(sttCalls[0][1]).toEqual(sttCalls[1][1]);
    expect(sttCalls[0][1]).toMatchObject({ task: 'transcribe', language: 'ko', vad_filter: true,
      condition_on_previous_text: false, initial_prompt: expect.stringContaining('짧은 한국어 확인 응답입니다.') });
    expect(neuronReservations).toHaveLength(2);
    expect(neuronReservations[1]).toBe(neuronReservations[0]);
    for (const [stub, used] of [[env.PAIRING.getByName('quota:neurons'), 2], [env.PAIRING.getByName('quota:global'), 1], [env.DEVICE_AGENTS.getByName(device.deviceId), 1]] as const) {
      expect(await runInDurableObject(stub, (_i, state) => state.storage.sql.exec('SELECT used FROM daily').one().used)).toBe(used);
    }
  });
  it('keeps the existing 502 JSON shape when both STT calls fail', async () => {
    const device = await register(); await pair(device); fakeRequestClock();
    const ai = { run: vi.fn(async () => ({ wrong: 'invalid transcript' })) } as unknown as Ai;
    const pending = call('/v1/confirm', { method: 'POST', token: device.deviceToken, body: { audio: pcmAudio(2000) }, bindings: { AI: ai } });
    await settleRpc(() => (ai.run as any).mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(1400); await settleRpc(() => (ai.run as any).mock.calls.length === 2);
    const response = await pending; expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Voice request could not be completed.' }, fallback: 'cached_knock_or_silence' });
  });
  it('does not rewind a counter for a delayed request from an earlier day', async () => {
    const bucket = env.PAIRING.getByName('quota:global');
    expect(await bucket.consumeDaily('2026-10-23', 1)).toBe(true);
    expect(await bucket.consumeDaily('2026-10-24', 1)).toBe(true);
    expect(await bucket.consumeDaily('2026-10-23', 1)).toBe(false);
    expect(await bucket.consumeDaily('2026-10-24', 1)).toBe(false);
  });

  it('enforces the device cap and resets it on the next UTC day', async () => {
    const device = await register();
    await pair(device);
    const options = { method: 'POST', body: { audio }, token: device.deviceToken, bindings: { DEVICE_DAILY_CAP: '2' } };
    for (let i = 0; i < 2; i++) expect((await call('/v1/confirm', options)).status).toBe(200);
    const response = await call('/v1/confirm', options);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'DEVICE_DAILY_LIMIT' }, fallback: 'cached_knock_or_silence' });
    vi.setSystemTime(new Date('2026-10-24T00:00:00Z'));
    expect((await call('/v1/confirm', options)).status).toBe(200);
  });

  it('shares the global cap across devices/routes and resets on the next UTC day', async () => {
    const devices = await Promise.all([register('192.0.2.11'), register('192.0.2.12'), register('192.0.2.13')]);
    for (const device of devices) await pair(device);
    const bindings = { GLOBAL_DAILY_CAP: '2' };
    for (let i = 0; i < 2; i++) {
      expect((await call(aiRoutes[i].path, { method: 'POST', body: aiRoutes[i].body, token: devices[i].deviceToken, bindings })).status).toBe(i === 0 ? 403 : 200);
    }
    const options = { method: 'POST', body: aiRoutes[2].body, token: devices[2].deviceToken, bindings };
    const response = await call('/v1/turns', options);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'GLOBAL_DAILY_LIMIT' }, retryAfterSeconds: 2 });
    vi.setSystemTime(new Date('2026-10-24T00:00:00Z'));
    expect((await call('/v1/turns', options)).status).toBe(200);
  });

  it('does not exceed device or global limits under concurrent requests', async () => {
    const first = await register();
    const second = await register();
    await pair(first); await pair(second);
    const run = (device: Device, bindings: Partial<Env>) => call('/v1/confirm', { method: 'POST', body: { audio }, token: device.deviceToken, bindings });
    const deviceResponses = await Promise.all(Array.from({ length: 8 }, () => run(first, { DEVICE_DAILY_CAP: '3', GLOBAL_DAILY_CAP: '100' })));
    expect(deviceResponses.filter(response => response.status === 200)).toHaveLength(3);
    const globalResponses = await Promise.all(Array.from({ length: 8 }, () => run(second, { DEVICE_DAILY_CAP: '20', GLOBAL_DAILY_CAP: '5' })));
    expect(globalResponses.filter(response => response.status === 200)).toHaveLength(2);
    expect(globalResponses.filter(response => response.status === 429)).toHaveLength(6);
  });

  it('does not charge unauthorized, unpaired, invalid-body or non-AI requests', async () => {
    const device = await register();
    for (let i = 0; i < 3; i++) {
      await call('/v1/confirm', { method: 'POST', body: { audio } });
      await call('/v1/confirm', { method: 'POST', body: { audio }, token: device.deviceToken });
    }
    await pair(device);
    for (let i = 0; i < 3; i++) {
      await call('/v1/confirm', { method: 'POST', body: {}, token: device.deviceToken });
      await call('/v1/today', { token: device.deviceToken });
    }
    const options = { method: 'POST', body: { audio }, token: device.deviceToken, bindings: { DEVICE_DAILY_CAP: '1', GLOBAL_DAILY_CAP: '1' } };
    expect((await call('/v1/confirm', options)).status).toBe(200);
    expect((await call('/v1/confirm', options)).status).toBe(429);
  });

  it('fails closed for zero caps and invalid configuration', async () => {
    const device = await register(); await pair(device);
    const options = { method: 'POST', body: { audio }, token: device.deviceToken };
    expect((await call('/v1/confirm', { ...options, bindings: { DEVICE_DAILY_CAP: '0' } })).status).toBe(429);
    expect((await call('/v1/confirm', { ...options, bindings: { GLOBAL_DAILY_CAP: '0' } })).status).toBe(429);
    expect((await call('/v1/confirm', { ...options, bindings: { DEVICE_DAILY_CAP: 'invalid' } })).status).toBe(500);
  });
});

const scopes = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.calendars.readonly',
];
const accessMarker = () => `${env.GOOGLE_CLIENT_ID}:access`;
const refreshMarker = () => `${env.GOOGLE_CLIENT_ID}:refresh`;
function googleTokens(extra: Record<string, unknown> = {}) {
  return { access_token: accessMarker(), refresh_token: refreshMarker(), expires_in: 3600,
    token_type: 'Bearer', scope: scopes.join(' '), ...extra };
}
type PairCode = { code: string; pairingUrl: string; expiresAt: string };
async function issue(device: Device): Promise<PairCode> {
  const response = await call('/v1/pairing', { method: 'POST', body: {}, token: device.deviceToken });
  expect(response.status).toBe(200);
  return response.json() as Promise<PairCode>;
}
async function browser(code: string) {
  const response = await call(`/pair/${code}`, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/130.0 Safari/537.36' } });
  expect(response.status).toBe(200);
  const html = await response.text();
  const auth = new URL(html.match(/href="(https:\/\/accounts\.google\.com[^\"]+)"/)![1].replaceAll('&amp;', '&'));
  const cookie = response.headers.get('Set-Cookie')!.split(';')[0];
  return { auth, cookie, response, html };
}
async function callback(auth: URL, cookie: string, query = 'code=authorization-marker') {
  return call(`/oauth/google/callback?${query}&state=${encodeURIComponent(auth.searchParams.get('state')!)}`, {
    headers: { Cookie: cookie },
  });
}
function tokenMock(extra: Record<string, unknown> = {}) {
  return fetchMock.get('https://oauth2.googleapis.com').intercept({ method: 'POST', path: '/token', body: raw => {
    const form = new URLSearchParams(raw);
    return form.get('client_id') === env.GOOGLE_CLIENT_ID && form.get('client_secret') === env.GOOGLE_CLIENT_SECRET
      && (form.get('grant_type') === 'refresh_token' ? form.get('refresh_token') === refreshMarker()
        : form.get('grant_type') === 'authorization_code' && form.get('code') === 'authorization-marker'
          && form.get('redirect_uri') === 'https://mobi.invalid/oauth/google/callback');
  } })
    .reply(200, googleTokens(extra));
}
async function connect(device: Device) {
  const code = await issue(device);
  const session = await browser(code.code);
  tokenMock();
  expect((await callback(session.auth, session.cookie)).status).toBe(200);
  return { ...code, ...session };
}
function calendarMock(zone = 'Asia/Seoul', items: unknown[] = [], extra: Record<string, unknown> = {}) {
  fetchMock.get('https://www.googleapis.com').intercept({ method: 'GET', path: '/calendar/v3/calendars/primary', headers: { authorization: value => value === `Bearer ${accessMarker()}` || value === `Bearer ${accessMarker()}:new` } })
    .reply(200, { timeZone: zone });
  return fetchMock.get('https://www.googleapis.com').intercept({ method: 'GET', path: /^\/calendar\/v3\/calendars\/primary\/events\?/ })
    .reply(200, { items, ...extra });
}
async function stored(device: Device) {
  return runInDurableObject(env.DEVICE_AGENTS.getByName(device.deviceId), async (_instance, state) => ({
    rows: state.storage.sql.exec('SELECT * FROM google_connection').toArray(),
    device: state.storage.sql.exec('SELECT * FROM device').toArray(),
    kv: [...await state.storage.list()],
  }));
}

describe('A4 pairing and OAuth', () => {
  it('authenticates AES-GCM data, uses fresh IVs and rejects wrong keys, AAD and tampering', async () => {
    const device = await register();
    const key = env.TOKEN_ENCRYPTION_KEY!;
    const payload = { accessToken: accessMarker(), refreshToken: refreshMarker(), expiresAt: Date.now() + 3_600_000, scopes };
    const first = await encryptTokens(key, device.deviceId, payload);
    const second = await encryptTokens(key, device.deviceId, payload);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(await decryptTokens(key, device.deviceId, first)).toEqual(payload);
    expect(() => validateEncryptionKey('invalid')).toThrow();
    const wrongKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    await expect(decryptTokens(wrongKey, device.deviceId, first)).rejects.toThrow();
    await expect(decryptTokens(key, crypto.randomUUID(), first)).rejects.toThrow();
    await expect(decryptTokens(key, device.deviceId, { ...first, ciphertext: `${first.ciphertext[0] === 'A' ? 'B' : 'A'}${first.ciphertext.slice(1)}` })).rejects.toThrow();
    await expect(decryptTokens(key, device.deviceId, { ...first, iv: 'AAAA' })).rejects.toThrow();
    await expect(decryptTokens(key, device.deviceId, { ...first, v: 2 } as never)).rejects.toThrow();
  });

  it('can recreate DeviceAgent from the same SQLite storage without a memory token cache', async () => {
    const device = await register();
    await connect(device);
    calendarMock();
    const response = await runInDurableObject(env.DEVICE_AGENTS.getByName(device.deviceId), async (_instance, state) => {
      const recreated = new DeviceAgent(state, env);
      return recreated.today(Date.now());
    });
    expect(response.status).toBe(200);
  });

  it('fails closed for invalid encryption configuration before any code exchange', async () => {
    const device = await register();
    const result = await runInDurableObject(env.DEVICE_AGENTS.getByName(device.deviceId), async (_instance, state) => {
      const invalid = new DeviceAgent(state, { ...env, TOKEN_ENCRYPTION_KEY: undefined });
      return invalid.connectGoogle(device.deviceId, 'authorization-marker', 0, 'attempt', Date.now() + 300_000);
    });
    expect(result).toBe('config');
    expect((await stored(device)).rows).toEqual([]);
  });

  it('classifies rejected OAuth client credentials as server configuration errors', async () => {
    const device = await register();
    const code = await issue(device);
    const session = await browser(code.code);
    fetchMock.get('https://oauth2.googleapis.com').intercept({ method: 'POST', path: '/token' })
      .reply(401, { error: 'invalid_client', error_description: env.GOOGLE_CLIENT_SECRET });
    const response = await callback(session.auth, session.cookie);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(env.GOOGLE_CLIENT_SECRET!);
    await connect(device);
    vi.setSystemTime(Date.now() + 3_600_000);
    fetchMock.get('https://oauth2.googleapis.com').intercept({ method: 'POST', path: '/token' })
      .reply(401, { error: 'invalid_client' });
    expect((await call('/v1/today', { token: device.deviceToken })).status).toBe(500);
    expect((await stored(device)).rows).toHaveLength(1);
  });

  it('commits only one of two competing pairing attempts for the same device epoch', async () => {
    const device = await register();
    const first = await issue(device), second = await issue(device);
    const a = await browser(first.code), b = await browser(second.code);
    const tokens = heldJson(url => url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token', googleTokens(), 2);
    fetchMock.get('https://oauth2.googleapis.com').intercept({ method: 'POST', path: '/revoke' }).reply(200, '');
    const competing = Promise.all([callback(a.auth, a.cookie), callback(b.auth, b.cookie)]);
    try {
      await tokens.entered;
      expect(tokens.starts).toBe(2);
      tokens.release();
      const responses = await competing;
      expect(responses.map(r => r.status).sort()).toEqual([200, 410]);
      expect(tokens.starts).toBe(2);
      expect((await stored(device)).rows).toHaveLength(1);
    } finally { tokens.release(); await competing.catch(() => {}); tokens.restore(); }
  });

  it('preserves an existing connection when a new consent omits a refresh token', async () => {
    const device = await register();
    await connect(device);
    const before = await stored(device);
    const code = await issue(device);
    const session = await browser(code.code);
    tokenMock({ refresh_token: undefined });
    expect((await callback(session.auth, session.cookie)).status).toBe(502);
    expect(await stored(device)).toEqual(before);
  });

  it('prevents an in-flight OAuth callback from restoring a disconnected device', async () => {
    const device = await register(), code = await issue(device), session = await browser(code.code);
    const tokens = heldJson(url => url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token', googleTokens());
    const pending = callback(session.auth, session.cookie);
    try {
      await tokens.entered;
      expect((await call('/v1/connections/google', { method: 'DELETE', token: device.deviceToken })).status).toBe(200);
      fetchMock.get('https://oauth2.googleapis.com').intercept({ method: 'POST', path: '/revoke' }).reply(200, '');
      tokens.release();
      expect((await pending).status).toBe(410);
      expect(tokens.starts).toBe(1);
      expect((await stored(device)).rows).toEqual([]);
    } finally { tokens.release(); await pending.catch(() => {}); tokens.restore(); }
  });

  it('repairs partial Pairing completion from the committed device attempt id', async () => {
    const device = await register();
    const code = await issue(device);
    const session = await browser(code.code);
    await runInDurableObject(env.PAIRING.getByName(`pairing:${code.code}`), instance => {
      instance.finish = () => { throw new Error('injected-completion-failure'); };
    });
    tokenMock();
    expect((await callback(session.auth, session.cookie)).status).toBe(200);
    const status = await call(`/v1/pairing/${code.code}`, { token: device.deviceToken });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ status: 'paired' });
    expect((await callback(session.auth, session.cookie)).status).toBe(410);
  });

  it('never charges AI counters for pairing, calendar and disconnect calls', async () => {
    const device = await register();
    await connect(device);
    calendarMock();
    expect((await call('/v1/today', { token: device.deviceToken })).status).toBe(200);
    fetchMock.get('https://oauth2.googleapis.com').intercept({ method: 'POST', path: '/revoke' }).reply(200, '');
    await call('/v1/connections/google', { method: 'DELETE', token: device.deviceToken });
    for (const stub of [env.DEVICE_AGENTS.getByName(device.deviceId), env.PAIRING.getByName('quota:global')]) {
      const rows = await runInDurableObject(stub as DurableObjectStub<DeviceAgent>, (_i, state) => state.storage.sql.exec('SELECT * FROM daily').toArray());
      expect(rows).toEqual([]);
    }
  });

  it('ignores the request Host for redirects and rejects invalid configured origins', async () => {
    const device = await register();
    const code = await issue(device);
    const response = await worker.fetch(new Request(`https://attacker.invalid/pair/${code.code}`), env);
    expect(await response.text()).toContain('https://mobi.invalid/oauth/google/callback'.replaceAll('/', '%2F').replace(':', '%3A'));
    for (const origin of ['http://mobi.invalid', 'https://mobi.invalid/path', 'https://u:p@mobi.invalid', 'https://mobi.invalid?x=1']) {
      expect((await call('/v1/pairing', { method: 'POST', body: {}, token: device.deviceToken, bindings: { PUBLIC_ORIGIN: origin } })).status).toBe(500);
    }
  });
  it('issues random, owned codes with a fixed five-minute lifetime and no credential in the URL', async () => {
    const device = await register();
    const first = await issue(device);
    const second = await issue(device);
    expect(first.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.code).not.toBe(second.code);
    expect(first.pairingUrl).toBe(`https://mobi.invalid/pair/${first.code}`);
    expect(first.pairingUrl).not.toContain(device.deviceToken);
    expect(Date.parse(first.expiresAt)).toBe(Date.now() + 300_000);
    expect(await (await call(`/v1/pairing/${first.code}`, { token: device.deviceToken })).json())
      .toEqual({ status: 'pending', expiresAt: first.expiresAt });
    const other = await register('192.0.2.2');
    expect((await call(`/v1/pairing/${first.code}`, { token: other.deviceToken })).status).toBe(404);
  });

  it('expires exactly at TTL without extending it on page visits or polling', async () => {
    const device = await register();
    const code = await issue(device);
    vi.setSystemTime(Date.parse(code.expiresAt) - 1);
    await browser(code.code);
    expect((await call(`/v1/pairing/${code.code}`, { token: device.deviceToken })).status).toBe(200);
    vi.setSystemTime(Date.parse(code.expiresAt));
    expect((await call(`/pair/${code.code}`)).status).toBe(410);
    expect((await call(`/v1/pairing/${code.code}`, { token: device.deviceToken })).status).toBe(410);
  });

  it.each(['Android; wv', 'WebView', 'KAKAOTALK', 'Line/12', 'Instagram'])('guides embedded browsers: %s', async ua => {
    const code = await issue(await register());
    const response = await call(`/pair/${code.code}`, { headers: { 'User-Agent': ua } });
    const html = await response.text();
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(html).toContain('기본 브라우저');
    expect(html).not.toContain('accounts.google.com');
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('binds browser cookies/state and incrementally requests read and action scopes', async () => {
    const code = await issue(await register());
    const session = await browser(code.code);
    expect(session.auth.searchParams.get('scope')?.split(' ')).toEqual(GOOGLE_SCOPES);
    expect(session.auth.searchParams.get('include_granted_scopes')).toBe('true');
    expect(session.auth.searchParams.get('access_type')).toBe('offline');
    expect(session.auth.searchParams.get('prompt')).toBe('consent');
    expect(session.auth.searchParams.get('redirect_uri')).toBe('https://mobi.invalid/oauth/google/callback');
    expect(session.auth.searchParams.get('client_id')).toBe(env.GOOGLE_CLIENT_ID);
    expect(session.response.headers.get('Set-Cookie')).toMatch(/Secure/);
    expect(session.response.headers.get('Set-Cookie')).toMatch(/HttpOnly/);
    expect(session.response.headers.get('Set-Cookie')).toMatch(/SameSite=Lax/);
    expect((await callback(session.auth, '')).status).toBe(400);
    tokenMock();
    expect((await callback(session.auth, session.cookie)).status).toBe(200);
  });

  it('accepts Google RFC 9207 iss and Workspace hd, rejects a foreign iss', async () => {
    const foreign = await browser((await issue(await register())).code);
    expect((await callback(foreign.auth, foreign.cookie, 'code=authorization-marker&iss=https%3A%2F%2Fevil.example')).status).toBe(400);
    const session = await browser((await issue(await register())).code);
    tokenMock();
    expect((await callback(session.auth, session.cookie, 'iss=https%3A%2F%2Faccounts.google.com&code=authorization-marker&hd=example.com')).status).toBe(200);
  });

  it('allows a single concurrent exchange, persists ciphertext only, and returns 410 for reuse', async () => {
    const device = await register();
    const code = await issue(device);
    const session = await browser(code.code);
    tokenMock();
    const responses = await Promise.all([callback(session.auth, session.cookie), callback(session.auth, session.cookie)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 410]);
    expect((await call(`/pair/${code.code}`)).status).toBe(410);
    expect((await callback(session.auth, session.cookie)).status).toBe(410);
    expect(await (await call(`/v1/pairing/${code.code}`, { token: device.deviceToken })).json())
      .toMatchObject({ status: 'paired' });
    const snapshot = await stored(device);
    expect(snapshot.rows).toHaveLength(1);
    const serialized = JSON.stringify(snapshot);
    for (const marker of [accessMarker(), refreshMarker(), env.GOOGLE_CLIENT_SECRET!, 'authorization-marker']) {
      expect(serialized).not.toContain(marker);
    }
    const pairSnapshot = await runInDurableObject(env.PAIRING.getByName(`pairing:${code.code}`), (_i, state) =>
      state.storage.sql.exec('SELECT * FROM pairing_code').toArray());
    expect(JSON.stringify(pairSnapshot)).not.toContain(session.auth.searchParams.get('state')!);
    expect(JSON.stringify(pairSnapshot)).not.toContain(session.cookie.split('=')[1]);
  });

  it('rejects duplicate query parameters, replaced state and expired callbacks without Google traffic', async () => {
    const code = await issue(await register());
    const old = await browser(code.code);
    const current = await browser(code.code);
    expect((await callback(old.auth, old.cookie)).status).toBe(400);
    expect((await callback(current.auth, current.cookie, 'code=a&code=b')).status).toBe(400);
    vi.setSystemTime(Date.parse(code.expiresAt));
    expect((await callback(current.auth, current.cookie)).status).toBe(410);
  });

  it('consumes valid denial and fails closed for missing refresh tokens or insufficient scopes', async () => {
    const device = await register();
    const code = await issue(device);
    const session = await browser(code.code);
    expect((await callback(session.auth, session.cookie, 'error=access_denied')).status).toBe(400);
    expect((await callback(session.auth, session.cookie)).status).toBe(410);
    for (const extra of [{ refresh_token: undefined }, { scope: scopes[0] }]) {
      const next = await issue(device);
      const s = await browser(next.code);
      tokenMock(extra);
      expect((await callback(s.auth, s.cookie)).status).toBe(502);
      expect((await stored(device)).rows).toEqual([]);
    }
  });

  it('deletes locally before revocation, reports failure, and makes repeated disconnect safe', async () => {
    const device = await register();
    const code = await connect(device);
    fetchMock.get('https://oauth2.googleapis.com').intercept({ method: 'POST', path: '/revoke' }).reply(500, 'private-upstream');
    const response = await call('/v1/connections/google', { method: 'DELETE', token: device.deviceToken });
    expect(await response.json()).toEqual({ provider: 'google', connected: false, revocation: 'failed' });
    expect((await stored(device)).rows).toEqual([]);
    expect((await call('/v1/today', { token: device.deviceToken })).status).toBe(403);
    expect((await call(`/pair/${code.code}`)).status).toBe(410);
    expect(await (await call('/v1/connections/google', { method: 'DELETE', token: device.deviceToken })).json())
      .toMatchObject({ revocation: 'not_needed' });
    await connect(device);
  });

  it('does not log provider payloads, tokens, secrets or callback input on failures', async () => {
    const spies = ['log', 'warn', 'error', 'info', 'debug'].map(name => vi.spyOn(console, name as 'log').mockImplementation(() => {}));
    const device = await register();
    const code = await issue(device);
    const session = await browser(code.code);
    fetchMock.get('https://oauth2.googleapis.com').intercept({ method: 'POST', path: '/token' })
      .reply(500, `${accessMarker()} ${env.GOOGLE_CLIENT_SECRET} private@example.invalid`);
    const response = await callback(session.auth, session.cookie);
    expect(response.status).toBe(502);
    const serialized = JSON.stringify(spies.map(spy => spy.mock.calls)) + await response.text();
    for (const marker of [accessMarker(), env.GOOGLE_CLIENT_SECRET!, 'authorization-marker', 'private@example.invalid']) {
      expect(serialized).not.toContain(marker);
    }
  });

  it('exercises real bundled Worker OAuth and storage with SELF', async () => {
    const device = await register();
    const code = await issue(device);
    const session = await browser(code.code);
    tokenMock();
    const response = await SELF.fetch(`https://mobi.invalid/oauth/google/callback?code=authorization-marker&state=${session.auth.searchParams.get('state')}`, {
      headers: { Cookie: session.cookie },
    });
    expect(response.status).toBe(200);
    expect((await stored(device)).rows).toHaveLength(1);
  });
});

describe('A5 Calendar today', () => {
  it('rejects impossible RFC3339 event dates instead of normalizing February 30', async () => {
    const device = await register();
    await connect(device);
    calendarMock('Asia/Seoul', [{ id: 'bad', start: { dateTime: '2026-02-30T09:00:00+09:00' }, end: { dateTime: '2026-03-02T10:00:00+09:00' } }]);
    expect((await call('/v1/today', { token: device.deviceToken })).status).toBe(502);
  });

  it('aborts provider work on deadline and never treats a late payload as success', async () => {
    fakeRequestClock();
    let started!: () => void, releaseLate!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const original = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== 'https://www.googleapis.com/calendar/v3/calendars/primary') return original(input, init);
      return new Promise<Response>((resolve, reject) => {
        releaseLate = () => resolve(Response.json({ timeZone: 'Asia/Seoul' }));
        init?.signal?.addEventListener('abort', () => reject(new Error('fixture provider aborted')), { once: true });
        started();
      });
    });
    const deadline = createDeadline(1);
    try {
      const pending = googleJson(new URL('https://www.googleapis.com/calendar/v3/calendars/primary'), accessMarker(), deadline.signal);
      const rejected = expect(pending).rejects.toThrow();
      await entered;
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(deadline.signal.aborted).toBe(true);
      releaseLate();
      await vi.advanceTimersByTimeAsync(0);
      await expect(pending).rejects.toThrow();
    } finally { deadline.dispose(); }
  });

  it('retries Calendar authentication only once and clears a permanently revoked connection', async () => {
    const device = await register();
    await connect(device);
    fetchMock.get('https://www.googleapis.com').intercept({ path: '/calendar/v3/calendars/primary' }).reply(401, {}).times(2);
    tokenMock();
    expect((await call('/v1/today', { token: device.deviceToken })).status).toBe(403);
    expect((await stored(device)).rows).toEqual([]);
  });
  it('prevents late refresh and late calendar responses after disconnect', async () => {
    for (const operation of ['refresh', 'calendar']) {
      const device = await register(operation === 'refresh' ? '192.0.2.31' : '192.0.2.32');
      await connect(device);
      if (operation === 'refresh') vi.setSystemTime(Date.now() + 3_600_000);
      const provider = heldJson(url => operation === 'refresh'
        ? url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token'
        : url.origin === 'https://www.googleapis.com' && url.pathname === '/calendar/v3/calendars/primary',
      operation === 'refresh' ? googleTokens() : { timeZone: 'Asia/Seoul' });
      const pending = call('/v1/today', { token: device.deviceToken });
      try {
        await provider.entered;
        fetchMock.get('https://oauth2.googleapis.com').intercept({ method: 'POST', path: '/revoke' }).reply(200, '');
        await call('/v1/connections/google', { method: 'DELETE', token: device.deviceToken });
        provider.release();
        expect((await pending).status).toBe(403);
        expect(provider.starts).toBe(1);
        expect((await stored(device)).rows).toEqual([]);
      } finally { provider.release(); await pending.catch(() => {}); provider.restore(); }
    }
  });

  it('accepts Google timezone metadata and sorts all-day events before early local meetings', async () => {
    vi.setSystemTime(new Date('2026-10-23T15:30:00Z'));
    const device = await register();
    await connect(device);
    calendarMock('Asia/Seoul', [
      { id: 'early', start: { dateTime: '2026-10-24T00:30:00+09:00', timeZone: 'Asia/Seoul' }, end: { dateTime: '2026-10-24T01:00:00+09:00', timeZone: 'Asia/Seoul' } },
      { id: 'all-day', start: { date: '2026-10-24' }, end: { date: '2026-10-25' } },
    ]);
    const response = await call('/v1/today', { token: device.deviceToken });
    expect(response.status).toBe(200);
    expect((await response.json() as { events: { id: string }[] }).events.map(e => e.id)).toEqual(['all-day', 'early']);
  });

  it.each(['malformed', 'repeated-page', 'page-failure'])('never returns partial success for %s provider data', async mode => {
    const device = await register();
    await connect(device);
    calendarMock('Asia/Seoul', mode === 'malformed' ? [{ id: 'bad', start: { date: '2026-02-30' }, end: { date: '2026-03-01' } }] : [],
      mode === 'malformed' ? {} : { nextPageToken: 'again' });
    if (mode !== 'malformed') {
      fetchMock.get('https://www.googleapis.com').intercept({ path: url => new URL(url, 'https://www.googleapis.com').searchParams.get('pageToken') === 'again' })
        .reply(mode === 'page-failure' ? 500 : 200, { items: [], nextPageToken: 'again' });
    }
    expect((await call('/v1/today', { token: device.deviceToken })).status).toBe(502);
    expect((await stored(device)).rows).toHaveLength(1);
  });
  it.each([
    ['2026-10-23T15:30:00Z', 'Asia/Seoul', '2026-10-24', '2026-10-23T15:00:00.000Z', '2026-10-24T15:00:00.000Z'],
    ['2026-10-24T00:30:00Z', 'America/Los_Angeles', '2026-10-23', '2026-10-23T07:00:00.000Z', '2026-10-24T07:00:00.000Z'],
    ['2026-03-08T16:00:00Z', 'America/New_York', '2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
    ['2026-11-01T16:00:00Z', 'America/New_York', '2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z'],
    ['2018-11-04T15:00:00Z', 'America/Sao_Paulo', '2018-11-04', '2018-11-04T03:00:00.000Z', '2018-11-05T02:00:00.000Z'],
  ])('uses calendar-local boundaries under UTC: %s %s', async (now, zone, date, min, max) => {
    vi.setSystemTime(new Date(now));
    const device = await register();
    await connect(device);
    fetchMock.get('https://www.googleapis.com').intercept({ path: '/calendar/v3/calendars/primary' }).reply(200, { timeZone: zone });
    fetchMock.get('https://www.googleapis.com').intercept({ path: url => {
      const query = new URL(url, 'https://www.googleapis.com').searchParams;
      return query.get('timeMin') === min && query.get('timeMax') === max && query.get('timeZone') === zone
        && query.get('singleEvents') === 'true' && query.get('orderBy') === 'startTime';
    } }).reply(200, { items: [] });
    const response = await call('/v1/today', { token: device.deviceToken });
    expect(response.status).toBe(200);
    const { knock, ...calendar } = await response.json() as any;
    expect(calendar).toEqual({ date, timeZone: zone, events: [] });
    expect(knock).toMatchObject({ date, timeZone: zone, eventCount: 0 });
  });

  it('collects pages, excludes boundary/cancelled events, preserves dates and strips private fields', async () => {
    vi.setSystemTime(new Date('2026-10-23T15:30:00Z'));
    const device = await register();
    await connect(device);
    const timed = (id: string, start: string, end: string, extra = {}) => ({
      id, summary: '회의', start: { dateTime: start }, end: { dateTime: end }, ...extra,
    });
    calendarMock('Asia/Seoul', [
      timed('end-boundary', '2026-10-23T20:00:00+09:00', '2026-10-24T00:00:00+09:00'),
      timed('tomorrow', '2026-10-25T00:00:00+09:00', '2026-10-25T01:00:00+09:00'),
      timed('overnight', '2026-10-23T23:00:00+09:00', '2026-10-24T01:00:00+09:00'),
      timed('cancelled', '2026-10-24T09:05:00+09:00', '2026-10-24T10:00:00+09:00', { status: 'cancelled' }),
    ], { nextPageToken: 'page-2' });
    fetchMock.get('https://www.googleapis.com').intercept({ path: url => new URL(url, 'https://www.googleapis.com').searchParams.get('pageToken') === 'page-2' })
      .reply(200, { items: [
        { id: 'all-day', start: { date: '2026-10-24' }, end: { date: '2026-10-25' } },
        timed('morning', '2026-10-24T09:05:00+09:00', '2026-10-24T10:00:00+09:00', { description: 'private', attendees: [{ email: 'private@example.invalid' }] }),
      ] });
    const response = await call('/v1/today', { token: device.deviceToken });
    expect(response.status).toBe(200);
    const body = await response.json() as { events: { id: string; title: string; start: unknown }[] };
    expect(body.events.map(e => e.id)).toEqual(['overnight', 'all-day', 'morning']);
    expect(body.events[1]).toMatchObject({ title: '제목 없는 일정', start: { date: '2026-10-24' } });
    expect(body.events[2].start).toEqual({ dateTime: '2026-10-24T09:05:00+09:00' });
    expect(JSON.stringify(body)).not.toMatch(/private|attendees|description/);
  });

  it('refreshes once for concurrent today requests and preserves omitted refresh tokens', async () => {
    const device = await register();
    await connect(device);
    vi.setSystemTime(Date.now() + 3_550_000);
    tokenMock({ access_token: `${accessMarker()}:new`, refresh_token: undefined });
    calendarMock();
    const responses = await Promise.all(Array.from({ length: 3 }, () => call('/v1/today', { token: device.deviceToken })));
    expect(responses.map(r => r.status)).toEqual([200, 200, 200]);
    fetchMock.get('https://oauth2.googleapis.com').intercept({ method: 'POST', path: '/revoke', body: `token=${encodeURIComponent(refreshMarker())}` }).reply(200, '');
    expect(await (await call('/v1/connections/google', { method: 'DELETE', token: device.deviceToken })).json())
      .toMatchObject({ revocation: 'revoked' });
  });

  it('clears invalid grants but preserves connections on transient upstream errors', async () => {
    const device = await register();
    await connect(device);
    fetchMock.get('https://www.googleapis.com').intercept({ path: '/calendar/v3/calendars/primary' }).reply(200, { timeZone: 'not/an-iana-zone' });
    expect((await call('/v1/today', { token: device.deviceToken })).status).toBe(502);
    expect((await stored(device)).rows).toHaveLength(1);
    vi.setSystemTime(Date.now() + 3_600_000);
    fetchMock.get('https://oauth2.googleapis.com').intercept({ method: 'POST', path: '/token' }).reply(400, { error: 'invalid_grant' });
    expect((await call('/v1/today', { token: device.deviceToken })).status).toBe(403);
    expect((await stored(device)).rows).toEqual([]);
    expect((await call('/v1/turns', { method: 'POST', token: device.deviceToken, body: { tripId: 't', audio } })).status).toBe(403);
  });
});


describe('voice API contracts', () => {
  it('preserves the frozen request fields and MIME choices', () => {
    for (const mimeType of ['audio/wav', 'audio/webm', 'audio/mp4']) {
      expect(requestSchemas.confirm.safeParse({ audio: { data: 'AAAA', mimeType } }).success).toBe(true);
    }
    expect(requestSchemas.briefings.safeParse({ tripId: 'trip-1', remainingSeconds: null }).success).toBe(true);
    expect(requestSchemas.briefings.safeParse({ tripId: 'trip-1' }).success).toBe(false);
  });

  it('returns the frozen suppressed confirmation shape instead of 501', async () => {
    const device = await register();
    await pair(device);
    const bytes = new Uint8Array(684);
    const view = new DataView(bytes.buffer);
    const put = (at: number, text: string) => [...text].forEach((c, i) => { bytes[at + i] = c.charCodeAt(0); });
    put(0, 'RIFF'); view.setUint32(4, 676, true); put(8, 'WAVE'); put(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); put(36, 'data'); view.setUint32(40, 640, true);
    const response = await call('/v1/confirm', { method: 'POST', token: device.deviceToken,
      body: { audio: { data: btoa(String.fromCharCode(...bytes)), mimeType: 'audio/wav' } } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ transcript: '', match: { label: 'NONE', action: 'NOT_NOW', mode: 'none' } });
  });

  it('adds static online and offline knock audio to the existing today fields', async () => {
    const device = await register();
    await connect(device);
    calendarMock();
    const response = await call('/v1/today', { token: device.deviceToken });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(Object.keys(body).sort()).toEqual(['date', 'events', 'knock', 'timeZone']);
    expect(body.knock).toMatchObject({ version: 'knock-v1', date: body.date, timeZone: body.timeZone, eventCount: 0 });
    expect(body.knock.online.audio.mimeType).toBe('audio/wav');
    expect(body.knock.offline.text).not.toMatch(/들 듣|들을까요|[?？]/);
  });
});


describe('voice API implementation', () => {
  it('hedges a turn with matching turbo parameters and keeps the first valid result', async () => {
    const device = await register(); await connect(device); calendarMock(); fakeRequestClock();
    const sttResults: Array<(value: { text: string }) => void> = [];
    const fallback = mockAi();
    const ai = { run: vi.fn((model: string, options: unknown) => model.includes('whisper')
      ? new Promise<{ text: string }>(resolve => sttResults.push(resolve))
      : (fallback.run as any)(model, options)) } as unknown as Ai;
    const { pending, execution } = startVoiceRequest('/v1/turns', device,
      { tripId: 'same-model-hedge', audio: pcmAudio(2000) }, { AI: ai });
    await settleRpc(() => (ai.run as any).mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(1000);
    await settleRpc(() => (ai.run as any).mock.calls.length === 2);

    const sttCalls = (ai.run as any).mock.calls;
    expect(sttCalls.map(([model]: [string]) => model)).toEqual([
      '@cf/openai/whisper-large-v3-turbo', '@cf/openai/whisper-large-v3-turbo',
    ]);
    expect(sttCalls[0][1]).toEqual(sttCalls[1][1]);
    expect(sttCalls[0][1]).toEqual({ audio: expect.any(String), task: 'transcribe', language: 'ko',
      vad_filter: true, condition_on_previous_text: false });

    sttResults[1]({ text: '오늘 일정 알려줘.' });
    const response = await pending;
    await check(response);
    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.transcript).toBe('오늘 일정 알려줘.');
    sttResults[0]({ text: '보내' });
    await waitOnExecutionContext(execution);
  });

  it.each([['보내.', 'SEND', 'exact'], ['응', 'LISTEN', 'exact'], ['보내지 마', 'CANCEL', 'exact'], ['보네', 'NOT_NOW', 'none'], ['분해', 'NOT_NOW', 'none']])('runs STT only for %s', async (text, action, mode) => {
    const device = await register(); await pair(device); const ai = mockAi(text);
    const response = await call('/v1/confirm', { method: 'POST', token: device.deviceToken, body: { audio: pcmAudio(2000) }, bindings: { AI: ai } });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ transcript: text, match: { action, mode } });
    expect(ai.run).toHaveBeenCalledTimes(1); expect((ai.run as any).mock.calls[0][0]).toContain('whisper-large-v3-turbo');
  });
  it.each(['audio/webm', 'audio/mp4'])('preserves %s syntax and fails safely before AI', async mimeType => {
    const device = await register(); await pair(device); const ai = mockAi();
    const response = await call('/v1/confirm', { method: 'POST', token: device.deviceToken, body: { audio: { ...audio, mimeType } }, bindings: { AI: ai } });
    expect(response.status).toBe(502); expect(ai.run).not.toHaveBeenCalled();
  });
  it('rejects malformed WAV after charging admission, without AI', async () => {
    const device = await register(); await pair(device); const ai = mockAi();
    const options = { method: 'POST', token: device.deviceToken, body: { audio: { data: 'AAAA', mimeType: 'audio/wav' } }, bindings: { AI: ai, DEVICE_DAILY_CAP: '1' } };
    expect((await call('/v1/confirm', options)).status).toBe(400);
    expect((await call('/v1/confirm', options)).status).toBe(429); expect(ai.run).not.toHaveBeenCalled();
  });
  it.each([[180, 'short', 1], [600, 'summary', 2], [1800, 'full', 4], [null, 'summary', 2]] as const)('returns cached-ready briefing for %s seconds', async (remainingSeconds, bucket, sentenceCount) => {
    const device = await register(); await connect(device); const ai = mockAi();
    calendarMock('Asia/Seoul', [1, 2, 3].map(i => ({ id: 'e' + i, summary: '회의' + i,
      start: { dateTime: '2026-10-24T09:00:00+09:00' }, end: { dateTime: '2026-10-24T10:00:00+09:00' } })));
    const response = await call('/v1/briefings', { method: 'POST', token: device.deviceToken, body: { tripId: 'trip-1', remainingSeconds }, bindings: { AI: ai } });
    expect(response.status).toBe(200); const b = await response.json() as any;
    expect(Object.keys(b).sort()).toEqual(['audio', 'briefingId', 'bucket', 'text', 'tripId']);
    expect(b.bucket).toBe(bucket); expect(b.text.match(/[.?!]/g)).toHaveLength(sentenceCount);
    expect(ai.run).toHaveBeenCalledTimes(1); expect((ai.run as any).mock.calls[0][0]).toContain('melotts');
  });
  it('returns a single WAV sentence after STT, real calendar lookup, provider, and sanitized TTS', async () => {
    const device = await register(); await connect(device); calendarMock(); const ai = mockAi('오늘 회의 자세히 설명해줘.');
    const response = await call('/v1/turns', { method: 'POST', token: device.deviceToken, body: { tripId: 'trip-1', audio: pcmAudio(2000) }, bindings: { AI: ai } });
    expect(response.status).toBe(200); const b = await response.json() as any;
    expect(Object.keys(b).sort()).toEqual(['sentences', 'transcript', 'turnId']);
    expect(b.sentences).toHaveLength(1); expect(b.sentences[0]).toEqual({ text: '오늘 일정은 세 개예요.', audio });
    expect(ai.run).toHaveBeenCalledTimes(3);
  });
  it('finishes a turn after 4,800 ms while retaining the final epoch check before 5,100 ms', async () => {
    const device = await register(); await connect(device); calendarMock(); fakeRequestClock();
    const startedAt = Date.now();
    const base = mockAi('오늘 회의 자세히 설명해줘.');
    const ttsResolvers: Array<(response: Response) => void> = [];
    let audioReady = false, finalEpochCheckAt: number | undefined;
    const deviceAgents = { getByName: (id: string) => {
      const stub = env.DEVICE_AGENTS.getByName(id);
      if (id !== device.deviceId) return stub;
      return {
        authenticate: (hash: string) => stub.authenticate(hash),
        consumeDaily: (day: string, cap: number) => stub.consumeDaily(day, cap),
        getConnectionState: async () => {
          const state = await stub.getConnectionState();
          if (audioReady) finalEpochCheckAt = Date.now();
          return state;
        },
        todayWithTiming: (now: number, deadlineAt?: number) => stub.todayWithTiming(now, deadlineAt),
        getBriefingCache: (input: Parameters<typeof stub.getBriefingCache>[0]) => stub.getBriefingCache(input),
      };
    } } as unknown as Env['DEVICE_AGENTS'];
    const ai = { run: vi.fn((model: string, ...args: any[]) => model.includes('melotts')
      ? new Promise<Response>(resolve => ttsResolvers.push(resolve))
      : (base.run as any)(model, ...args)) } as unknown as Ai;
    const { pending, execution } = startVoiceRequest('/v1/turns', device,
      { tripId: 'after-old-turn-deadline', audio: pcmAudio(2000) }, { AI: ai, DEVICE_AGENTS: deviceAgents });

    await settleRpc(() => ttsResolvers.length >= 1);
    await vi.advanceTimersByTimeAsync(600);
    await settleRpc(() => ttsResolvers.length >= 2);
    await vi.advanceTimersByTimeAsync(4300);
    expect(Date.now() - startedAt).toBe(4_900);
    const audioResponse = new Response(Uint8Array.from(atob(audio.data), c => c.charCodeAt(0)),
      { headers: { 'Content-Type': 'audio/mpeg' } });
    audioReady = true;
    ttsResolvers.forEach(resolve => resolve(audioResponse.clone()));
    const response = await pending;
    await check(response);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ transcript: '오늘 회의 자세히 설명해줘.', sentences: [{ text: '오늘 일정은 세 개예요.' }] });
    expect(finalEpochCheckAt).toBeGreaterThanOrEqual(startedAt + 4_900);
    expect(finalEpochCheckAt).toBeLessThan(startedAt + 5_100);
    await waitOnExecutionContext(execution);
  });
  it('suppresses hallucinations without LLM, TTS, or result persistence', async () => {
    const device = await register(); await pair(device); const ai = mockAi('보내. 구독 좋아요');
    const response = await call('/v1/turns', { method: 'POST', token: device.deviceToken, body: { tripId: 'trip-1', audio: pcmAudio(2000) }, bindings: { AI: ai } });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ transcript: '', sentences: [] });
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect((await stored(device)).kv).toEqual([]);
  });
  it('rejects a result when the connection epoch changes during STT', async () => {
    const device = await register(); await pair(device); const ai = { run: vi.fn(async () => {
      await runInDurableObject(env.DEVICE_AGENTS.getByName(device.deviceId), (_i, state) => {
        state.storage.sql.exec('UPDATE connection_state SET epoch = epoch + 1 WHERE id = 1');
      }); return { text: '보내' };
    }) } as unknown as Ai;
    const response = await call('/v1/confirm', { method: 'POST', token: device.deviceToken, body: { audio: pcmAudio(2000) }, bindings: { AI: ai } });
    expect(response.status).toBe(403);
  });
  it('uses one deadline for a noncooperative AI and does not call downstream stages', async () => {
    const device = await register(); await pair(device); fakeRequestClock();
    const ai = { run: vi.fn(() => new Promise(resolve => setTimeout(() => resolve({ text: '네' }), 6000))) } as unknown as Ai;
    const execution = createExecutionContext();
    const pending = worker.fetch(new Request('https://mobi.invalid/v1/turns', { method: 'POST', headers: { Authorization: `Bearer ${device.deviceToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tripId: 'trip-1', audio: pcmAudio(2000) }) }), { ...env, AI: ai }, execution);
    // Let real DO RPCs settle before advancing virtual time.
    await settleRpc(() => (ai.run as any).mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(1000);
    await settleRpc(() => (ai.run as any).mock.calls.length === 2);
    await vi.advanceTimersByTimeAsync(5000);
    const response = await pending; expect(response.status).toBe(502); expect(ai.run).toHaveBeenCalledTimes(2);
    await check(response);
    await vi.advanceTimersByTimeAsync(4000); await waitOnExecutionContext(execution);
  });
});


describe('voice connection lifecycle regressions', () => {
  const replaceConnection = async (device: Device) => runInDurableObject(env.DEVICE_AGENTS.getByName(device.deviceId), (_i, state) => {
    // Models disconnect + a different newly paired connection: paired=true alone is insufficient.
    state.storage.sql.exec('UPDATE connection_state SET epoch = epoch + 2 WHERE id = 1');
    state.storage.sql.exec('UPDATE device SET paired = 1 WHERE id = 1');
  });
  it.each(['calendar', 'llm', 'tts'])('discards the old account after disconnect/re-pair during %s', async stage => {
    const device = await register(); await connect(device);
    const base = mockAi('오늘 회의 자세히 설명해줘.'); const ai = { run: vi.fn(async (...args: any[]) => {
      const model = args[0] as string;
      if ((stage === 'llm' && model.includes('gpt-oss')) || (stage === 'tts' && model.includes('melotts'))) await replaceConnection(device);
      return (base.run as any)(...args);
    }) } as unknown as Ai;
    if (stage === 'calendar') {
      const provider = heldJson(url => url.origin === 'https://www.googleapis.com' && url.pathname === '/calendar/v3/calendars/primary', { timeZone: 'Asia/Seoul' });
      // fetchToday may reach events before the DO checks its epoch again.
      fetchMock.get('https://www.googleapis.com').intercept({ path: /^\/calendar\/v3\/calendars\/primary\/events\?/ }).reply(200, { items: [] });
      const pending = call('/v1/turns', { method: 'POST', token: device.deviceToken, body: { tripId: 'trip', audio: pcmAudio(1000) }, bindings: { AI: ai } });
      try {
        await provider.entered;
        await replaceConnection(device);
        provider.release();
        const response = await pending; expect(response.status).toBe(403);
        expect(await response.json()).not.toHaveProperty('sentences'); expect(ai.run).toHaveBeenCalledTimes(1);
      } finally { provider.release(); await pending.catch(() => {}); provider.restore(); }
    } else {
      calendarMock();
      const response = await call('/v1/turns', { method: 'POST', token: device.deviceToken, body: { tripId: 'trip', audio: pcmAudio(1000) }, bindings: { AI: ai } });
      expect(response.status).toBe(403); expect(await response.json()).not.toHaveProperty('sentences');
      expect(ai.run).toHaveBeenCalledTimes(stage === 'llm' ? 2 : 3);
    }
  });
  it('cancels a body reader that never completes within the absolute deadline', async () => {
    const device = await register(); await pair(device); fakeRequestClock();
    const body = new ReadableStream<Uint8Array>();
    const request = new Request('https://mobi.invalid/v1/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + device.deviceToken }, body });
    const requestBody = request.body! as any;
    const originalGetReader = requestBody.getReader.bind(requestBody) as () => ReadableStreamDefaultReader<Uint8Array>;
    let reader!: ReadableStreamDefaultReader<Uint8Array>;
    let startRead!: () => void;
    const readStarted = new Promise<void>(resolve => { startRead = resolve; });
    vi.spyOn(requestBody, 'getReader').mockImplementation(() => {
      reader = originalGetReader();
      const originalRead = reader.read.bind(reader);
      vi.spyOn(reader, 'read').mockImplementation((...readArgs) => {
        startRead();
        return originalRead(...readArgs);
      });
      return reader;
    });
    const pending = worker.fetch(request, { ...env, AI: mockAi() });
    await readStarted;
    const cancelReader = vi.spyOn(reader, 'cancel');
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(4800);
    const response = await pending; expect(response.status).toBe(502); expect(cancelReader).toHaveBeenCalled();
  });
  it('wipes a body chunk already emitted when the request deadline aborts its next read', async () => {
    const device = await register(); await pair(device); fakeRequestClock();
    const first = new Uint8Array([123]);
    const lateChunk = new Uint8Array([34, 97, 117, 100, 105, 111]);
    let releaseLate!: (result: ReadableStreamReadResult<Uint8Array>) => void;
    let secondReadStarted!: () => void;
    const secondReadEntered = new Promise<void>(resolve => { secondReadStarted = resolve; });
    const reader = {
      read: vi.fn().mockResolvedValueOnce({ done: false, value: first })
        .mockImplementationOnce(() => new Promise(resolve => { releaseLate = resolve; secondReadStarted(); })),
      cancel: vi.fn(async () => {}),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
    const request = { url: 'https://mobi.invalid/v1/confirm', method: 'POST',
      headers: new Headers({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + device.deviceToken }), body } as Request;
    const pending = worker.fetch(request, { ...env, AI: mockAi() });
    await secondReadEntered;
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(4800);
    const response = await pending;
    expect(response.status).toBe(502);
    expect(reader.cancel).toHaveBeenCalled();
    releaseLate({ done: false, value: lateChunk });
    await Promise.resolve();
    await Promise.resolve();
    expect(first.every(value => value === 0)).toBe(true);
    expect(lateChunk.every(value => value === 0)).toBe(true);
  });
});


describe('bundled voice routes with actual generated assets', () => {
  it('serves real knock WAV and silent confirmation/turns through SELF and real DOs', async () => {
    const device = await register(); await connect(device); calendarMock();
    const today = await SELF.fetch('https://mobi.invalid/v1/today', { headers: { Authorization: 'Bearer ' + device.deviceToken } });
    expect(today.status).toBe(200); const bundle = await today.json() as any;
    expect(bundle.knock.online.audio.data.length).toBeGreaterThan(1000);
    expect(bundle.knock.offline.text).not.toMatch(/[?？]|들을까요/);
    for (const path of ['confirm', 'turns']) {
      const response = await SELF.fetch('https://mobi.invalid/v1/' + path, { method: 'POST',
        headers: { Authorization: 'Bearer ' + device.deviceToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(path === 'confirm' ? { audio } : { tripId: 'trip', audio }) });
      expect(response.status).toBe(200); const data = await response.json() as any; expect(data.transcript).toBe('');
      if (path === 'turns') expect(data.sentences).toEqual([]); else expect(data.match.action).toBe('NOT_NOW');
    }
  });
});

describe('shared Calendar deadline', () => {
  it('uses the caller remaining time for an actual Calendar read', async () => {
    const device = await register(); await connect(device);
    const stub = env.DEVICE_AGENTS.getByName(device.deviceId);
    const result = await runInDurableObject(stub, async instance => {
      const originalFetch = globalThis.fetch;
      const originalSetTimeout = globalThis.setTimeout;
      const now = Date.now();
      let requestStarted!: () => void;
      const entered = new Promise<void>(resolve => { requestStarted = resolve; });
      let releaseResponse!: () => void;
      const responseReleased = new Promise<void>(resolve => { releaseResponse = resolve; });
      let fireDeadline!: () => void;
      globalThis.setTimeout = ((callback: (...args: any[]) => void, milliseconds?: number, ...args: any[]) => {
        if (milliseconds === 10) {
          fireDeadline = () => callback(...args);
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }
        return originalSetTimeout(callback, milliseconds, ...args);
      }) as typeof setTimeout;
      globalThis.fetch = (async input => {
        const url = String(input);
        if (url.endsWith('/calendar/v3/calendars/primary')) {
          requestStarted();
          await responseReleased;
          return new Response(JSON.stringify({ timeZone: 'Asia/Seoul' }));
        }
        return new Response(JSON.stringify({ items: [] }));
      }) as typeof fetch;
      try {
        const pending = instance.today(now, now + 10);
        await entered;
        const hadTenMsDeadline = typeof fireDeadline === 'function';
        if (hadTenMsDeadline) fireDeadline();
        releaseResponse();
        return { result: await pending, hadTenMsDeadline };
      } finally {
        globalThis.fetch = originalFetch;
        globalThis.setTimeout = originalSetTimeout;
      }
    });
    expect(result.hadTenMsDeadline).toBe(true);
    expect(result.result.status).toBe(502);
  });
});


describe('performance: speculative Calendar lifecycle', () => {
  it('can prefetch for a voiced hallucination but never calls LLM or TTS', async () => {
    const device = await register(); await connect(device); calendarMock(); const ai = mockAi('구독 좋아요');
    const response = await call('/v1/turns', { method: 'POST', token: device.deviceToken,
      body: { tripId: 'prefetch-guard', audio: pcmAudio(2000) }, bindings: { AI: ai } });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ transcript: '', sentences: [] });
    expect(ai.run).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => fetchMock.assertNoPendingInterceptors());
  });
});


describe('independent verification: access admission race', () => {
  it('rejects AI after disconnect between authentication and initial epoch capture', async () => {
    const device = await register(); await pair(device);
    const stub = env.DEVICE_AGENTS.getByName(device.deviceId);
    let disconnected = false;
    const namespace = { getByName: () => ({
      authenticate: async (hash: string) => {
        const auth = await stub.authenticate(hash);
        if (!disconnected) { disconnected = true; await stub.disconnectGoogle(); }
        return auth;
      },
      getConnectionState: () => stub.getConnectionState(),
      consumeDaily: (day: string, cap: number) => stub.consumeDaily(day, cap),
      today: (now: number, deadlineAt?: number) => stub.today(now, deadlineAt),
    }) } as unknown as Env['DEVICE_AGENTS'];
    const ai = mockAi('보내');
    const response = await call('/v1/confirm', { method: 'POST', token: device.deviceToken,
      body: { audio: pcmAudio(2000) }, bindings: { AI: ai, DEVICE_AGENTS: namespace } });
    expect(disconnected).toBe(true);
    expect(await stub.authenticate(await digest(device.deviceToken))).toMatchObject({ paired: false });
    expect({ status: response.status, aiCalls: (ai.run as any).mock.calls.length }).toEqual({ status: 403, aiCalls: 0 });
  });
});

// Security hardening admission regressions use the same isolated, mocked runtime.
describe('bounded admission before Durable Object lookup', () => {
  it('deletes expired pairing data with a real Durable Object alarm', async () => {
    alarmScheduler.mockRestore();
    vi.useRealTimers();
    const device = await register();
    const code = await issue(device);
    const stub = env.PAIRING.getByName(`pairing:${code.code}`);
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(Date.parse(code.expiresAt));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pairing_code'").toArray())).toEqual([]);
  });

  it('rejects unissued credentials before looking up an attacker-selected device', async () => {
    const lookup = vi.fn(() => { throw Error('attacker-controlled object lookup'); });
    const response = await call('/v1/today', {
      token: `${crypto.randomUUID()}.${'a'.repeat(64)}`,
      bindings: { DEVICE_AGENTS: { getByName: lookup } as unknown as Env['DEVICE_AGENTS'] },
    });
    expect(response.status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects unissued public pairing codes before looking up their objects', async () => {
    const lookup = vi.fn((name: string) => {
      if (name === 'admission') return env.PAIRING.getByName(name);
      throw Error('attacker-controlled object lookup');
    });
    expect((await call(`/pair/${'a'.repeat(43)}`, {
      bindings: { PAIRING: { getByName: lookup } as unknown as Env['PAIRING'] },
    })).status).toBe(404);
    expect(lookup.mock.calls.map(([name]) => name)).toEqual(['admission']);
  });

  it('caps registration globally despite rotating IPs and concurrent requests', async () => {
    const responses = await Promise.all(Array.from({ length: 105 }, (_, i) =>
      call('/v1/devices', { method: 'POST', body: {}, ip: `198.51.100.${i}` }),
    ));
    expect(responses.filter(response => response.status === 201)).toHaveLength(100);
    expect(responses.filter(response => response.status === 429)).toHaveLength(5);
  });

  it('caps pairing issuance at five per device per UTC day', async () => {
    const device = await register();
    const responses = await Promise.all(Array.from({ length: 7 }, () =>
      call('/v1/pairing', { method: 'POST', body: {}, token: device.deviceToken }),
    ));
    expect(responses.filter(response => response.status === 200)).toHaveLength(5);
    expect(responses.filter(response => response.status === 429)).toHaveLength(2);
    vi.setSystemTime(Date.now() + 86_400_000);
    expect((await call('/v1/pairing', { method: 'POST', body: {}, token: device.deviceToken })).status).toBe(200);
  });

  it('stops Calendar GETs at the per-device cap before any device RPC', async () => {
    const device = await register();
    for (let i = 0; i < 120; i++) expect((await call('/v1/today', { token: device.deviceToken })).status).toBe(403);
    const lookup = vi.fn(() => { throw Error('over-limit device lookup'); });
    const response = await call('/v1/today', {
      token: device.deviceToken,
      bindings: { DEVICE_AGENTS: { getByName: lookup } as unknown as Env['DEVICE_AGENTS'] },
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'DEVICE_DAILY_LIMIT' }, fallback: 'cached_knock_or_silence' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('reuses a Calendar fetch within 30 seconds and fetches again at expiry', async () => {
    const device = await register(); await connect(device);
    calendarMock();
    const first = await call('/v1/today', { token: device.deviceToken });
    expect(first.status).toBe(200);
    const cached = await call('/v1/today', { token: device.deviceToken });
    expect(cached.status).toBe(200);
    expect((await cached.json() as any).date).toBe((await first.json() as any).date);
    vi.setSystemTime(Date.now() + 30_000);
    calendarMock();
    expect((await call('/v1/today', { token: device.deviceToken })).status).toBe(200);
  });
});

describe('Calendar admission and cache lifecycle hardening', () => {
  it('enforces the global Calendar cap atomically across devices before their RPCs', async () => {
    const first = await register(); const second = await register();
    await runInDurableObject(env.PAIRING.getByName('admission'), (_instance, state) => {
      state.storage.sql.exec("INSERT INTO admission_daily (key, day, used) VALUES ('calendar:global', '2026-10-23', 999)");
    });
    const responses = await Promise.all([first, second].map(device => call('/v1/today', { token: device.deviceToken })));
    expect(responses.map(response => response.status).sort()).toEqual([403, 429]);
    const response = await call('/v1/today', { token: first.deviceToken, bindings: {
      DEVICE_AGENTS: { getByName: () => { throw Error('over-limit lookup'); } } as unknown as Env['DEVICE_AGENTS'],
    } });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'GLOBAL_DAILY_LIMIT' } });
    vi.setSystemTime(new Date('2026-10-24T00:00:00Z'));
    expect((await call('/v1/today', { token: first.deviceToken })).status).toBe(403);
  });

  it('coalesces concurrent Calendar RPCs with different request timestamps', async () => {
    const device = await register(); await connect(device);
    calendarMock();
    const stub = env.DEVICE_AGENTS.getByName(device.deviceId);
    const results = await Promise.all([stub.today(Date.now()), stub.today(Date.now() + 1)]);
    expect(results.map(result => result.status)).toEqual([200, 200]);
  });

  it('never reuses a cached Calendar result across calendar-local midnight', async () => {
    vi.setSystemTime(new Date('2026-10-23T14:59:58Z'));
    const device = await register(); await connect(device);
    calendarMock();
    const first = await call('/v1/today', { token: device.deviceToken });
    expect((await first.json() as any).date).toBe('2026-10-23');
    vi.setSystemTime(Date.now() + 4000);
    calendarMock();
    const second = await call('/v1/today', { token: device.deviceToken });
    expect((await second.json() as any).date).toBe('2026-10-24');
  });

  it('invalidates cached Calendar data on disconnect and reconnect', async () => {
    const device = await register(); await connect(device);
    calendarMock();
    expect((await call('/v1/today', { token: device.deviceToken })).status).toBe(200);
    fetchMock.get('https://oauth2.googleapis.com').intercept({ method: 'POST', path: '/revoke' }).reply(200, '');
    expect((await call('/v1/connections/google', { method: 'DELETE', token: device.deviceToken })).status).toBe(200);
    expect((await call('/v1/today', { token: device.deviceToken })).status).toBe(403);
    await connect(device);
    calendarMock('UTC');
    const response = await call('/v1/today', { token: device.deviceToken });
    expect(response.status).toBe(200);
    expect((await response.json() as any).timeZone).toBe('UTC');
  });
});

describe('verifier midnight quota preservation', () => {
  it.each(['calendar', 'pairing'] as const)('does not re-admit a delayed over-cap %s request after registration pruning', async kind => {
    const device = await register();
    if (kind === 'calendar') await connect(device);
    const admission = env.PAIRING.getByName('admission');
    await runInDurableObject(admission, (_instance, state) => {
      state.storage.sql.exec('INSERT INTO admission_daily (key,day,used) VALUES (?, ?, ?)',
        `${kind}:${device.deviceId}`, '2026-10-23', kind === 'calendar' ? 120 : 5);
      if (kind === 'calendar') state.storage.sql.exec("INSERT INTO admission_daily (key,day,used) VALUES ('calendar:global','2026-10-23',120)");
    });
    let resume!: () => void; let waiting = false;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const wrapped = {
      knowsDevice: (id: string, token: string) => admission.knowsDevice(id, token),
      admitCalendar: async (id: string, day: string) => { waiting = true; await gate; return admission.admitCalendar(id, day); },
      admitPairing: async (id: string, day: string) => { waiting = true; await gate; return admission.admitPairing(id, day); },
      rememberPairing: (hash: string, expiry: number) => admission.rememberPairing(hash, expiry),
    };
    const pending = call(kind === 'calendar' ? '/v1/today' : '/v1/pairing', {
      method: kind === 'calendar' ? 'GET' : 'POST',
      ...(kind === 'pairing' ? { body: {} } : {}),
      token: device.deviceToken,
      bindings: {
        PAIRING: { getByName: (name: string) => name === 'admission' ? wrapped : env.PAIRING.getByName(name) } as unknown as Env['PAIRING'],
        ...(kind === 'calendar' ? { DEVICE_AGENTS: { getByName: (id: string) => {
          const stub = env.DEVICE_AGENTS.getByName(id);
          return {
            authenticate: (hash: string) => stub.authenticate(hash),
            today: (now: number, deadline?: number) => { calendarMock(); return stub.today(now, deadline); },
          };
        } } as unknown as Env['DEVICE_AGENTS'] } : {}),
      },
    });
    await settleRpc(() => waiting);
    vi.setSystemTime(new Date('2026-10-24T00:00:00Z'));
    await register('203.0.113.250');
    resume();
    const response = await pending;
    expect(response.status, `previous-day ${kind} cap must survive registration housekeeping`).toBe(429);
  });
});

describe('AI request timing privacy', () => {
  it('logs exactly one allowlisted timing line for a turn, including cache and hedge metadata', async () => {
    const device = await register(); await connect(device); calendarMock();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const body = { tripId: 'private-trip-marker', audio: pcmAudio(2000) };
    for (let i = 0; i < 2; i++) {
      expect((await call('/v1/turns', { method: 'POST', token: device.deviceToken, body, bindings: { AI: mockAi('private-transcript-marker') } })).status).toBe(200);
    }
    expect(log).toHaveBeenCalledTimes(2);
    for (const [line] of log.mock.calls) {
      const row = JSON.parse(line as string);
      expect(Object.keys(row).sort()).toEqual(['calendar', 'llm', 'question', 'route', 'rpc', 'status', 'stt', 'totalMs', 'tts', 'uploadBytes']);
      expect(row).toEqual({ route: '/v1/turns', totalMs: expect.any(Number), status: 200,
        uploadBytes: new TextEncoder().encode(JSON.stringify(body)).length,
        stt: { ms: expect.any(Number), model: '@cf/openai/whisper-large-v3-turbo', hedgeFired: false },
        calendar: { ms: expect.any(Number), cache: row.calendar.cache, tokenRefresh: false },
        llm: { ms: expect.any(Number) }, tts: { ms: expect.any(Number) },
        question: { intent:'abstain', cache:'unused', degraded:false }, rpc: Object.fromEntries(['digestMs','admissionMs','authenticationMs','quotaMs','reservationMs','epochMs','bodyMs','assemblyMs'].map(key=>[key,expect.any(Number)])) });
      for (const secret of [device.deviceToken, device.deviceId, 'private-trip-marker', 'private-transcript-marker', accessMarker(), refreshMarker(), '오늘 일정은', '192.0.2']) expect(line).not.toContain(secret);
    }
    expect(JSON.parse(log.mock.calls[0][0] as string).calendar.cache).toBe('miss');
    expect(JSON.parse(log.mock.calls[1][0] as string).calendar.cache).toBe('hit');
  });
  it.each([401, 400, 502])('logs one sanitized line for HTTP %s without exposing errors or credentials', async status => {
    const device = await register(); await pair(device);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const response = await call('/v1/confirm', { method: 'POST', token: status === 401 ? undefined : device.deviceToken,
      body: { audio: status === 400 ? { data: 'AAAA', mimeType: 'audio/wav' } : pcmAudio(2000) },
      bindings: { AI: { run: () => { throw Error('private-error-marker'); } } as unknown as Ai } });
    expect(response.status).toBe(status); expect(log).toHaveBeenCalledOnce();
    const line = log.mock.calls[0][0] as string, row = JSON.parse(line);
    expect(row).toMatchObject({ route: '/v1/confirm', status, totalMs: expect.any(Number),
      calendar: { ms: 0, cache: 'unused', tokenRefresh: false }, llm: { ms: 0 }, tts: { ms: 0 } });
    expect(line).not.toContain('private-error-marker'); expect(line).not.toContain(device.deviceToken);
  });
});

describe('Calendar timing refresh metadata', () => {
  it('reports a token refresh without returning token or Calendar content in timing metadata', async () => {
    const device = await register(); await connect(device);
    vi.setSystemTime(Date.now() + 3_600_000);
    tokenMock(); calendarMock();
    const measured = await env.DEVICE_AGENTS.getByName(device.deviceId).todayWithTiming(Date.now(), Date.now() + 4800);
    expect(measured.result.status).toBe(200);
    expect(measured.timing).toEqual({ cache: 'miss', tokenRefresh: true });
    const cached = await env.DEVICE_AGENTS.getByName(device.deviceId).todayWithTiming(Date.now(), Date.now() + 4800);
    expect(cached.timing).toEqual({ cache: 'hit', tokenRefresh: false });
  });
});

describe('compatible briefing reuse through the real API and DO',()=>{
 it('reuses an already generated count WAV for the same current trip and snapshot',async()=>{
  const device=await register();await connect(device);
  calendarMock('Asia/Seoul',[1,2,3].map(i=>({id:'cache-'+i,summary:'회의'+i,start:{dateTime:'2026-10-24T09:00:00+09:00'},end:{dateTime:'2026-10-24T10:00:00+09:00'}})));
  const seedAi=mockAi();const seed=await call('/v1/briefings',{method:'POST',token:device.deviceToken,body:{tripId:'reuse-trip',remainingSeconds:180},bindings:{AI:seedAi}});
  expect(seed.status).toBe(200);const briefing=await seed.json()as any;expect(seedAi.run).toHaveBeenCalledOnce();
  const turnAi=mockAi('오늘 일정 몇 개야');const turn=await call('/v1/turns',{method:'POST',token:device.deviceToken,body:{tripId:'reuse-trip',audio:pcmAudio(2000)},bindings:{AI:turnAi}});
  expect(turn.status).toBe(200);const result=await turn.json()as any;
  expect(result.transcript).toBe('오늘 일정 몇 개야');expect(result.sentences).toEqual([{text:briefing.text,audio:briefing.audio}]);expect(turnAi.run).toHaveBeenCalledOnce();
 });
});

describe('answer freshness after the final response epoch RPC', () => {
  it.each([
    { cached: false, boundary: 'event start' }, { cached: true, boundary: 'event start' },
    { cached: false, boundary: 'local midnight' }, { cached: true, boundary: 'local midnight' },
    { cached: true, boundary: 'cache expiry' },
  ])('degrades $cached cached audio crossing $boundary during the last RPC', async ({ cached, boundary }) => {
    const now = Date.parse(boundary === 'local midnight' ? '2026-10-24T14:59:59.900Z' : '2026-10-24T01:00:00Z');
    vi.setSystemTime(now);
    const device = await register(); await connect(device);
    const eventStart = now + (boundary === 'event start' ? 100 : 60_000);
    calendarMock('Asia/Seoul', [{ id: 'freshness', summary: '회의',
      start: { dateTime: new Date(eventStart).toISOString() }, end: { dateTime: new Date(eventStart + 60_000).toISOString() } }]);
    const stub = env.DEVICE_AGENTS.getByName(device.deviceId);
    const today = await stub.today(now, now + 4800);
    expect(today.status).toBe(200);
    if (today.status !== 200) throw Error('Calendar fixture failed');
    const transcript = boundary === 'local midnight' ? '오늘 일정 몇 개야' : '다음 일정 뭐야';
    const answer = routeCalendarQuestion(transcript, today.data, new Date(now))!;
    expect(answer).not.toBeNull();
    if (cached) {
      const connection = await stub.getConnectionState();
      expect(await stub.publishBriefingCache({ key: {
        epoch: connection.epoch, tripId: 'freshness-trip', calendarDate: today.data.date, timeZone: today.data.timeZone,
        calendarFingerprint: await fingerprintCalendar(today.data), canonicalText: answer.text,
        voice: 'kr', modelVersion: '@cf/myshell-ai/melotts:briefing-v1',
      }, audio, now: boundary === 'cache expiry' ? now - 29_900 : now, nextStartAt: answer.expiresAt })).toBe(true);
    }
    let audioReady = false, checksAfterAudio = 0, finalWaiting = false;
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const baseAi = mockAi(transcript);
    const run = vi.fn(async (...args: Parameters<Ai['run']>) => {
      const value = await baseAi.run(...args);
      if (String(args[0]).includes('melotts')) audioReady = true;
      return value;
    });
    const namespace = { getByName: () => ({
      authenticate: (hash: string) => stub.authenticate(hash),
      consumeDaily: (day: string, cap: number) => stub.consumeDaily(day, cap),
      todayWithTiming: (time: number, deadline?: number) => stub.todayWithTiming(time, deadline),
      getBriefingCache: async (input: Parameters<typeof stub.getBriefingCache>[0]) => {
        const entry = await stub.getBriefingCache(input);
        if (entry) audioReady = true;
        return entry;
      },
      getConnectionState: async () => {
        const connection = await stub.getConnectionState();
        if (audioReady && ++checksAfterAudio === 2) { finalWaiting = true; await gate; }
        return connection;
      },
    }) } as unknown as Env['DEVICE_AGENTS'];
    const pending = call('/v1/turns', { method: 'POST', token: device.deviceToken,
      body: { tripId: 'freshness-trip', audio: pcmAudio(2000) }, bindings: { AI: { run } as unknown as Ai, DEVICE_AGENTS: namespace } });
    await settleRpc(() => finalWaiting);
    // The answer was valid through handleTurn's check; expire it only in index's final RPC.
    vi.setSystemTime(now + 100);
    resume();
    const response = await pending;
    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(Object.keys(result).sort()).toEqual(['sentences', 'transcript', 'turnId']);
    expect(result.transcript).toBe(transcript);
    expect(result.turnId).toEqual(expect.any(String));
    expect(result.sentences).toEqual([failureSentences.question]);
    expect(checksAfterAudio).toBe(2);
    expect(run.mock.calls.map(args => args[0])).toEqual(cached
      ? ['@cf/openai/whisper-large-v3-turbo']
      : ['@cf/openai/whisper-large-v3-turbo', '@cf/myshell-ai/melotts']);
  });
});

describe('post-STT quota denial preserves the error contract', () => {
  it('returns 502 when the neuron ledger denies TTS after successful STT', async () => {
    const device = await register(); await connect(device); calendarMock();
    const ledger = env.PAIRING.getByName('quota:neurons');
    let reservations = 0;
    const namespace = { getByName: (name: string) => name === 'quota:neurons' ? {
      reserveNeurons: async (day: string, neurons: number) => ++reservations === 1 && await ledger.reserveNeurons(day, neurons),
    } : env.PAIRING.getByName(name) } as unknown as Env['PAIRING'];
    const ai = mockAi('오늘 일정 몇 개야');
    const pending = call('/v1/turns', { method: 'POST', token: device.deviceToken,
      body: { tripId: 'denied-trip', audio: pcmAudio(2000) }, bindings: { AI: ai, PAIRING: namespace } });
    // Let the denied TTS primary and its bounded hedge settle on the real clock.
    const response = await pending;
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' }, fallback: 'cached_knock_or_silence' });
    expect(ai.run).toHaveBeenCalledOnce();
    expect(reservations).toBeGreaterThan(1);
  });
});

describe('three-day stage admission and provider failures', () => {
  it('keeps an LLM neuron denial at 2,500 ms headroom as an HTTP error', async () => {
    const device = await register(); await connect(device); calendarMock(); fakeRequestClock();
    const startedAt = Date.now(), reservations: Array<{ at: number; neurons: number }> = [];
    const ledger = env.PAIRING.getByName('quota:neurons');
    const pairings = { getByName: (name: string) => name === 'quota:neurons' ? {
      reserveNeurons: async (day: string, neurons: number) => {
        reservations.push({ at: Date.now(), neurons });
        return reservations.length <= 2 && ledger.reserveNeurons(day, neurons);
      },
    } : env.PAIRING.getByName(name) } as unknown as Env['PAIRING'];
    const sttResolvers: Array<(value: { text: string }) => void> = [];
    const run = vi.fn((model: string) => model.includes('whisper')
      ? new Promise<{ text: string }>(resolve => sttResolvers.push(resolve))
      : Promise.reject(Error('LLM should not start after quota denial')));
    const ai = { run } as unknown as Ai;
    const { pending, execution } = startVoiceRequest('/v1/turns', device,
      { tripId: 'llm-quota-window', audio: pcmAudio(2000) }, { AI: ai, PAIRING: pairings });

    await advancePastHedgedStt({ run }, 2600, () => sttResolvers[0]({ text: '이번 주 일정 알려줘' }));
    await settleRpc(() => reservations.length >= 3);
    expect(5100 - (reservations[2].at - startedAt)).toBe(2500);
    expect(run.mock.calls.some(([model]) => String(model).includes('gpt-oss'))).toBe(false);
    sttResolvers.forEach(resolve => resolve({ text: '이번 주 일정 알려줘' }));
    const response = await pending;
    await check(response);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' }, fallback: 'cached_knock_or_silence' });
    expect(reservations).toHaveLength(3);
    await waitOnExecutionContext(execution);
  });

  it('keeps a TTS neuron denial at 1,600 ms headroom as an HTTP error', async () => {
    const device = await register(); await connect(device); calendarMock('Asia/Seoul', []); fakeRequestClock();
    const startedAt = Date.now(), reservations: Array<{ at: number; neurons: number }> = [];
    const ledger = env.PAIRING.getByName('quota:neurons');
    const pairings = { getByName: (name: string) => name === 'quota:neurons' ? {
      reserveNeurons: async (day: string, neurons: number) => {
        reservations.push({ at: Date.now(), neurons });
        return neurons !== 21 && ledger.reserveNeurons(day, neurons);
      },
    } : env.PAIRING.getByName(name) } as unknown as Env['PAIRING'];
    const sttResolvers: Array<(value: { text: string }) => void> = [];
    const run = vi.fn((model: string) => model.includes('whisper')
      ? new Promise<{ text: string }>(resolve => sttResolvers.push(resolve))
      : Promise.reject(Error('TTS should not start after quota denial')));
    const ai = { run } as unknown as Ai;
    const { pending, execution } = startVoiceRequest('/v1/turns', device,
      { tripId: 'tts-quota-window', audio: pcmAudio(2000) }, { AI: ai, PAIRING: pairings });

    await advancePastHedgedStt({ run }, 3500, () => sttResolvers[0]({ text: '오늘 일정 몇 개야' }));
    await settleRpc(() => reservations.some(row => row.neurons === 21));
    const ttsReservation = reservations.find(row => row.neurons === 21)!;
    expect(5100 - (ttsReservation.at - startedAt)).toBe(1600);
    sttResolvers.forEach(resolve => resolve({ text: '오늘 일정 몇 개야' }));
    const response = await pending;
    await check(response);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' }, fallback: 'cached_knock_or_silence' });
    expect(run.mock.calls.some(([model]) => String(model).includes('melotts'))).toBe(false);
    expect(reservations.filter(row => row.neurons === 21)).toHaveLength(1);
    await waitOnExecutionContext(execution);
  });

  it.each([
    { stage: 'LLM', sttMs: 2600, transcript: '이번 주 일정 알려줘', model: 'gpt-oss', remaining: 2500 },
    { stage: 'TTS', sttMs: 3500, transcript: '오늘 일정 몇 개야', model: 'melotts', remaining: 1600 },
  ])('returns 502 for a real $stage provider 500 with $remaining ms stage headroom', async ({ stage, sttMs, transcript, model, remaining }) => {
    const device = await register(); await connect(device);
    calendarMock('Asia/Seoul', []); fakeRequestClock();
    const startedAt = Date.now(), providerAt: number[] = [];
    const sttResolvers: Array<(value: { text: string }) => void> = [];
    const run = vi.fn((name: string) => {
      if (name.includes('whisper')) return new Promise<{ text: string }>(resolve => sttResolvers.push(resolve));
      if (name.includes(model)) { providerAt.push(Date.now()); return new Response('provider failure', { status: 500 }); }
      throw Error(`Unexpected ${name} provider call`);
    });
    const ai = { run } as unknown as Ai;
    const { pending, execution } = startVoiceRequest('/v1/turns', device,
      { tripId: `provider-${stage}`, audio: pcmAudio(2000) }, { AI: ai });

    await advancePastHedgedStt({ run }, sttMs, () => sttResolvers[0]({ text: transcript }));
    await settleRpc(() => providerAt.length === 1);
    expect(5100 - (providerAt[0] - startedAt)).toBe(remaining);
    sttResolvers.forEach(resolve => resolve({ text: transcript }));
    const response = await pending;
    await check(response);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' }, fallback: 'cached_knock_or_silence' });
    expect(providerAt).toHaveLength(1);
    await waitOnExecutionContext(execution);
  });

  it('returns the fixed failure sentence only when the 5,100 ms response-ready deadline expires', async () => {
    const device = await register(); await connect(device); calendarMock(); fakeRequestClock();
    const never: Array<(value: unknown) => void> = [];
    const run = vi.fn((model: string) => {
      if (model.includes('whisper')) return Promise.resolve({ text: '이번 주 일정 알려줘' });
      if (model.includes('gpt-oss')) return new Promise(resolve => never.push(resolve));
      throw Error(`Unexpected ${model} provider call`);
    });
    const ai = { run } as unknown as Ai;
    const { pending, execution } = startVoiceRequest('/v1/turns', device,
      { tripId: 'real-cutoff', audio: pcmAudio(2000) }, { AI: ai });
    await settleRpc(() => never.length === 1);
    await vi.advanceTimersByTimeAsync(650);
    await settleRpc(() => never.length === 2);
    await vi.advanceTimersByTimeAsync(4450); // 650 + 4,450 = the response-ready cutoff.
    never.forEach(resolve => resolve({}));
    const response = await pending;
    await check(response);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sentences: [failureSentences.question], transcript: '이번 주 일정 알려줘' });
    expect(run.mock.calls.some(([model]) => String(model).includes('melotts'))).toBe(false);
    await waitOnExecutionContext(execution);
  });
});

describe('confirm keeps 4,800 ms while turn Calendar keeps 6,000/5,100 ms deadlines', () => {
  it('allows confirm STT to finish after 3,900 ms and before the outer deadline', async () => {
    const device = await register(); await pair(device); fakeRequestClock();
    const sttResolvers: Array<(value: { text: string }) => void> = [];
    const run = vi.fn(() => new Promise<{ text: string }>(resolve => sttResolvers.push(resolve)));
    const ai = { run } as unknown as Ai;
    const { pending, execution } = startVoiceRequest('/v1/confirm', device, { audio: pcmAudio(2000) }, { AI: ai });
    await settleRpc(() => run.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(1400);
    await settleRpc(() => run.mock.calls.length === 2);
    await vi.advanceTimersByTimeAsync(2800); // Primary STT completes at 4,200 ms.
    sttResolvers.forEach(resolve => resolve({ text: '네' }));
    const response = await pending;
    await check(response);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ transcript: '네', match: { action: 'LISTEN', mode: 'exact' } });
    await waitOnExecutionContext(execution);
  });

  it('lets a stalled Calendar read reach the 6,000 ms outer deadline while the question degrades at 5,100 ms', async () => {
    const device = await register(); await connect(device); fakeRequestClock();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const startedAt = Date.now(); let capturedDeadline: number | undefined; let epochChecks = 0;
    let releaseCalendar!: (value: any) => void;
    const stalledCalendar = new Promise<any>(resolve => { releaseCalendar = resolve; });
    const namespace = { getByName: (id: string) => {
      const stub = env.DEVICE_AGENTS.getByName(id);
      if (id !== device.deviceId) return stub;
      return {
        authenticate: (hash: string) => stub.authenticate(hash),
        getConnectionState: async () => { const state = await stub.getConnectionState(); epochChecks++; return state; },
        consumeDaily: (day: string, cap: number) => stub.consumeDaily(day, cap),
        todayWithTiming: (_now: number, deadlineAt: number) => { capturedDeadline = deadlineAt; return stalledCalendar; },
        getBriefingCache: (input: Parameters<typeof stub.getBriefingCache>[0]) => stub.getBriefingCache(input),
      };
    } } as unknown as Env['DEVICE_AGENTS'];
    const run = vi.fn(async (model: string) => model.includes('whisper') ? { text: '이번 주 일정 알려줘' } : new Response('', { status: 500 }));
    const ai = { run } as unknown as Ai;
    const { pending, execution } = startVoiceRequest('/v1/turns', device,
      { tripId: 'calendar-deadline', audio: pcmAudio(2000) }, { AI: ai, DEVICE_AGENTS: namespace });
    try {
      // Finish post-STT authorization before advancing the Calendar wait to its cutoff.
      await settleRpc(() => capturedDeadline !== undefined && epochChecks >= 2);
      await vi.advanceTimersByTimeAsync(0);
      expect(capturedDeadline).toBe(startedAt + 6000);
      await vi.advanceTimersByTimeAsync(5100);
      await settleRpc(() => log.mock.calls.length > 0);
    } finally {
      releaseCalendar({ result: { status: 502 }, timing: { cache: 'miss', tokenRefresh: false } });
    }
    const response = await pending;
    await check(response);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sentences: [failureSentences.question], transcript: '이번 주 일정 알려줘' });
    expect(run.mock.calls.some(([model]) => String(model).includes('gpt-oss'))).toBe(false);
    await waitOnExecutionContext(execution);
  });
});

describe('router empty COUNT answer over the API', () => {
  it('uses the deterministic empty-count sentence without invoking LLM', async () => {
    const device = await register(); await connect(device); calendarMock('Asia/Seoul', []);
    const ai = mockAi('오늘 일정 몇 개야');
    const response = await call('/v1/turns', { method: 'POST', token: device.deviceToken,
      body: { tripId: 'empty-count', audio: pcmAudio(2000) }, bindings: { AI: ai } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sentences: [{ text: '오늘 일정은 없어요.' }] });
    expect((ai.run as any).mock.calls.map((args: unknown[]) => args[0])).toEqual([
      '@cf/openai/whisper-large-v3-turbo', '@cf/myshell-ai/melotts',
    ]);
  });
});
