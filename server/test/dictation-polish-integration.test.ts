import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceActions } from '../src/actions';
import { GOOGLE_SCOPES } from '../src/google';
import { decryptPrivateValue } from '../src/token-crypto';

const source = '어 내일 오후 세 시에 자료를 보내겠습니다';
const finalBody = '내일 오후 세 시에 자료를 보내겠습니다.';
const key = env.TOKEN_ENCRYPTION_KEY!;
const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decodeUtf8 = (text: string) => new TextDecoder().decode(Uint8Array.from(atob(text), char => char.charCodeAt(0)));
const mail = { id: 'dictation-message', threadId: 'dictation-thread', internalDate: String(Date.now()), labelIds: ['INBOX'], payload: { mimeType: 'text/plain', headers: [
  { name: 'From', value: 'Alex Kim <alex@example.com>' }, { name: 'Subject', value: '자료 확인' }, { name: 'Message-ID', value: '<dictation-message@example.com>' },
], body: { data: b64('목요일 회의 시간이 괜찮으신가요?') } } };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-08T00:00:00Z'));
  await runInDurableObject(env.DEVICE_AGENTS.getByName('dictation-polish-fixture'), (_agent, state) => {
    vi.spyOn(Object.getPrototypeOf(state.storage), 'setAlarm').mockResolvedValue(undefined);
  });
  mail.internalDate = String(Date.now());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== 'https://gmail.googleapis.com') throw new Error('Unexpected network request');
    if (url.pathname.endsWith('/messages') && (!init?.method || init.method === 'GET')) return Response.json({ messages: [{ id: mail.id, threadId: mail.threadId }] });
    if (url.pathname.includes('/threads/') && (!init?.method || init.method === 'GET')) return Response.json({ messages: [mail] });
    if (url.pathname.includes('/messages/') && (!init?.method || init.method === 'GET')) return Response.json(mail);
    if (init?.method === 'POST' && url.pathname.endsWith('/drafts')) return Response.json({ id: 'dictation-draft' });
    if ((!init?.method || init.method === 'GET') && url.pathname.endsWith('/drafts/dictation-draft')) return Response.json({ id: 'dictation-draft', message: {
      id: 'draft-message', threadId: mail.threadId, payload: { mimeType: 'text/plain', headers: [
        { name: 'To', value: 'alex@example.com' }, { name: 'Subject', value: 'Re: 자료 확인' },
        { name: 'In-Reply-To', value: '<dictation-message@example.com>' }, { name: 'References', value: '<dictation-message@example.com>' },
        { name: 'Message-ID', value: '<dictation-draft@mail.gmail.com>' },
      ], body: { data: b64(finalBody) } },
    } });
    if (init?.method === 'POST' && url.pathname.endsWith('/drafts/send')) return Response.json({ id: 'sent-message', threadId: mail.threadId });
    throw new Error(`Unexpected Gmail request ${init?.method ?? 'GET'} ${url.pathname}`);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

