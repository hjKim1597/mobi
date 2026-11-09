import { env, fetchMock, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceAgent } from '../src/state';
import { decryptPrivateValue, encryptTokens } from '../src/token-crypto';
import { GOOGLE_SCOPES } from '../src/google';
import { unwrapAction } from '../src/actions';
import { sanitizeTtsText } from '../src/tts';

const gmailScopes = [...GOOGLE_SCOPES, 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'];
const privateMarker = 'PRIVATEREPLYMARKER';
const b64 = (text: string) => {
  const bytes = new TextEncoder().encode(text); let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const mail = {
  id: 'message-1', threadId: 'thread-1', internalDate: String(Date.parse('2026-11-08T00:00:00Z')),
  labelIds: ['INBOX'], payload: { mimeType: 'text/plain', headers: [
    { name: 'From', value: 'Alex Kim <alex@example.com>' }, { name: 'Subject', value: '회의 일정 확인' },
    { name: 'Message-ID', value: '<message-1@example.com>' },
  ], body: { data: b64('목요일 회의 시간이 괜찮으신가요?') } },
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-08T00:00:00Z'));
  await runInDurableObject(env.DEVICE_AGENTS.getByName('alarm-fixture'), (_, state) => {
    vi.spyOn(Object.getPrototypeOf(state.storage), 'setAlarm').mockResolvedValue(undefined);
  });
  fetchMock.activate(); fetchMock.disableNetConnect();
});
afterEach(() => { fetchMock.deactivate(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function setup() {
  const id = crypto.randomUUID(), stub: any = env.DEVICE_AGENTS.getByName(id);
  await stub.register('fixture-device-hash');
  const envelope = await encryptTokens(env.TOKEN_ENCRYPTION_KEY!, id, { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3_600_000, scopes: gmailScopes });
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec('UPDATE device SET paired=1');
    state.storage.sql.exec('INSERT INTO google_connection(id,device_id,envelope) VALUES(1,?,?)', id, JSON.stringify(envelope));
    vi.spyOn(Object.getPrototypeOf(state.storage), 'setAlarm').mockResolvedValue(undefined);
  });
  return stub;
}
function mailReadMocks() {
  const gmail = fetchMock.get('https://gmail.googleapis.com');
  gmail.intercept({ path: /^\/gmail\/v1\/users\/me\/messages\?/ }).reply(200, { messages: [{ id: mail.id, threadId: mail.threadId }] }).persist();
  gmail.intercept({ path: `/gmail/v1/users/me/messages/${mail.id}?format=full` }).reply(200, mail).persist();
  gmail.intercept({ path: `/gmail/v1/users/me/threads/${mail.threadId}?format=full` }).reply(200, { messages: [mail] }).persist();
}
async function proposeReply(stub: any, body = privateMarker) {
  mailReadMocks();
  const candidate = unwrapAction(await stub.actionScan('trip-1', 0, Date.now() + 4_800));
  expect(candidate?.canReply).toBe(true);
  return unwrapAction(await stub.actionPropose({ tripId: 'trip-1', requestId: crypto.randomUUID(), kind: 'mail_reply', candidateId: candidate.candidateId, text: body }, 0, 'a'.repeat(64), Date.now() + 4_800));
}
async function approve(stub: any, proposal: any) {
  const command = { contentHash: proposal.contentHash, version: proposal.version, channel: 'parked_button' };
  return Promise.all(Array.from({ length: 20 }, async () => unwrapAction(await stub.actionApprove(proposal.actionId, command, 0))));
}
const rewrittenMessageId = '<gmail-rewrite-123@mail.gmail.com>';
function knownDraft(actionId: string, body = privateMarker, messageId = `<mobi-${actionId}@mobi.invalid>`) {
  return { id: 'draft-1', message: { id: 'draft-message', threadId: mail.threadId, payload: { mimeType: 'text/plain', headers: [
    { name: 'To', value: 'alex@example.com' }, { name: 'Subject', value: 'Re: 회의 일정 확인' },
    { name: 'In-Reply-To', value: '<message-1@example.com>' }, { name: 'References', value: '<message-1@example.com>' },
    { name: 'Message-ID', value: messageId },
  ], body: { data: b64(body) } } } };
}
function mockDraftAndSend(options: { createError?: boolean; sendError?: boolean; actionId?: string; edited?: boolean; readError?: boolean; rewriteMessageId?: boolean } = {}) {
  const counts = { create: 0, send: 0, deleted: 0, duplicateCreate: 0, duplicateSend: 0 };
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (url.origin === 'https://gmail.googleapis.com') {
      if (method === 'POST' && url.pathname === '/gmail/v1/users/me/drafts') {
        if (++counts.create > 1) counts.duplicateCreate++;
        if (options.createError) throw new Error('simulated draft timeout');
        return Response.json({ id: 'draft-1' });
      }
      if (method === 'GET' && url.pathname === '/gmail/v1/users/me/drafts/draft-1') {
        if (options.readError) throw new Error('fixture draft read failed');
        return Response.json(knownDraft(options.actionId ?? '', options.edited ? '승인하지 않은 다른 본문' : privateMarker, options.rewriteMessageId ? rewrittenMessageId : undefined));
      }
      if (method === 'DELETE' && url.pathname === '/gmail/v1/users/me/drafts/draft-1') {
        counts.deleted++; return new Response(null, { status: 204 });
      }
      if (method === 'POST' && url.pathname === '/gmail/v1/users/me/drafts/send') {
        if (++counts.send > 1) counts.duplicateSend++;
        if (options.sendError) throw new Error('simulated send timeout');
        return Response.json({ id: 'sent-1', threadId: mail.threadId });
      }
    }
    return originalFetch(input, init);
  });
  return counts;
}
async function alarm(stub: any) { await runInDurableObject(stub, (a: DeviceAgent) => a.alarm()); }
async function alarmCaptureDraftAtSendCas(stub: any, actionId: string) {
  let captured: { draft_id: string; version: number; epoch: number } | undefined;
  let doId = '';
  await runInDurableObject(stub, async (agent: DeviceAgent, state) => {
    const sql = state.storage.sql;
    const originalExec = sql.exec.bind(sql) as (query: string, ...bindings: unknown[]) => { one<T>(): T };
    vi.spyOn(sql, 'exec').mockImplementation(((query: string, ...bindings: unknown[]) => {
      if (query.startsWith("UPDATE actions SET status='sending'")) {
        captured = originalExec('SELECT draft_id,version,epoch FROM actions WHERE id=?', actionId).one();
      }
      return originalExec(query, ...bindings);
    }) as never);
    doId = state.id.toString();
    await agent.alarm();
  });
  return { captured, doId };
}
async function reconstructedAlarm(stub: any) {
  await runInDurableObject(stub, async (_, state) => { await new DeviceAgent(state, env).alarm(); });
}
async function rejected(stub: any, action: (agent: DeviceAgent) => Promise<unknown>) {
  return runInDurableObject(stub, async (agent: DeviceAgent) => {
    try { await action(agent); return 'unexpected_success'; }
    catch (cause) { return (cause as Error).message; }
  });
}

