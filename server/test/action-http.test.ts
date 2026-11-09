import { env, fetchMock, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { unwrapAction } from '../src/actions';
import { GOOGLE_READ_SCOPES, GOOGLE_SCOPES } from '../src/google';
import { encryptTokens } from '../src/token-crypto';
import type { DeviceAgent, Env } from '../src/state';
import { holdAudioDurationMs } from '../src/action-http';
import { REPLIES } from '../src/voice';
import { failureSentences } from '../src/failure-audio';
import { actionWordingSentences } from '../src/action-wording-audio';
import { actionHoldSentence } from '../src/action-hold-audio';
import { inspectBase64Wav } from '../src/audio';

// beforeEach freezes Date only; reinstall so these tests also own the timers.
function fakeRequestClock() {
  const now = Date.now();
  vi.useRealTimers(); vi.useFakeTimers(); vi.setSystemTime(now);
}

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function pcmAudio(amplitude = 2000, samples = 3200) {
  const bytes = new Uint8Array(44 + samples * 2), view = new DataView(bytes.buffer);
  const put = (at: number, value: string) => [...value].forEach((char, i) => { bytes[at + i] = char.charCodeAt(0); });
  put(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); put(8, 'WAVE'); put(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  put(36, 'data'); view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, i % 2 ? amplitude : -amplitude, true);
  let raw = ''; for (const byte of bytes) raw += String.fromCharCode(byte);
  return { data: btoa(raw), mimeType: 'audio/wav' as const };
}
const audio = pcmAudio();
let wavBytes = Uint8Array.from(atob(audio.data), char => char.charCodeAt(0));
let transcript = '';
const ai = { run: vi.fn(async (model: string) => {
  if (model.includes('whisper')) return { text: transcript };
  if (model.includes('melotts')) return new Response(wavBytes.slice(), { headers: { 'Content-Type': 'audio/wav' } });
  return new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ sentence: '오늘 일정은 없어요.' }) } }] }) + '\n'));
    controller.close();
  } });
}) } as unknown as Ai;
const originalAiRun = ai.run;