function store(state: DurableObjectState) {
  return new DeviceActions(state, env, {
    epoch: () => 0,
    connection: async () => ({ epoch: 0, tokens: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3_600_000, scopes: [...GOOGLE_SCOPES, 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'] } }),
    timeZone: async () => 'Asia/Seoul', invalidateCalendar: () => {},
  });
}
async function proposalFor(actions: DeviceActions, text: string, requestId = 'dictation-request') {
  const candidate = await actions.scan('dictation-trip', 0, Date.now() + 4_800);
  expect(candidate?.canReply, JSON.stringify({ candidate, calls: vi.mocked(fetch).mock.calls.map(([i]) => String(i)) })).toBe(true);
  return { candidate: candidate!, proposal: await actions.propose({ tripId: 'dictation-trip', requestId, kind: 'mail_reply', candidateId: candidate!.candidateId, text }, 0, 'a'.repeat(64), Date.now() + 4_800) };
}
async function storedPrivate(state: DurableObjectState, actionId: string) {
  const row = state.storage.sql.exec<{ epoch: number; version: number; envelope: string; content_hash: string }>('SELECT epoch,version,envelope,content_hash FROM actions WHERE id=?', actionId).one();
  const aad = new TextEncoder().encode(`mobi:action:${state.id.toString()}:${row.epoch}:${actionId}:${row.version}`);
  const payload = await decryptPrivateValue(key, aad, JSON.parse(row.envelope)) as any;
  return { row, payload };
}
async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

describe('mail dictation polish integration', () => {
  it('stores the polished body as one approved snapshot and uses it for draft verification and send', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runInDurableObject(env.DEVICE_AGENTS.getByName(crypto.randomUUID()), async (_agent, state) => {
      const actions = store(state);
      const { proposal } = await proposalFor(actions, source);
      expect(proposal.status).toBe('awaiting_approval');
      expect(proposal.display.body).toBe(finalBody);
      expect(proposal.speechText).toContain(`'${finalBody}'`);
      const { row, payload } = await storedPrivate(state, proposal.actionId);
      expect(payload.reply.body).toBe(finalBody);
      expect(payload.display.body).toBe(finalBody);
      expect(payload.readback).toContain(`'${finalBody}'`);
      expect(row.content_hash).toBe(await digest({ id: proposal.actionId, epoch: row.epoch, version: row.version, p: payload }));
      expect(proposal.contentHash).toBe(row.content_hash);

      const held = await actions.approve(proposal.actionId, { contentHash: proposal.contentHash!, version: proposal.version, channel: 'parked_button' }, 0, 1_000);
      expect(held.status).toBe('holding');
      vi.setSystemTime(Date.now() + 15_500);
      await actions.alarm();
      expect((await actions.status(proposal.actionId)).status).toBe('succeeded');
      const calls = vi.mocked(fetch).mock.calls;
      const draftCreate = calls.find(([input, init]) => new URL(String(input)).pathname.endsWith('/drafts') && init?.method === 'POST');
      expect(draftCreate).toBeDefined();
      expect(calls.filter(([input, init]) => new URL(String(input)).pathname.endsWith('/drafts') && init?.method === 'POST')).toHaveLength(1);
      const sendCalls = calls.filter(([input, init]) => new URL(String(input)).pathname.endsWith('/drafts/send') && init?.method === 'POST');
      expect(sendCalls).toHaveLength(1);
      expect(JSON.parse(String(sendCalls[0][1]?.body))).toEqual({ id: 'dictation-draft' });
      expect(calls.some(([input]) => new URL(String(input)).pathname.includes('/ai/'))).toBe(false);
      const requestBody = JSON.parse(String(draftCreate![1]?.body));
      const raw = decodeUtf8(requestBody.message.raw.replace(/-/g, '+').replace(/_/g, '/'));
      const encodedBody = raw.split('\r\n\r\n')[1].trim();
      expect(decodeUtf8(encodedBody)).toBe(finalBody);
      expect(logs.mock.calls.map(args => JSON.stringify(args)).join('\n')).not.toContain(source);
      expect(logs.mock.calls.map(args => JSON.stringify(args)).join('\n')).not.toContain(finalBody);
      const polishLog = logs.mock.calls.map(args => JSON.parse(String(args[0]))).find(value => value.reason === 'applied');
      expect(polishLog).toEqual({ reason: 'applied', rawLength: [...source].length, finalLength: [...finalBody].length });
      expect(Object.keys(polishLog).sort()).toEqual(['finalLength', 'rawLength', 'reason']);
    });
  });

  it.each(['A01 회의를 보내겠습니다.', '010 1234 5678', '가'.repeat(121)])('does not polish unsafe or oversized raw text into an approved action: %s', async raw => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runInDurableObject(env.DEVICE_AGENTS.getByName(crypto.randomUUID()), async (_agent, state) => {
      const { proposal } = await proposalFor(store(state), raw, crypto.randomUUID());
      expect(proposal.status).toBe('rejected');
      expect(proposal.contentHash).toBeUndefined();
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM actions WHERE status='awaiting_approval'").one().count).toBe(0);
      expect(logs.mock.calls.map(args => JSON.parse(String(args[0])))).toContainEqual({ reason: 'raw_invalid', rawLength: [...raw].length, finalLength: [...raw].length });
      for (const args of logs.mock.calls) expect(Object.keys(JSON.parse(String(args[0]))).sort()).toEqual(['finalLength', 'rawLength', 'reason']);
    });
  });

  it('keeps the approved proposal when writing its diagnostic log throws', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('log unavailable'); });
    await runInDurableObject(env.DEVICE_AGENTS.getByName(crypto.randomUUID()), async (_agent, state) => {
      const { proposal } = await proposalFor(store(state), source, crypto.randomUUID());
      expect(proposal.status).toBe('awaiting_approval');
      expect(proposal.display.body).toBe(finalBody);
    });
  });

  it('replays the stored polished text after a cold DeviceActions reconstruction without another polish diagnostic', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runInDurableObject(env.DEVICE_AGENTS.getByName(crypto.randomUUID()), async (_agent, state) => {
      const firstStore = store(state);
      const { proposal } = await proposalFor(firstStore, source);
      const firstLogs = logs.mock.calls.length;
      const replacement = store(state);
      const replay = await replacement.propose({ tripId: 'dictation-trip', requestId: 'dictation-request', kind: 'mail_reply', candidateId: 'missing-after-reconstruction', text: '새 입력으로 덮어쓰면 안 됩니다.' }, 0, 'a'.repeat(64), Date.now() + 4_800);
      expect(replay).toEqual(proposal);
      expect(replay.display.body).toBe(finalBody);
      expect(logs.mock.calls).toHaveLength(firstLogs);
    });
  });
});