describe('Durable Object Gmail reply execution', () => {
  it.each(['1,2,3번 안건에 동의합니다.', '1, 2, 3번 안건', '3.5', '10:30', '1234567', '2024.', '"2024"', '숫자 2!', '안건 1,234', '010 1234', '프로젝트 007 회의', 'A01회의', 'v2', '2A'])('rejects structurally ambiguous or oversized numeric expressions: %s', async body => {
    const stub = await setup(), proposal = await proposeReply(stub, body);
    expect(proposal.status).toBe('rejected');
    expect(proposal.speechText).toBe('한 문장으로 짧게 다시 말씀해 주세요.');
    expect(proposal.contentHash).toBeUndefined();
  });
  it.each([
    ['2024', '이천이십사'], ['2026년 3명 10시', '이천이십육년 삼명 십시'], ['안건 1 2 3번', '안건 일 이 삼번'],
    ['123456', '십이만 삼천사백오십육'],
  ])('preserves each accepted digit run and every other character: %s', async (body, expected) => {
    const stub = await setup(), proposal = await proposeReply(stub, body);
    expect(proposal.status).toBe('awaiting_approval');
    expect(sanitizeTtsText(proposal.speechText, 'reply_readback')).toBe(`Alex Kim 님에게 '${expected}'라고 회신할게요. 보내려면 '보내'라고 말씀해 주세요.`);
  });
  it.each([
    ['Alex (Sales)', 'Alex'], ['김민수 (기획팀)', '김민수'], ['😀', '보낸 분'], ['Alex   Kim', 'Alex Kim'],
  ])('builds a synthesis-safe spoken sender without changing the recipient: %s', async (sender, spoken) => {
    const stub = await setup();
    const fixture = { ...mail, payload: { ...mail.payload, headers: mail.payload.headers.map(h => h.name === 'From' ? { name: 'From', value: `${sender} <alex@example.com>` } : h) } };
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === 'https://gmail.googleapis.com') return Promise.resolve(Response.json(url.pathname.endsWith('/messages') ? { messages: [{ id: mail.id }] } : url.pathname.includes('/threads/') ? { messages: [fixture] } : fixture));
      return originalFetch(input, init);
    });
    const proposal = await proposeReply(stub, '네 가능합니다.');
    expect(proposal.status).toBe('awaiting_approval');
    expect(proposal.display.sender).toBe(spoken);
    expect(sanitizeTtsText(proposal.speechText, 'reply_readback')).toBe(`${spoken} 님에게 '네 가능합니다.'라고 회신할게요. 보내려면 '보내'라고 말씀해 주세요.`);
  });
  it('rejects a full readback that fails synthesis policy before leaving an active row', async () => {
    const stub = await setup();
    const fixture = { ...mail, payload: { ...mail.payload, headers: mail.payload.headers.map(h => h.name === 'From' ? { name: 'From', value: 'Sender1234567 <alex@example.com>' } : h) } };
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === 'https://gmail.googleapis.com') return Promise.resolve(Response.json(url.pathname.endsWith('/messages') ? { messages: [{ id: mail.id }] } : url.pathname.includes('/threads/') ? { messages: [fixture] } : fixture));
      return originalFetch(input, init);
    });
    expect((await proposeReply(stub, '네 가능합니다.')).status).toBe('rejected');
    expect(await runInDurableObject(stub, (_, state) => state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM actions WHERE status='awaiting_approval'").one().count)).toBe(0);
  });
  it.each(['edited', 'read_error'] as const)('never sends a known draft whose approved snapshot cannot be verified: %s', async mode => {
    const stub = await setup(), proposal = await proposeReply(stub);
    const results = await approve(stub, proposal);
    const counts = mockDraftAndSend({ actionId: proposal.actionId, edited: mode === 'edited', readError: mode === 'read_error' });
    vi.setSystemTime(results[0].executeAt);
    for (let n = 0; n < 6; n++) await alarm(stub);
    expect(await stub.actionStatus(proposal.actionId)).toMatchObject({ status: 'failed', outcomeCode: 'draft_mismatch' });
    expect(counts.create).toBe(1); expect(counts.send).toBe(0); expect(counts.deleted).toBe(1);
    expect(await runInDurableObject(stub, (_, state) => state.storage.sql.exec<{ attempted: number }>('SELECT send_attempted AS attempted FROM actions WHERE id=?', proposal.actionId).one().attempted)).toBe(0);
  });
  it.each(['1+1로 진행해 주세요.', '찬성:반대 3:4입니다.', '50%입니다.', 'A-B입니다.', '가/나', '가&나', '네…', '네。', '네\n아니요', '네\t아니요', 'café', '안녕😀', '가(나)', '가_나'])('rejects a body whose meaning cannot be read verbatim: %s', async body => {
    const stub = await setup(), proposal = await proposeReply(stub, body);
    expect(proposal.status).toBe('rejected');
    expect(proposal.speechText).toBe('한 문장으로 짧게 다시 말씀해 주세요.');
    expect(proposal.contentHash).toBeUndefined();
  });
  it.each([
    ['네,괜찮아요!', '네,괜찮아요!'], ['"확인"이라고 답할게요.', '"확인"이라고 답할게요.'],
    ["It's fine.", "It's fine."], ['금액은 3원입니다.', '금액은 삼원입니다.'], ['수량은 2개입니다.', '수량은 이개입니다.'],
  ])('only changes numeric pronunciation in every accepted reply readback: %s', async (body, spoken) => {
    const stub = await setup(), proposal = await proposeReply(stub, body);
    expect(proposal.status).toBe('awaiting_approval');
    expect(sanitizeTtsText(proposal.speechText, 'reply_readback')).toBe(`Alex Kim 님에게 '${spoken}'라고 회신할게요. 보내려면 '보내'라고 말씀해 주세요.`);
  });
  it('scans, approves idempotently, holds for the audio plus 14.5 seconds, then creates and sends exactly once', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stub = await setup(), proposal = await proposeReply(stub);
    expect(proposal.status).toBe('awaiting_approval');
    expect(proposal.speechText).toContain(privateMarker);
    const results = await approve(stub, proposal);
    expect(new Set(results.map((r: any) => r.executeAt)).size).toBe(1);
    expect(results[0].executeAt).toBe(Date.now() + results[0].holdAudioMs + 14_500);
    const counts = mockDraftAndSend({ actionId: proposal.actionId, rewriteMessageId: true });
    await alarm(stub); expect((await stub.actionStatus(proposal.actionId)).status).toBe('holding');
    vi.setSystemTime(results[0].executeAt);
    const atSendCas = await alarmCaptureDraftAtSendCas(stub, proposal.actionId);
    for (let i = 0; i < 5; i++) await alarm(stub);
    // A successful terminal state and one observed request of each kind prove no retry.
    const terminal = await stub.actionStatus(proposal.actionId);
    expect(counts.create, JSON.stringify(terminal)).toBe(1);
    expect(counts.send).toBe(1);
    expect(terminal.status).toBe('succeeded');
    expect(atSendCas.captured).toBeDefined();
    const privateDraftAtCas = await decryptPrivateValue(env.TOKEN_ENCRYPTION_KEY!, new TextEncoder().encode(`mobi:action:${atSendCas.doId}:${atSendCas.captured!.epoch}:${proposal.actionId}:${atSendCas.captured!.version}`), JSON.parse(atSendCas.captured!.draft_id));
    expect(privateDraftAtCas).toMatchObject({ draftId: 'draft-1', messageId: rewrittenMessageId });
    const row = await runInDurableObject(stub, (_, state) => state.storage.sql.exec<{ envelope: string; draft_id: string }>('SELECT envelope,draft_id FROM actions WHERE id=?', proposal.actionId).one());
    expect(row.envelope).not.toContain(privateMarker);
    expect(row.draft_id).not.toContain(privateMarker);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(privateMarker);
  });

  it('marks lost send response unknown and never sends again across six reconciliation alarms', async () => {
    const stub = await setup(), proposal = await proposeReply(stub);
    const results = await approve(stub, proposal); const followup = mockDraftAndSend({ sendError: true, actionId: proposal.actionId });
    vi.setSystemTime(results[0].executeAt); await alarm(stub);
    expect((await stub.actionStatus(proposal.actionId)).status).toBe('unknown');
    expect(followup.duplicateSend).toBe(0);
    const gmail = fetchMock.get('https://gmail.googleapis.com');
    gmail.intercept({ path: /^\/gmail\/v1\/users\/me\/messages\?/ }).reply(200, { messages: [] }).persist();
    for (let i = 0; i < 6; i++) { vi.setSystemTime(Date.now() + 60_000); await alarm(stub); }
    expect((await stub.actionStatus(proposal.actionId)).status).toBe('unknown');
  });

  it('persists Gmail’s rewritten draft Message-ID before the send CAS and reconciles with it after reconstruction', async () => {
    const stub = await setup(), proposal = await proposeReply(stub);
    const results = await approve(stub, proposal);
    const followup = mockDraftAndSend({
      sendError: true, actionId: proposal.actionId, rewriteMessageId: true,
    });
    vi.setSystemTime(results[0].executeAt); await alarm(stub);
    expect(followup.send).toBe(1);
    expect((await stub.actionStatus(proposal.actionId)).status).toBe('unknown');
    const { row, doId } = await runInDurableObject(stub, (_, state) => ({
      row: state.storage.sql.exec<{ draft_id: string; status: string; send_attempted: number; version: number; epoch: number; reconcile_at: number }>('SELECT draft_id,status,send_attempted,version,epoch,reconcile_at FROM actions WHERE id=?', proposal.actionId).one(),
      doId: state.id.toString(),
    }));
    expect(row.status).toBe('unknown');
    expect(row.send_attempted).toBe(1);
    expect(row.draft_id).not.toContain('gmail-rewrite-123');
    const privateDraft = await decryptPrivateValue(env.TOKEN_ENCRYPTION_KEY!, new TextEncoder().encode(`mobi:action:${doId}:${row.epoch}:${proposal.actionId}:${row.version}`), JSON.parse(row.draft_id));
    expect(privateDraft).toMatchObject({ draftId: 'draft-1', messageId: rewrittenMessageId });

    let searchQuery = '';
    const draftFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === 'https://gmail.googleapis.com' && url.pathname === '/gmail/v1/users/me/messages' && url.search) {
        searchQuery = url.searchParams.get('q') ?? '';
        return Response.json({ messages: [{ id: 'sent-1' }] });
      }
      if (url.origin === 'https://gmail.googleapis.com' && url.pathname === '/gmail/v1/users/me/messages/sent-1') {
        return Response.json({
          id: 'sent-1', threadId: mail.threadId, payload: { mimeType: 'text/plain', headers: [
            { name: 'To', value: 'alex@example.com' }, { name: 'Subject', value: 'Re: 회의 일정 확인' },
            { name: 'Message-ID', value: rewrittenMessageId },
          ], body: { data: b64(privateMarker) } },
        });
      }
      return draftFetch(input, init);
    });
    const due = await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec('UPDATE actions SET reconcile_at=? WHERE id=?', Date.now(), proposal.actionId);
      return state.storage.sql.exec<{ status: string; send_attempted: number; envelope: string; reconcile_at: number; reconcile_attempts: number; epoch: number }>('SELECT status,send_attempted,envelope,reconcile_at,reconcile_attempts,epoch FROM actions WHERE id=?', proposal.actionId).one();
    });
    expect(due).toMatchObject({ status: 'unknown', send_attempted: 1, reconcile_attempts: 0, epoch: 0 });
    vi.setSystemTime(Date.now() + 60_000); await reconstructedAlarm(stub);
    expect(searchQuery).toBe('in:sent rfc822msgid:gmail-rewrite-123@mail.gmail.com');
    expect((await stub.actionStatus(proposal.actionId)).status).toBe('succeeded');
    for (let i = 0; i < 6; i++) { vi.setSystemTime(Date.now() + 60_000); await alarm(stub); }
    expect(followup.send).toBe(1);
  });

  it('does not fall back to the correlation ID when an unknown legacy row has no captured draft Message-ID', async () => {
    const stub = await setup(), proposal = await proposeReply(stub);
    await runInDurableObject(stub, (_, state) => state.storage.sql.exec("UPDATE actions SET status='unknown',send_attempted=1,reconcile_at=? WHERE id=?", Date.now(), proposal.actionId));
    const gmail = fetchMock.get('https://gmail.googleapis.com');
    let searches = 0;
    gmail.intercept({ path: /^\/gmail\/v1\/users\/me\/messages\?/ }).reply(() => { searches++; return { statusCode: 200, data: { messages: [] } }; }).persist();
    await alarm(stub);
    expect(searches).toBe(0);
    expect((await stub.actionStatus(proposal.actionId)).status).toBe('unknown');
  });

  it('keeps an unknown send when a Sent result has a different Message-ID', async () => {
    const stub = await setup(), proposal = await proposeReply(stub);
    const results = await approve(stub, proposal);
    const counts = mockDraftAndSend({ sendError: true, actionId: proposal.actionId, rewriteMessageId: true });
    vi.setSystemTime(results[0].executeAt); await alarm(stub);
    expect((await stub.actionStatus(proposal.actionId)).status).toBe('unknown');
    let searchQuery = '';
    const draftFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === 'https://gmail.googleapis.com' && url.pathname === '/gmail/v1/users/me/messages' && url.search) {
        searchQuery = url.searchParams.get('q') ?? '';
        return Response.json({ messages: [{ id: 'sent-1' }] });
      }
      if (url.origin === 'https://gmail.googleapis.com' && url.pathname === '/gmail/v1/users/me/messages/sent-1') {
        return Response.json({ id: 'sent-1', threadId: mail.threadId, payload: { mimeType: 'text/plain', headers: [
          { name: 'To', value: 'alex@example.com' }, { name: 'Subject', value: 'Re: 회의 일정 확인' },
          { name: 'Message-ID', value: '<different-id@mail.gmail.com>' },
        ], body: { data: b64(privateMarker) } } });
      }
      return draftFetch(input, init);
    });
    await runInDurableObject(stub, (_, state) => state.storage.sql.exec('UPDATE actions SET reconcile_at=? WHERE id=?', Date.now(), proposal.actionId));
    await reconstructedAlarm(stub);
    expect(searchQuery).toBe('in:sent rfc822msgid:gmail-rewrite-123@mail.gmail.com');
    expect((await stub.actionStatus(proposal.actionId)).status).toBe('unknown');
    expect(counts.send).toBe(1);
  });

  it('rejects a new request ID for the same source after an unknown send', async () => {
    const stub = await setup(), proposal = await proposeReply(stub);
    await runInDurableObject(stub, (_, state) => state.storage.sql.exec("UPDATE actions SET status='unknown',send_attempted=1,reconcile_at=? WHERE id=?", Date.now() + 86_400_000, proposal.actionId));
    const candidate = unwrapAction(await stub.actionScan('trip-1', 0, Date.now() + 4_800));
    const result = await stub.actionPropose({ tripId: 'trip-1', requestId: crypto.randomUUID(), kind: 'mail_reply', candidateId: candidate!.candidateId, text: privateMarker }, 0, 'b'.repeat(64), Date.now() + 4_800);
    expect(result).toMatchObject({ actionError: 409 });
  });

  it('marks lost draft creation unknown and does not create a replacement on alarm replay', async () => {
    const stub = await setup(), proposal = await proposeReply(stub);
    const results = await approve(stub, proposal); const followup = mockDraftAndSend({ createError: true });
    vi.setSystemTime(results[0].executeAt); await alarm(stub);
    expect((await stub.actionStatus(proposal.actionId)).status).toBe('unknown');
    expect(followup.duplicateCreate).toBe(0);
    for (let i = 0; i < 6; i++) { vi.setSystemTime(Date.now() + 60_000); await alarm(stub); }
    expect((await stub.actionStatus(proposal.actionId)).status).toBe('unknown');
  });

  it.each(['preparing', 'sending'] as const)('recovers a persisted %s operation as unknown without a retry', async status => {
    const stub = await setup(), proposal = await proposeReply(stub);
    await runInDurableObject(stub, (_, state) => state.storage.sql.exec('UPDATE actions SET status=?,send_attempted=? WHERE id=?', status, status === 'sending' ? 1 : 0, proposal.actionId));
    let createCalls = 0;
    fetchMock.get('https://gmail.googleapis.com').intercept({ method: 'POST', path: /^\/gmail\/v1\/users\/me\/drafts$/ }).reply(() => { createCalls++; return { statusCode: 200, data: { id: 'unexpected' } }; }).persist();
    await alarm(stub);
    expect((await stub.actionStatus(proposal.actionId)).status).toBe('unknown');
    expect(createCalls).toBe(0);
  });

  it.each(['success', 'delete_failure', 'delete_unknown', 'create_unknown'] as const)('never sends after cancellation and reports draft cleanup %s without retries', async outcome => {
    const stub = await setup(), proposal = await proposeReply(stub);
    const results = await approve(stub, proposal);
    const originalFetch = globalThis.fetch;
    let releaseDraft!: () => void;
    let startedDraft!: () => void;
    let sendCalls = 0, deleteCalls = 0;
    const draftGate = new Promise<void>(resolve => { releaseDraft = resolve; });
    const draftStarted = new Promise<void>(resolve => { startedDraft = resolve; });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (url.pathname.endsWith('/drafts') && method === 'POST') {
        startedDraft(); await draftGate;
        if (outcome === 'create_unknown') throw new Error('fixture creation response lost');
        return new Response(JSON.stringify({ id: 'draft-1' }), { status: 200 });
      }
      if (url.pathname.endsWith('/drafts/draft-1') && method === 'DELETE') {
        deleteCalls++;
        if (outcome === 'delete_unknown') throw new Error('fixture deletion response lost');
        return new Response(null, { status: outcome === 'delete_failure' ? 500 : 204 });
      }
      if (url.pathname.endsWith('/drafts/send') && method === 'POST') { sendCalls++; return new Response(JSON.stringify({ id: 'sent-1', threadId: mail.threadId }), { status: 200 }); }
      return originalFetch(input, init);
    });
    vi.setSystemTime(results[0].executeAt);
    const pending = alarm(stub);
    await draftStarted;
    let cancellation, interim;
    try {
      cancellation = await stub.actionCancel(proposal.actionId);
      interim = await stub.actionStatus(proposal.actionId);
    } finally { releaseDraft(); await pending; }
    expect(cancellation).toMatchObject({ cancelled: true, status: 'cancelled' });
    expect(interim).toMatchObject({ status: 'cancelled', outcomeCode: 'cancelled_draft_cleanup_unconfirmed' });
    expect(sendCalls).toBe(0);
    expect(deleteCalls).toBe(outcome === 'create_unknown' ? 0 : 1);
    expect(await stub.actionStatus(proposal.actionId)).toMatchObject({ status: 'cancelled', outcomeCode: outcome === 'success' ? 'user_cancelled' : 'cancelled_draft_cleanup_unconfirmed' });
    for (let n = 0; n < 6; n++) await alarm(stub);
    expect(sendCalls).toBe(0);
    expect(deleteCalls).toBe(outcome === 'create_unknown' ? 0 : 1);

    const next = await proposeReply(stub, 'SECOND PRIVATE REPLY MARKER');
    await runInDurableObject(stub, (_, state) => state.storage.sql.exec("UPDATE actions SET status='sending',send_attempted=1 WHERE id=?", next.actionId));
    expect(await stub.actionCancel(next.actionId)).toMatchObject({ cancelled: false, status: 'sending' });
  });
});