beforeEach(async () => {
  wavBytes = Uint8Array.from(atob(audio.data), char => char.charCodeAt(0));
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-08T00:00:00Z'));
  await runInDurableObject(env.DEVICE_AGENTS.getByName('http-alarm-fixture'), (_, state) => {
    vi.spyOn(Object.getPrototypeOf(state.storage), 'setAlarm').mockResolvedValue(undefined);
  });
  fetchMock.activate(); fetchMock.disableNetConnect();
  fetchMock.get('https://www.googleapis.com').intercept({ path: '/calendar/v3/calendars/primary' }).reply(200, { timeZone: 'Asia/Seoul' }).persist();
  fetchMock.get('https://www.googleapis.com').intercept({ path: /\/calendar\/v3\/calendars\/primary\/events.*/ }).reply(200, { items: [] }).persist();
  transcript = '';
});
afterEach(() => { ai.run = originalAiRun; fetchMock.deactivate(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function connected(scopes: readonly string[] = GOOGLE_SCOPES) {
  const response = await worker.fetch(new Request('https://mobi.invalid/v1/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), env);
  const device = await response.json() as { deviceId: string; deviceToken: string };
  const stub = env.DEVICE_AGENTS.getByName(device.deviceId);
  const envelope = await encryptTokens(env.TOKEN_ENCRYPTION_KEY!, device.deviceId, {
    accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3_600_000, scopes: [...scopes],
  });
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec('UPDATE device SET paired=1 WHERE id=1');
    state.storage.sql.exec('INSERT INTO google_connection(id,device_id,envelope) VALUES(1,?,?)', device.deviceId, JSON.stringify(envelope));
  });
  return { ...device, stub };
}
async function call<T = any>(deviceToken: string, path: string, body?: unknown) {
  return worker.fetch(new Request(`https://mobi.invalid${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${deviceToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { ...env, AI: ai } as Env).then(async response => ({ response, data: await response.json() as T }));
}
const propose = (requestId = crypto.randomUUID()) => ({ tripId: 'trip-action-http', requestId, kind: 'calendar_insert', audio });
const mailText = (text: string) => btoa(Array.from(new TextEncoder().encode(text), byte => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function scanMail(subject = 'PRIVATE SUBJECT', body = 'PRIVATE BODY 내일 오후 두 시 회의 가능하신가요?') {
  const mail = { id: 'scan-message', threadId: 'scan-thread', internalDate: String(Date.now()), labelIds: ['INBOX'], payload: { mimeType: 'text/plain', headers: [
    { name: 'From', value: 'PRIVATE SENDER <private@example.com>' }, { name: 'Subject', value: subject }, { name: 'Message-ID', value: '<scan-message@example.com>' },
  ], body: { data: mailText(body) } } };
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === 'https://gmail.googleapis.com') return Promise.resolve(Response.json(url.pathname.endsWith('/messages') ? { messages: [{ id: mail.id }] } : url.pathname.includes('/threads/') ? { messages: [mail] } : mail));
    return original(input, init);
  });
  return mail;
}
async function approvalProposal(kind: 'mail_reply' | 'calendar_insert') {
  const d = await connected();
  let proposal;
  if (kind === 'mail_reply') {
    scanMail();
    const scan = await call<any>(d.deviceToken, '/v1/mail/scan', { tripId: 'approval-scan' });
    transcript = '네 가능합니다.';
    proposal = await call<any>(d.deviceToken, '/v1/actions/proposals', { tripId: 'approval-mail', requestId: crypto.randomUUID(), kind, candidateId: scan.data.candidate.candidateId, audio });
  } else {
    transcript = '내일 오후 두 시 팀 회의 추가해';
    proposal = await call<any>(d.deviceToken, '/v1/actions/proposals', propose());
  }
  expect(proposal.response.status).toBe(200);
  expect(proposal.data.status).toBe('awaiting_approval');
  return { ...d, proposal: proposal.data };
}

describe('action HTTP integration', () => {
  it('uses one fixed cached sentence for a quiet non-sensitive mail scan', async () => {
    const d = await connected(); scanMail();
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const quietSentence = '확인이 필요한 메일이 있어요. 정차 후 확인해 주세요.';
    const prompts: string[] = [];
    ai.run = vi.fn(async (model: string, input: { prompt: string }) => {
      expect(model).toContain('melotts');
      prompts.push(input.prompt);
      return new Response(wavBytes.slice(), { headers: { 'Content-Type': 'audio/wav' } });
    }) as any;

    const first = await call<any>(d.deviceToken, '/v1/mail/scan', { tripId: 'quiet-mail', quiet: true });
    const second = await call<any>(d.deviceToken, '/v1/mail/scan', { tripId: 'quiet-mail', quiet: true });
    expect(first.response.status).toBe(200);
    expect(first.data.candidate).toMatchObject({ sensitive: false, canReply: false, canAddCalendar: false, replyPromptSentences: [] });
    expect(first.data.candidate.sentences).toHaveLength(1);
    expect(first.data.candidate.sentences[0].text).toBe(quietSentence);
    expect(first.data.candidate).not.toHaveProperty('calendarOfferSentences');
    expect(first.data.candidate.display).toMatchObject({ sender: 'PRIVATE SENDER', subject: 'PRIVATE SUBJECT' });
    expect(second.data).toEqual(first.data);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(quietSentence);
    expect(prompts.join(' ')).not.toMatch(/PRIVATE SENDER|private@example\.com|PRIVATE SUBJECT|PRIVATE BODY/);
    expect(JSON.stringify(logs.mock.calls)).not.toMatch(/PRIVATE SENDER|private@example\.com|PRIVATE SUBJECT|PRIVATE BODY/);
  });

  it('rejects a non-boolean quiet scan flag', async () => {
    const d = await connected();
    const result = await call<any>(d.deviceToken, '/v1/mail/scan', { tripId: 'bad-quiet', quiet: 'true' });
    expect(result.response.status).toBe(400);
  });

  it('keeps sensitive and empty mail scan behavior unchanged when quiet is set', async () => {
    const d = await connected();
    scanMail('법률 상담 예약', '내일 오후 두 시 상담 가능하신가요?');
    const sensitive = await call<any>(d.deviceToken, '/v1/mail/scan', { tripId: 'quiet-sensitive', quiet: true });
    expect(sensitive.response.status).toBe(200);
    expect(sensitive.data.candidate).toMatchObject({ sensitive: true, canReply: false, canAddCalendar: false, replyPromptSentences: [], display: { sender: '' } });
    expect(sensitive.data.candidate.sentences.map((part: { text: string }) => part.text)).toEqual(['민감한 내용으로 보여 정차 후 확인해 주세요.']);

    const original = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === 'https://gmail.googleapis.com') return Promise.resolve(Response.json({ messages: [] }));
      return original(input, init);
    });
    const empty = await call<any>(d.deviceToken, '/v1/mail/scan', { tripId: 'quiet-empty', quiet: true });
    expect(empty).toMatchObject({ response: { status: 200 }, data: { candidate: null } });
  });

  it('starts all cold scan chunks together, keeps fixed audio cached, and logs only timings', async () => {
    const d = await connected();
    // Native RPC readiness must not let real hedge/deadline timers race the barrier.
    fakeRequestClock();
    scanMail();
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const prompts: string[] = [];
    const allStarted = barrier();
    const synthesisStart = Date.now();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    ai.run = vi.fn(async (model: string, input: { prompt: string }) => {
      expect(model).toContain('melotts');
      prompts.push(input.prompt);
      if (prompts.length === 3) allStarted.resolve();
      await gate;
      return new Response(wavBytes.slice(), { headers: { 'Content-Type': 'audio/wav' } });
    }) as any;
    const pending = call<any>(d.deviceToken, '/v1/mail/scan', { tripId: 'cold-scan' });
    // No sentence may finish until every needed synthesis has started.
    await allStarted.promise;
    expect(prompts).toHaveLength(3);
    vi.setSystemTime(synthesisStart + 120);
    release();
    const first = await pending;
    expect(first.response.status).toBe(200);
    expect(first.data.candidate).toMatchObject({ canReply: true, canAddCalendar: true });
    expect(first.data.candidate.sentences).toHaveLength(3);
    expect(first.data.candidate.sentences[0].text).toBe('회신이 필요해 보이는 메일이 있어요.');
    expect(first.data.candidate.sentences[1].text).toContain('PRIVATE SENDER 님이');
    expect(first.data.candidate.sentences[2].text).toBe('회신 내용을 작성할까요?');
    const wording = new Map(actionWordingSentences.map(sentence => [sentence.text, sentence.audio.data]));
    expect(first.data.candidate.sentences[2].audio.data).toBe(wording.get('회신 내용을 작성할까요?'));
    expect(first.data.candidate.replyPromptSentences[0].text).toBe('답장 내용을 짧게 말씀해 주세요.');
    expect(first.data.candidate.calendarOfferSentences[0].text).toBe('일정 내용을 확인할까요?');
    expect(first.data.candidate.calendarOfferSentences[0].audio.data).toBe(wording.get('일정 내용을 확인할까요?'));
    expect(logs).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logs.mock.calls[0][0]);
    expect(logged).toMatchObject({ route: '/v1/mail/scan', googleListMs: 0, googleMessageGetsMs: 0, googleValidationMs: 0, sttMs: 0, messageCount: 1, status: 200 });
    // Advance only the controlled Date clock: five overlapping spans count once.
    expect(logged.ttsMs).toBe(120);
    expect(logged.totalMs).toBe(120);
    expect(logged).not.toHaveProperty('error');
    const serialized = JSON.stringify(logs.mock.calls);
    for (const secret of ['PRIVATE SENDER', 'private@example.com', 'PRIVATE SUBJECT', 'PRIVATE BODY', d.deviceToken, 'fixture-access', audio.data]) expect(serialized).not.toContain(secret);
    const warm = await call<any>(d.deviceToken, '/v1/mail/scan', { tripId: 'cold-scan' });
    expect(warm.response.status).toBe(200);
    // Only the variable offer is synthesized again; static and pre-generated fixed audio stays cached.
    expect(prompts).toHaveLength(4);
    expect(logs).toHaveBeenCalledTimes(2);
    expect(JSON.parse(logs.mock.calls[1][0])).toMatchObject({ messageCount: 0, status: 200 });
  });
  it('keeps the default mail scan wire response byte-identical when quiet is false', async () => {
    const d = await connected(); scanMail();
    const normal = await call<any>(d.deviceToken, '/v1/mail/scan', { tripId: 'quiet-off' });
    const explicitOff = await call<any>(d.deviceToken, '/v1/mail/scan', { tripId: 'quiet-off', quiet: false });
    expect(explicitOff.response.status).toBe(200);
    expect(JSON.stringify(explicitOff.data)).toBe(JSON.stringify(normal.data));
    expect(explicitOff.data.candidate).not.toHaveProperty('quiet');
  });
  it('logs a failed Google list stage once without provider content or credentials', async () => {
    const d = await connected();
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => String(input).startsWith('https://gmail.googleapis.com/')
      ? Promise.resolve(Response.json({ error: 'PRIVATE SUBJECT private@example.com fixture-access' }, { status: 503 })) : original(input, init));
    const result = await call<any>(d.deviceToken, '/v1/mail/scan', { tripId: 'failed-scan' });
    expect(result.response.status).toBe(502);
    expect(logs).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logs.mock.calls[0][0]);
    expect(logged).toMatchObject({ route: '/v1/mail/scan', status: 502, messageCount: 0, error: { name: 'GoogleError', stage: 'google_list' } });
    expect(Object.keys(logged.error).sort()).toEqual(['name', 'stage']);
    expect(JSON.stringify(logs.mock.calls)).not.toMatch(/PRIVATE SUBJECT|private@example\.com|fixture-access/);
  });
  it('reports separate list, parallel message batch, and selected-message validation durations', async () => {
    const d = await connected(), mail = scanMail();
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const original = globalThis.fetch;
    let selectedReads = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== 'https://gmail.googleapis.com') return original(input, init);
      if (url.pathname.endsWith('/messages')) {
        vi.setSystemTime(Date.now() + 7);
        return Response.json({ messages: [{ id: mail.id }, { id: 'older-message' }] });
      }
      if (url.pathname.includes('/threads/')) {
        vi.setSystemTime(Date.now() + 17);
        return Response.json({ messages: [mail] });
      }
      if (url.pathname.includes('/older-message')) {
        vi.setSystemTime(Date.now() + 11);
        return Response.json({ ...mail, id: 'older-message', internalDate: String(Number(mail.internalDate) - 1_000) });
      }
      if (++selectedReads === 2) vi.setSystemTime(Date.now() + 13);
      return Response.json(mail);
    });
    const result = await call<any>(d.deviceToken, '/v1/mail/scan', { tripId: 'measured-scan' });
    expect(result.response.status).toBe(200);
    expect(logs).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logs.mock.calls[0][0])).toMatchObject({ googleListMs: 7, googleMessageGetsMs: 11, googleValidationMs: 30, messageCount: 2, totalMs: 48, status: 200 });
  });
  it('aborts outstanding message reads when another GET fails without returning a candidate', async () => {
    const d = await connected();
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const original = globalThis.fetch;
    let aborted = false;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== 'https://gmail.googleapis.com') return original(input, init);
      if (url.pathname.endsWith('/messages')) return Promise.resolve(Response.json({ messages: [{ id: 'bad' }, { id: 'pending' }] }));
      if (url.pathname.endsWith('/bad')) return Promise.resolve(new Response('PRIVATE PROVIDER ERROR', { status: 503 }));
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => { aborted = true; reject(new Error('PRIVATE ABORT')); };
        if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort', abort, { once: true });
      });
    });
    const result = await call<any>(d.deviceToken, '/v1/mail/scan', { tripId: 'abort-sibling-scan' });
    expect(result.response.status).toBe(502);
    expect(result.data).not.toHaveProperty('candidate');
    expect(aborted).toBe(true);
    expect(logs).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logs.mock.calls[0][0])).toMatchObject({ messageCount: 2, error: { name: 'GoogleError', stage: 'google_message_gets' } });
    expect(JSON.stringify(logs.mock.calls)).not.toContain('PRIVATE');
  });
  it('logs only an allowlisted error class and tts stage when synthesis fails', async () => {
    const d = await connected();
    scanMail();
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    ai.run = vi.fn().mockRejectedValue(Object.assign(new Error('PRIVATE AI BODY fixture-access'), { name: 'PRIVATE ERROR NAME' })) as any;
    const result = await call<any>(d.deviceToken, '/v1/mail/scan', { tripId: 'tts-failed-scan' });
    expect(result.response.status).toBe(502);
    expect(logs).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logs.mock.calls[0][0])).toMatchObject({ status: 502, error: { name: 'Error', stage: 'tts' } });
    expect(JSON.stringify(logs.mock.calls)).not.toMatch(/PRIVATE|fixture-access|private@example\.com/);
  });
  it('logs unknown Google metrics once if the outer deadline wins a pending scan RPC', async () => {
    const d = await connected();
    fakeRequestClock();
    const rpcStarted = barrier(), rpcSettled = barrier();
    let rejectRpc!: (reason: Error) => void;
    const pendingRpc = new Promise<never>((_resolve, reject) => { rejectRpc = reject; });
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const device = {
      authenticate: (hash: string) => d.stub.authenticate(hash),
      getConnectionState: () => d.stub.getConnectionState(),
      consumeDaily: (day: string, cap: number) => d.stub.consumeDaily(day, cap),
      actionScanMeasured: async () => {
        rpcStarted.resolve();
        try { return await pendingRpc; }
        finally { rpcSettled.resolve(); }
      },
    };
    const bindings = { ...env, AI: ai, DEVICE_AGENTS: { getByName: () => device } } as unknown as Env;
    const pending = worker.fetch(new Request('https://mobi.invalid/v1/mail/scan', {
      method: 'POST', headers: { Authorization: `Bearer ${d.deviceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tripId: 'deadline-scan' }),
    }), bindings);
    await rpcStarted.promise;
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(8_500);
    const response = await pending;
    expect(response.status).toBe(502);
    expect(logs).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logs.mock.calls[0][0])).toMatchObject({ googleListMs: null, googleMessageGetsMs: null, googleValidationMs: null, messageCount: null, status: 502, error: { name: 'VoiceDeadlineError', stage: 'google_scan' } });
    // Exercise late RPC completion explicitly; do not race a real DO timer or
    // assume a fixed sleep is long enough for the losing request to settle.
    rejectRpc(new Error('PRIVATE CANCELLED PROVIDER REQUEST'));
    await rpcSettled.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(logs).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logs.mock.calls)).not.toContain('PRIVATE');
  });
  it('attributes a proposal RPC rejection after successful STT to rpc', async () => {
    const d = await connected();
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    transcript = '네 가능합니다.';
    const result = await call<any>(d.deviceToken, '/v1/actions/proposals', { tripId: 'missing-candidate', requestId: crypto.randomUUID(), kind: 'mail_reply', candidateId: 'unknown', audio });
    expect(result.response.status).toBe(410);
    expect(logs).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logs.mock.calls[0][0])).toMatchObject({ error: { name: 'ActionError', stage: 'rpc' } });
  });
  it('attributes a clarification RPC rejection after successful STT to rpc', async () => {
    const d = await connected();
    transcript = '내일 두 시 팀 회의 추가해';
    const first = await call<any>(d.deviceToken, '/v1/actions/proposals', propose());
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    transcript = '오후';
    const result = await call<any>(d.deviceToken, `/v1/actions/${first.data.actionId}/clarify`, { version: first.data.version + 1, audio });
    expect(result.response.status).toBe(409);
    expect(logs).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logs.mock.calls[0][0])).toMatchObject({ error: { name: 'ActionError', stage: 'rpc' } });
  });
  it.each([
    ['/v1/capabilities', undefined, '/v1/capabilities'],
    ['/v1/mail/scan', {}, '/v1/mail/scan'],
    ['/v1/actions/proposals', {}, '/v1/actions/proposals'],
    ['/v1/actions/PRIVATE_ACTION_ID/clarify', {}, '/v1/actions/:id/clarify'],
    ['/v1/actions/PRIVATE_ACTION_ID/approve', {}, '/v1/actions/:id/approve'],
    ['/v1/actions/PRIVATE_ACTION_ID/cancel', {}, '/v1/actions/:id/cancel'],
    ['/v1/actions/PRIVATE_ACTION_ID', undefined, '/v1/actions/:id'],
  ])('logs exactly one sanitized timing line even before authentication: %s', async (path, body, route) => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await call('PRIVATE_CREDENTIAL', path, body);
    expect(result.response.status).toBe(401);
    expect(logs).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logs.mock.calls[0][0])).toMatchObject({ route, status: 401, error: { name: 'Error', stage: 'request' } });
    expect(JSON.stringify(logs.mock.calls)).not.toMatch(/PRIVATE_ACTION_ID|PRIVATE_CREDENTIAL/);
  });
  it.each([
    ['연간 2026년 회의', '연간 이천이십육년 회의'], ['회의 3명', '회의 삼명'],
  ])('synthesizes calendar approval through the lossless readback path: %s', async (title, spokenTitle) => {
    const d = await connected();
    const synthesis = vi.spyOn(ai, 'run');
    transcript = `내일 오후 두 시 ${title} 추가해`;
    const proposal = await call<any>(d.deviceToken, '/v1/actions/proposals', propose());
    expect(proposal.response.status).toBe(200);
    expect(proposal.data.status).toBe('awaiting_approval');
    expect(proposal.data.display.title).toBe(title);
    const expected = `십일월 구일 오후 두 시부터 두 시 반까지 '${spokenTitle}' 일정을 내 캘린더에 추가할게요. 추가하려면 '추가해'라고 말씀해 주세요.`;
    const parts = proposal.data.sentences.map((sentence: { text: string }) => sentence.text);
    expect(parts).toEqual([
      '십일월 구일 오후 두 시부터 두 시 반까지',
      `'${spokenTitle}' 일정을 내 캘린더에 추가할게요.`, "추가하려면 '추가해'라고 말씀해 주세요.",
    ]);
    expect(parts.join(' ')).toBe(expected);
    expect(proposal.data).not.toHaveProperty('calendarSpeechParts');
    const calls = synthesis.mock.calls as unknown as Array<[string, { prompt: string }]>;
    const prompts = calls.filter(([model]) => model.includes('melotts')).map(([, input]) => input.prompt);
    expect(prompts).toEqual(expect.arrayContaining(parts.slice(0, 2)));
    expect(prompts).not.toContain(expected);
  });
  it.each([
    ['mail_reply', 'voice'], ['mail_reply', 'parked_button'],
    ['calendar_insert', 'voice'], ['calendar_insert', 'parked_button'],
  ] as const)('%s %s approval uses the bundled hold WAV without request-time TTS', async (kind, channel) => {
    const wav = inspectBase64Wav(actionHoldSentence.audio.data);
    expect(wav).toMatchObject({ sampleRate: 16000, channels: 1, bits: 16, format: 1 });
    expect(actionHoldSentence.text).toBe("취소하려면 '취소'라고 말씀하세요.");
    const d = await approvalProposal(kind);
    const inference = vi.spyOn(ai, 'run');
    if (channel === 'voice') transcript = kind === 'mail_reply' ? '보내.' : '추가해.';
    const result = await call<any>(d.deviceToken, `/v1/actions/${d.proposal.actionId}/approve`, {
      contentHash: d.proposal.contentHash, version: d.proposal.version, channel,
      ...(channel === 'voice' ? { audio } : {}),
    });
    expect(result.response.status).toBe(200);
    expect(result.data.status).toBe('holding');
    expect(result.data.holdSentences).toEqual([actionHoldSentence]);
    expect(result.data.holdAudioMs).toBe(holdAudioDurationMs(actionHoldSentence));
    const models = (inference.mock.calls as unknown as Array<[string]>).map(([model]) => model);
    expect(models.filter(model => model.includes('melotts'))).toHaveLength(0);
    expect(models.filter(model => model.includes('whisper'))).toHaveLength(channel === 'voice' ? 1 : 0);

    const embeddedBytes = atob(actionHoldSentence.audio.data).length;
    const equivalent44100PcmBytes = result.data.holdAudioMs * 44.1 * 2;
    expect(embeddedBytes).toBeLessThan(equivalent44100PcmBytes * 0.5);
  });

  it('reports capabilities from calendar-only and full granted scopes', async () => {
    const readOnly = await connected(GOOGLE_READ_SCOPES);
    expect((await call(readOnly.deviceToken, '/v1/capabilities')).data).toEqual({ calendarRead: true, mailRead: false, mailReply: false, calendarInsert: false, reconnectRequired: true });
    const full = await connected(GOOGLE_SCOPES);
    expect((await call(full.deviceToken, '/v1/capabilities')).data).toEqual({ calendarRead: true, mailRead: true, mailReply: true, calendarInsert: true, reconnectRequired: false });
  });

  it('proposes an audio calendar request with a 30-minute default and gates voice approval', async () => {
    const d = await connected();
    transcript = '내일 오후 두 시 팀 회의 추가해';
    const proposal = await call<any>(d.deviceToken, '/v1/actions/proposals', propose());
    expect(proposal.response.status).toBe(200);
    expect(proposal.data).toMatchObject({ status: 'awaiting_approval', display: { title: '팀 회의', duration: '30분', timeZone: 'Asia/Seoul' } });
    expect(proposal.data.sentences.map((sentence: { text: string }) => sentence.text).join(' ')).not.toContain('삼십 분 일정으로');
    expect(proposal.data.sentences.map((sentence: { text: string }) => sentence.text).join(' ')).toContain('두 시 반까지');
    const actionId = proposal.data.actionId;
    transcript = '응';
    const denied = await call<any>(d.deviceToken, `/v1/actions/${actionId}/approve`, { contentHash: proposal.data.contentHash, version: proposal.data.version, channel: 'voice', audio });
    expect(denied.data).toMatchObject({ status: 'not_approved', reasonCode: 'explicit_approval_required' });
    expect(Object.keys(denied.data).sort()).toEqual(['actionId', 'reasonCode', 'sentences', 'status']);
    expect(unwrapAction(await d.stub.actionStatus(actionId))).toMatchObject({ status: 'cancelled', outcomeCode: 'not_approved' });
    expect(await runInDurableObject(d.stub, (_, state) => state.storage.sql.exec('SELECT envelope,draft_id FROM actions WHERE id=?', actionId).one())).toMatchObject({ envelope: '', draft_id: null });
    transcript = '내일 오후 세 시 새 일정 추가해';
    const next = await call<any>(d.deviceToken, '/v1/actions/proposals', propose());
    expect(next.response.status).toBe(200);
    expect(next.data.status).toBe('awaiting_approval');
    transcript = '추가해';
    const approved = await call<any>(d.deviceToken, `/v1/actions/${next.data.actionId}/approve`, { contentHash: next.data.contentHash, version: next.data.version, channel: 'voice', audio });
    expect(approved.data).toMatchObject({ status: 'holding', executeAt: Date.now() + approved.data.holdAudioMs + 14_500, serverNow: Date.now() });
    expect(approved.data.holdAudioMs).toBe(holdAudioDurationMs(actionHoldSentence));
    expect(approved.data.holdSentences[0].text).toBe("취소하려면 '취소'라고 말씀하세요.");
    const retry = await call<any>(d.deviceToken, `/v1/actions/${next.data.actionId}/approve`, { contentHash: next.data.contentHash, version: next.data.version, channel: 'parked_button' });
    expect(retry.data).toMatchObject({ executeAt: approved.data.executeAt, holdAudioMs: approved.data.holdAudioMs });
    expect(unwrapAction(await d.stub.actionStatus(next.data.actionId)).status).toBe('holding');
  });

  it('keeps polite dictation in an action proposal transcript', async () => {
    const d = await connected();
    const message = { id: 'reply-message', threadId: 'reply-thread', internalDate: String(Date.now()), labelIds: ['INBOX'], payload: { mimeType: 'text/plain', headers: [
      { name: 'From', value: 'Alex Kim <alex@example.com>' }, { name: 'Subject', value: '회의 확인' }, { name: 'Message-ID', value: '<reply-message@example.com>' },
    ], body: { data: mailText('회의 확인 부탁드립니다.') } } };
    const gmail = fetchMock.get('https://gmail.googleapis.com');
    gmail.intercept({ path: /^\/gmail\/v1\/users\/me\/messages\?/ }).reply(200, { messages: [{ id: message.id, threadId: message.threadId }] }).persist();
    gmail.intercept({ path: `/gmail/v1/users/me/messages/${message.id}?format=full` }).reply(200, message).persist();
    gmail.intercept({ path: `/gmail/v1/users/me/threads/${message.threadId}?format=full` }).reply(200, { messages: [message] }).persist();
    const scan = await call<any>(d.deviceToken, '/v1/mail/scan', { tripId: 'trip-action-http' });
    expect(scan.data.candidate.canReply).toBe(true);
    transcript = '네, 내일 확인하겠습니다. 감사합니다.';
    const proposal = await call<any>(d.deviceToken, '/v1/actions/proposals', { tripId: 'trip-action-http', requestId: crypto.randomUUID(), kind: 'mail_reply', candidateId: scan.data.candidate.candidateId, audio });
    expect(proposal.response.status).toBe(200);
    expect(proposal.data.status).toBe('awaiting_approval');
    expect(proposal.data.display.body).toBe('네, 내일 확인하겠습니다. 감사합니다.');
  });

  it('uses a mail subject for the calendar title, spoken readback, and inserted event', async () => {
    const d = await connected();
    scanMail('회의 일정 안내', '11월 10일 오후 네 시에 팀 회의가 잡혔습니다.');
    const scan = await call<any>(d.deviceToken, '/v1/mail/scan', { tripId: 'mail-calendar-title' });
    expect(scan.response.status).toBe(200);
    expect(scan.data.candidate.canAddCalendar).toBe(true);
    const proposal = await call<any>(d.deviceToken, '/v1/actions/proposals', {
      tripId: 'mail-calendar-title', requestId: crypto.randomUUID(), kind: 'calendar_insert', candidateId: scan.data.candidate.candidateId,
    });
    expect(proposal.response.status).toBe(200);
    expect(proposal.data).toMatchObject({ status: 'awaiting_approval', display: {
      title: '회의 일정 안내', start: '2026-11-10T16:00:00+09:00', end: '2026-11-10T16:30:00+09:00', timeZone: 'Asia/Seoul',
    } });
    expect(proposal.data.sentences.map((sentence: { text: string }) => sentence.text).join(' ')).toContain("'회의 일정 안내' 일정을");

    const originalFetch = globalThis.fetch;
    let inserted: any;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === 'https://www.googleapis.com' && url.pathname === '/calendar/v3/calendars/primary/events' && init?.method === 'POST') {
        inserted = JSON.parse(String(init.body));
        return Response.json({ id: inserted.id, summary: inserted.summary }, { status: 200 });
      }
      return originalFetch(input, init);
    });
    const held = await call<any>(d.deviceToken, `/v1/actions/${proposal.data.actionId}/approve`, {
      contentHash: proposal.data.contentHash, version: proposal.data.version, channel: 'parked_button',
    });
    expect(held.data.status).toBe('holding');
    vi.setSystemTime(held.data.executeAt);
    await runInDurableObject(d.stub, (agent: DeviceAgent) => agent.alarm());
    expect(inserted).toMatchObject({
      summary: '회의 일정 안내', start: { dateTime: '2026-11-10T16:00:00+09:00', timeZone: 'Asia/Seoul' },
      end: { dateTime: '2026-11-10T16:30:00+09:00', timeZone: 'Asia/Seoul' },
    });
    expect(unwrapAction(await d.stub.actionStatus(proposal.data.actionId)).status).toBe('succeeded');
  });

  it.each([
    ['Re: Fwd: 주간 회의', '주간 회의'],
    ['Re: Fwd: FW: 주간 회의', '주간 회의'],
    ['  rE: fWd: fW: 주간 회의  ', '주간 회의'],
    ['A01 회의', '메일 일정'],
    ['A+B 회의', '메일 일정'],
    ['Re: FW:', '메일 일정'],
    ['회의 '.repeat(50), '메일 일정'],
  ])('normalizes mail calendar subject %j to safe title %j', async (subject, title) => {
    const d = await connected();
    scanMail(subject, '11월 10일 오후 네 시에 팀 회의가 잡혔습니다.');
    const scan = await call<any>(d.deviceToken, '/v1/mail/scan', { tripId: 'mail-calendar-subject-policy' });
    const proposal = await call<any>(d.deviceToken, '/v1/actions/proposals', {
      tripId: 'mail-calendar-subject-policy', requestId: crypto.randomUUID(), kind: 'calendar_insert', candidateId: scan.data.candidate.candidateId,
    });
    expect(proposal.response.status).toBe(200);
    expect(proposal.data).toMatchObject({ status: 'awaiting_approval', display: { title } });
    expect(proposal.data.sentences.map((sentence: { text: string }) => sentence.text).join(' ')).toContain(`'${title}' 일정을`);
  });

  it('retains a mail subject when calendar date or time needs clarification', async () => {
    const d = await connected();
    scanMail('Fwd: 주간 회의', '11월 10일 팀 회의가 잡혔습니다.');
    const scan = await call<any>(d.deviceToken, '/v1/mail/scan', { tripId: 'mail-calendar-clarification' });
    const proposal = await call<any>(d.deviceToken, '/v1/actions/proposals', {
      tripId: 'mail-calendar-clarification', requestId: crypto.randomUUID(), kind: 'calendar_insert', candidateId: scan.data.candidate.candidateId,
    });
    expect(proposal.data.status).toBe('needs_clarification');
    transcript = '오후 네 시';
    const clarified = await call<any>(d.deviceToken, `/v1/actions/${proposal.data.actionId}/clarify`, { version: proposal.data.version, audio });
    expect(clarified.response.status).toBe(200);
    expect(clarified.data).toMatchObject({ status: 'awaiting_approval', display: { title: '주간 회의', start: '2026-11-10T16:00:00+09:00' } });
    expect(clarified.data.sentences.map((sentence: { text: string }) => sentence.text).join(' ')).toContain("'주간 회의' 일정을");
  });

  it.each([['3 second', 3], ['13 second', 13]])('measures %s hold WAV duration from PCM data across RIFF chunks', (_label, seconds) => {
    const samples = 16_000 * seconds;
    const bytes = new Uint8Array(56 + samples * 2), view = new DataView(bytes.buffer);
    const put = (at: number, value: string) => [...value].forEach((char, i) => { bytes[at + i] = char.charCodeAt(0); });
    put(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); put(8, 'WAVE');
    put(12, 'JUNK'); view.setUint32(16, 4, true); put(20, 'test');
    put(24, 'fmt '); view.setUint32(28, 16, true); view.setUint16(32, 1, true); view.setUint16(34, 1, true);
    view.setUint32(36, 16000, true); view.setUint32(40, 32000, true); view.setUint16(44, 2, true); view.setUint16(46, 16, true);
    put(48, 'data'); view.setUint32(52, samples * 2, true);
    // Duration is derived from the validated data chunk, not a presumed 44-byte header.
    const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
    expect(holdAudioDurationMs({ text: '보류', audio: { data: encoded, mimeType: 'audio/wav' } })).toBe(seconds * 1000);
  });

  it('allows one clarification and rejects a second clarification attempt', async () => {
    const d = await connected();
    transcript = '내일 두 시 팀 회의 추가해';
    const first = await call<any>(d.deviceToken, '/v1/actions/proposals', propose());
    expect(first.data.status).toBe('needs_clarification');
    transcript = '오후';
    const clarified = await call<any>(d.deviceToken, `/v1/actions/${first.data.actionId}/clarify`, { version: first.data.version, audio });
    expect(clarified.data).toMatchObject({ status: 'awaiting_approval', version: first.data.version + 1 });
    const second = await call<any>(d.deviceToken, `/v1/actions/${first.data.actionId}/clarify`, { version: clarified.data.version, audio });
    expect(second.response.status).toBe(409);
  });

  it('hands calendar-add turns to pending readback and preserves the old non-action response shape', async () => {
    const d = await connected();
    transcript = '내일 오후 두 시 팀 회의 일정 추가해';
    const actionTurn = await call<any>(d.deviceToken, '/v1/turns', { tripId: 'turn-action', audio });
    expect(actionTurn.response.status).toBe(200);
    expect(actionTurn.data.actionProposalPending).toMatchObject({ actionId: expect.any(String), version: 1 });
    expect(actionTurn.data).not.toHaveProperty('actionProposal');
    expect(actionTurn.data.sentences.map((s: any) => s.text)).toEqual(['일정 내용을 확인할게요.']);
    const readback = await call<any>(d.deviceToken, `/v1/actions/${actionTurn.data.actionProposalPending.actionId}/readback`, {});
    expect(readback.response.status).toBe(200);
    expect(readback.data).toMatchObject({ status: 'awaiting_approval', display: { title: '팀 회의' } });
    transcript = '오늘 일정 알려줘';
    const ordinaryTurn = await call<any>(d.deviceToken, '/v1/turns', { tripId: 'turn-ordinary', audio });
    expect(ordinaryTurn.response.status).toBe(200);
    expect(ordinaryTurn.data).not.toHaveProperty('actionProposal');
    expect(Object.keys(ordinaryTurn.data).sort()).toEqual(['sentences', 'transcript', 'turnId']);
  });

  it('does not log a private proposal title', async () => {
    const d = await connected();
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    transcript = '내일 오후 두 시 PRIVATE CALENDAR TITLE 7421 추가해';
    const result = await call<any>(d.deviceToken, '/v1/actions/proposals', propose());
    expect(result.response.status).toBe(200);
    expect(result.data.display.title).toBe('PRIVATE CALENDAR TITLE 7421');
    expect(JSON.stringify(logs.mock.calls)).not.toContain('PRIVATE CALENDAR TITLE 7421');
  });
  it.each(['initial', 'holding'])('attributes %s approval RPC rejection after hold speech to rpc', async mode => {
    const d = await connected();
    transcript = '내일 오후 두 시 팀 회의 추가해';
    const first = await call<any>(d.deviceToken, '/v1/actions/proposals', propose());
    const approval = { contentHash: first.data.contentHash, version: first.data.version, channel: 'parked_button' };
    if (mode === 'holding') expect((await call<any>(d.deviceToken, `/v1/actions/${first.data.actionId}/approve`, approval)).data.status).toBe('holding');
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await call<any>(d.deviceToken, `/v1/actions/${first.data.actionId}/approve`, { ...approval, contentHash: 'f'.repeat(64) });
    expect(result.response.status).toBe(409);
    expect(logs).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logs.mock.calls[0][0])).toMatchObject({ error: { name: 'ActionError', stage: 'rpc' } });
  });
  it.each([
    ['mail_reply', '보내.', 'holding'], ['mail_reply', '호네', 'not_approved'], ['mail_reply', '취소.', 'not_approved'], ['mail_reply', '보내지 마.', 'not_approved'],
    ['calendar_insert', '추가해.', 'holding'], ['calendar_insert', '호네', 'not_approved'], ['calendar_insert', '취소.', 'not_approved'], ['calendar_insert', '추가하지 마.', 'not_approved'],
  ] as const)('uses the %s approval prompt and exact-matches %s as %s', async (kind, spoken, expectedStatus) => {
    const d = await approvalProposal(kind);
    const inference = vi.spyOn(ai, 'run');
    transcript = spoken;
    const body = { contentHash: d.proposal.contentHash, version: d.proposal.version, channel: 'voice', audio };
    const result = await call<any>(d.deviceToken, `/v1/actions/${d.proposal.actionId}/approve`, body);
    expect(result.response.status).toBe(200);
    expect(result.data.status).toBe(expectedStatus);
    const stt = (inference.mock.calls as unknown as Array<[string, Record<string, unknown>]>).filter(([model]) => model.includes('whisper'));
    expect(stt).toHaveLength(1);
    expect(stt[0][0]).toBe('@cf/openai/whisper-large-v3-turbo');
    const prompt = stt[0][1].initial_prompt;
    expect(typeof prompt).toBe('string');
    const words = String(prompt).split(': ')[1]?.split('. ').map(word => word.replace(/\.$/, ''));
    const approvals = kind === 'mail_reply' ? ['보내', '보내줘', '보내 줘'] : ['추가해', '추가해줘', '추가해 줘', '등록해', '등록해줘', '등록해 줘'];
    for (const word of [...approvals, '취소', '아니', '하지 마', kind === 'mail_reply' ? '보내지 마' : '추가하지 마']) expect(words).toContain(word);
    for (const otherKind of kind === 'mail_reply' ? ['추가해', '등록해'] : ['보내']) expect(words).not.toContain(otherKind);
    if (expectedStatus === 'holding') {
      // An already approved retry keeps its schedule and does not start another STT.
      const retry = await call<any>(d.deviceToken, `/v1/actions/${d.proposal.actionId}/approve`, body);
      expect(retry.data).toMatchObject({ status: 'holding', executeAt: result.data.executeAt, holdAudioMs: result.data.holdAudioMs });
      expect((inference.mock.calls as unknown as Array<[string]>).filter(([model]) => model.includes('whisper'))).toHaveLength(1);
    } else {
      expect(Object.keys(result.data).sort()).toEqual(['actionId', 'reasonCode', 'sentences', 'status']);
      expect(result.data.sentences[0].text).toBe(kind === 'mail_reply' ? '보내지 않았어요.' : '일정을 추가하지 않았어요.');
      expect(unwrapAction(await d.stub.actionStatus(d.proposal.actionId))).toMatchObject({ status: 'cancelled', outcomeCode: 'not_approved' });
      expect(unwrapAction(await d.stub.actionStatus(d.proposal.actionId))).not.toHaveProperty('executeAt');
      expect(await runInDurableObject(d.stub, (_, state) => state.storage.sql.exec('SELECT envelope,draft_id FROM actions WHERE id=?', d.proposal.actionId).one())).toMatchObject({ envelope: '', draft_id: null });
      transcript = '내일 오후 세 시 새 일정 추가해';
      const next = await call<any>(d.deviceToken, '/v1/actions/proposals', propose());
      expect(next.response.status).toBe(200);
      expect(next.data.status).toBe('awaiting_approval');
    }
  });
  it.each(['mail_reply', 'calendar_insert'] as const)('does not infer %s approval from silence or send the prompt to AI', async kind => {
    const d = await approvalProposal(kind);
    const inference = vi.spyOn(ai, 'run');
    const result = await call<any>(d.deviceToken, `/v1/actions/${d.proposal.actionId}/approve`, { contentHash: d.proposal.contentHash, version: d.proposal.version, channel: 'voice', audio: pcmAudio(0) });
    expect(result.data.status).toBe('not_approved');
    expect(Object.keys(result.data).sort()).toEqual(['actionId', 'reasonCode', 'sentences', 'status']);
    expect(result.data.sentences[0].text).toBe(kind === 'mail_reply' ? '보내지 않았어요.' : '일정을 추가하지 않았어요.');
    expect((inference.mock.calls as unknown as Array<[string]>).filter(([model]) => model.includes('whisper'))).toHaveLength(0);
    expect(unwrapAction(await d.stub.actionStatus(d.proposal.actionId))).toMatchObject({ status: 'cancelled', outcomeCode: 'not_approved' });
    expect(await runInDurableObject(d.stub, (_, state) => state.storage.sql.exec('SELECT envelope,draft_id FROM actions WHERE id=?', d.proposal.actionId).one())).toMatchObject({ envelope: '', draft_id: null });
  });
  it.each(['mail_reply', 'calendar_insert'] as const)('does not hedge slow %s approval transcription; the primary transcript remains authoritative', async kind => {
    const d = await approvalProposal(kind);
    fakeRequestClock();
    const primaryStarted = barrier();
    const original = ai.run;
    let finishPrimary!: (value: { text: string }) => void;
    let sttCalls = 0;
    ai.run = vi.fn((model: string, input: Record<string, unknown>) => {
      if (model.includes('whisper')) {
        expect(model).toBe('@cf/openai/whisper-large-v3-turbo');
        if (++sttCalls > 1) return Promise.resolve({ text: '분해' });
        return new Promise(resolve => { finishPrimary = resolve; primaryStarted.resolve(); });
      }
      return (original as any)(model, input);
    }) as any;
    const pending = call<any>(d.deviceToken, `/v1/actions/${d.proposal.actionId}/approve`, { contentHash: d.proposal.contentHash, version: d.proposal.version, channel: 'voice', audio });
    await primaryStarted.promise;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(sttCalls).toBe(1);
    finishPrimary({ text: kind === 'mail_reply' ? '보내.' : '추가해.' });
    const result = await pending;
    expect(sttCalls).toBe(1);
    expect(result.data.status).toBe('holding');
    expect(unwrapAction(await d.stub.actionStatus(d.proposal.actionId)).status).toBe('holding');
  });
  it('does not start a hedge for slow action dictation; the primary transcript remains authoritative', async () => {
    const d = await connected();
    fakeRequestClock();
    const primaryStarted = barrier();
    const original = ai.run;
    let finishPrimary!: (value: { text: string }) => void;
    let sttCalls = 0;
    ai.run = vi.fn((model: string, input: unknown) => {
      if (model.includes('whisper')) {
        expect(model).toBe('@cf/openai/whisper-large-v3-turbo');
        if (++sttCalls > 1) return Promise.resolve({ text: '분해' });
        return new Promise(resolve => { finishPrimary = resolve; primaryStarted.resolve(); });
      }
      return (original as any)(model, input);
    }) as any;
    const pending = call<any>(d.deviceToken, '/v1/actions/proposals', propose());
    await primaryStarted.promise;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(sttCalls).toBe(1);
    finishPrimary({ text: '내일 오후 두 시 팀 회의 추가해' });
    const result = await pending;
    expect(sttCalls).toBe(1);
    expect(result.response.status).toBe(200);
    expect(result.data.status).toBe('awaiting_approval');
  });
  it.each(['holding', 'preparing', 'sending', 'unknown'] as const)('does not let a late voice rejection change a %s action', async status => {
    const d = await approvalProposal('calendar_insert');
    if (status === 'holding') {
      const held = await call<any>(d.deviceToken, `/v1/actions/${d.proposal.actionId}/approve`, {
        contentHash: d.proposal.contentHash, version: d.proposal.version, channel: 'parked_button',
      });
      expect(held.data.status).toBe('holding');
    } else {
      await runInDurableObject(d.stub, (_, state) => state.storage.sql.exec('UPDATE actions SET status=? WHERE id=?', status, d.proposal.actionId));
    }
    transcript = '호네';
    const result = await call<any>(d.deviceToken, `/v1/actions/${d.proposal.actionId}/approve`, {
      contentHash: d.proposal.contentHash, version: d.proposal.version, channel: 'voice', audio,
    });
    expect(result.response.status).toBe(200);
    if (status === 'holding') expect(result.data.status).toBe('holding');
    else expect(result.data).toMatchObject({ status: 'not_approved', reasonCode: 'explicit_approval_required' });
    expect(unwrapAction(await d.stub.actionStatus(d.proposal.actionId)).status).toBe(status);
    expect(unwrapAction(await d.stub.actionStatus(d.proposal.actionId)).outcomeCode).toBeUndefined();
  });
  it.each(['awaiting_approval', 'needs_clarification'] as const)('supersedes a prior %s action when a new proposal arrives', async status => {
    const d = await connected();
    transcript = status === 'needs_clarification' ? '내일 두 시 팀 회의 추가해' : '내일 오후 두 시 팀 회의 추가해';
    const first = await call<any>(d.deviceToken, '/v1/actions/proposals', propose());
    expect(first.data.status).toBe(status);
    if (status === 'needs_clarification') {
      await runInDurableObject(d.stub, (_, state) => state.storage.sql.exec("UPDATE actions SET status='needs_clarification' WHERE id=?", first.data.actionId));
    }
    transcript = '내일 오후 세 시 새 일정 추가해';
    const next = await call<any>(d.deviceToken, '/v1/actions/proposals', propose());
    expect(next.response.status).toBe(200);
    expect(next.data.status).toBe('awaiting_approval');
    expect(unwrapAction(await d.stub.actionStatus(first.data.actionId))).toMatchObject({ status: 'cancelled', outcomeCode: 'superseded' });
  });
  it.each(['holding', 'preparing', 'sending', 'unknown'] as const)('keeps %s as a blocker for a calendar turn and returns fixed speech', async status => {
    const d = await connected();
    transcript = '내일 오후 두 시 기존 일정 추가해';
    const proposal = await call<any>(d.deviceToken, '/v1/actions/proposals', propose());
    await runInDurableObject(d.stub, (_, state) => state.storage.sql.exec('UPDATE actions SET status=? WHERE id=?', status, proposal.data.actionId));
    const prompts: string[] = [];
    ai.run = vi.fn(async (model: string, input: { prompt?: string }) => {
      if (model.includes('whisper')) return { text: '내일 오후 세 시 새 일정 추가해' };
      if (model.includes('melotts')) {
        prompts.push(input.prompt ?? '');
        return new Response(wavBytes.slice(), { headers: { 'Content-Type': 'audio/wav' } });
      }
      return new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ sentence: '오늘 일정은 없어요.' }) } }] }) + '\n'));
        controller.close();
      } });
    }) as any;
    const result = await call<any>(d.deviceToken, '/v1/turns', { tripId: `blocked-turn-${status}`, audio });
    expect(result.response.status).toBe(200);
    expect(result.data.sentences.map((sentence: { text: string }) => sentence.text)).toEqual(['지금은 일정을 추가할 수 없어요.']);
    expect(result.data).not.toHaveProperty('actionProposal');
    expect(result.data).not.toHaveProperty('actionProposalPending');
    expect(prompts).toEqual([]); // The fixed bundled MeloTTS asset fits the short turn budget without a live synthesis call.
    expect(unwrapAction(await d.stub.actionStatus(proposal.data.actionId)).status).toBe(status);
  });
  it('keeps turn, confirm, and action dictation request prompts unchanged', async () => {
    const d = await connected();
    const inference = vi.spyOn(ai, 'run');
    transcript = '오늘 일정 알려줘';
    expect((await call<any>(d.deviceToken, '/v1/turns', { tripId: 'prompt-turn', audio })).response.status).toBe(200);
    transcript = '네';
    expect((await call<any>(d.deviceToken, '/v1/confirm', { audio })).response.status).toBe(200);
    transcript = '내일 오후 두 시 팀 회의 추가해';
    expect((await call<any>(d.deviceToken, '/v1/actions/proposals', propose())).response.status).toBe(200);
    const stt = (inference.mock.calls as unknown as Array<[string, Record<string, unknown>]>).filter(([model]) => model.includes('whisper'));
    expect(stt).toHaveLength(3);
    expect(stt[0][1]).not.toHaveProperty('initial_prompt');
    expect(stt[1][1].initial_prompt).toBe('짧은 한국어 확인 응답입니다. 가능한 응답: ' + REPLIES.join('. ') + '.');
    expect(stt[2][1]).not.toHaveProperty('initial_prompt');
  });
  it.each(['mail_reply', 'calendar_insert'] as const)('anchors %s hold responses to each HTTP receive time while retaining the CAS schedule', async kind => {
    const d = await approvalProposal(kind);
    const original = ai.run;
    let sttCalls = 0;
    ai.run = vi.fn(async (model: string, input: unknown) => {
      if (model.includes('whisper')) {
        sttCalls++;
        vi.setSystemTime(Date.now() + 2_300);
        return { text: kind === 'mail_reply' ? '보내.' : '추가해.' };
      }
      return (original as any)(model, input);
    }) as any;
    const body = { contentHash: d.proposal.contentHash, version: d.proposal.version, channel: 'voice', audio };
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const receivedAt = Date.now();
    const first = await call<any>(d.deviceToken, `/v1/actions/${d.proposal.actionId}/approve`, body);
    expect(first.response.status).toBe(200);
    expect(first.data.status).toBe('holding');
    expect(first.data.serverNow).toBe(receivedAt);
    expect(first.data.executeAt).toBe(Date.now() + first.data.holdAudioMs + 14_500);
    expect(first.data.executeAt - first.data.serverNow).toBe(2_300 + first.data.holdAudioMs + 14_500);
    expect(JSON.parse(logs.mock.calls[0][0]).sttMs).toBe(2_300);

    vi.setSystemTime(Date.now() + 300);
    const retryReceivedAt = Date.now();
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    let read = false, pathRead = false;
    const reader = {
      read: async () => {
        if (read) return { done: true, value: undefined };
        read = true;
        vi.setSystemTime(retryReceivedAt + 300);
        return { done: false, value: bytes };
      },
      cancel: async () => {},
    };
    const request = {
      get url() {
        // A later deadline/handler timestamp must not replace fetch-entry time.
        if (!pathRead) { pathRead = true; vi.setSystemTime(retryReceivedAt + 40); }
        return `https://mobi.invalid/v1/actions/${d.proposal.actionId}/approve`;
      },
      method: 'POST',
      headers: new Headers({ Authorization: `Bearer ${d.deviceToken}`, 'Content-Type': 'application/json' }),
      body: { getReader: () => reader },
    } as unknown as Request;
    const response = await worker.fetch(request, { ...env, AI: ai } as Env);
    expect(response.status).toBe(200);
    const retry = await response.json() as any;
    expect(retry).toMatchObject({ status: 'holding', executeAt: first.data.executeAt, holdAudioMs: first.data.holdAudioMs, serverNow: retryReceivedAt });
    expect(retry.executeAt - retry.serverNow).toBe(first.data.executeAt - retryReceivedAt);
    expect(JSON.parse(logs.mock.calls[1][0]).sttMs).toBe(0);
    expect(sttCalls).toBe(1);
    const stored = unwrapAction(await d.stub.actionStatus(d.proposal.actionId));
    expect(stored).toMatchObject({ status: 'holding', executeAt: first.data.executeAt });
  });
  it.each([
    ['GET', '/v1/capabilities', 8500], ['POST', '/v1/mail/scan', 8500], ['POST', '/v1/actions/proposals', 8500],
    ['POST', '/v1/actions/example/clarify', 8500], ['POST', '/v1/actions/example/approve', 8500],
    ['POST', '/v1/actions/example/cancel', 8500], ['POST', '/v1/actions/example/readback', 8500], ['GET', '/v1/actions/example', 8500],
    ['POST', '/v1/turns', 6000], ['POST', '/v1/confirm', 4800], ['POST', '/v1/briefings', 4800], ['GET', '/v1/today', 4800],
  ] as const)('keeps the exact %s %s outer deadline at %i ms', async (method, path, milliseconds) => {
    fakeRequestClock();
    for (const [elapsed, expectedStatus] of [[milliseconds - 1, 401], [milliseconds, 502]]) {
      const admitted = barrier();
      let release!: (known: boolean) => void;
      const gate = new Promise<boolean>(resolve => { release = resolve; });
      const bindings = { ...env, PAIRING: { getByName: () => ({ knowsDevice: () => { admitted.resolve(); return gate; } }) } } as unknown as Env;
      const request = new Request(`https://mobi.invalid${path}`, { method, headers: { Authorization: `Bearer 11111111-1111-4111-8111-111111111111.${'b'.repeat(64)}` } });
      const pending = worker.fetch(request, bindings);
      await admitted.promise;
      await vi.advanceTimersByTimeAsync(elapsed);
      // The deadline wrapper must still allow a normal response at limit-1,
      // and reject the same completed RPC at the exact deadline.
      release(false);
      expect((await pending).status).toBe(expectedStatus);
    }
  });
  it.each(['action', 'turn'] as const)('applies the intended budget to a %s with 2.9 s STT and 2.5 s TTS', async route => {
    const d = await connected();
    fakeRequestClock();
    let releaseStt!: () => void, releaseTts!: () => void;
    const sttGate = new Promise<void>(resolve => { releaseStt = resolve; });
    const ttsGate = new Promise<void>(resolve => { releaseTts = resolve; });
    const sttStarted = barrier(), ttsStarted = barrier();
    let ttsCalls = 0;
    ai.run = vi.fn(async (model: string) => {
      if (model.includes('whisper')) {
        sttStarted.resolve();
        await sttGate;
        return { text: route === 'action' ? '내일 오후 두 시 회의 추가해' : '오늘 일정 알려줘' };
      }
      if (model.includes('melotts')) {
        if (++ttsCalls === (route === 'turn' ? 1 : 2)) ttsStarted.resolve();
        await ttsGate;
        return new Response(wavBytes.slice(), { headers: { 'Content-Type': 'audio/wav' } });
      }
      throw new Error('Unexpected model');
    }) as any;
    const startedAt = Date.now();
    const pending = route === 'action'
      ? call<any>(d.deviceToken, '/v1/actions/proposals', propose())
      : call<any>(d.deviceToken, '/v1/turns', { tripId: 'slow-turn', audio });
    await sttStarted.promise;
    await vi.advanceTimersByTimeAsync(2_900);
    releaseStt();
    if (route === 'action') {
      await ttsStarted.promise;
      await vi.advanceTimersByTimeAsync(2_500);
      releaseTts();
      const result = await pending;
      expect(Date.now() - startedAt).toBe(5_400);
      expect(result.response.status).toBe(200);
      expect(result.data.status).toBe('awaiting_approval');
      expect(result.data.sentences).toHaveLength(3);
    } else {
      // The 6 s deadline admits TTS after 2.9 s STT; its 900 ms ready margin still caps completion at 5.1 s.
      await ttsStarted.promise;
      await vi.advanceTimersByTimeAsync(2_500);
      releaseTts();
      const result = await pending;
      expect(result.response.status).toBe(200);
      expect(result.data.sentences).toEqual([failureSentences.question]);
      expect(ttsCalls).toBe(1);
      expect(Date.now() - startedAt).toBe(5_400);
      expect(result.data).not.toHaveProperty('actionProposal');
    }
  });
});
