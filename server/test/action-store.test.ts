import { env, fetchMock, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceAgent } from '../src/state';
import { encryptTokens } from '../src/token-crypto';
import { GOOGLE_SCOPES } from '../src/google';

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-08T00:00:00Z'));
  await runInDurableObject(env.DEVICE_AGENTS.getByName('alarm-fixture'), (_, state) => {
    vi.spyOn(Object.getPrototypeOf(state.storage), 'setAlarm').mockResolvedValue(undefined);
  });
  fetchMock.activate(); fetchMock.disableNetConnect();
  fetchMock.get('https://www.googleapis.com').intercept({ path: '/calendar/v3/calendars/primary' }).reply(200, { timeZone: 'Asia/Seoul' }).persist();
});
afterEach(() => { fetchMock.deactivate(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function setup() {
  const id = crypto.randomUUID(), stub = env.DEVICE_AGENTS.getByName(id);
  await stub.register('fixture-device-hash');
  const envelope = await encryptTokens(env.TOKEN_ENCRYPTION_KEY!, id, { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600000, scopes: [...GOOGLE_SCOPES, 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'] });
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec('UPDATE device SET paired=1');
    state.storage.sql.exec('INSERT INTO google_connection(id,device_id,envelope) VALUES(1,?,?)', id, JSON.stringify(envelope));
  });
  return stub;
}
const input = (requestId = crypto.randomUUID()) => ({ tripId: 'trip', requestId, kind: 'calendar_insert' as const, text: '2026년 11월 10일 오후 두 시 팀 회의 일정 추가해줘' });
const propose = (s: any, i = input()) => s.actionPropose(i, 0, 'a'.repeat(64), Date.now() + 4800);
const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function proposeMail(s: any, requestId = crypto.randomUUID()) {
  const mail = { id: 'message-1', threadId: 'thread-1', internalDate: String(Date.now()), labelIds: ['INBOX'], payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Alex Kim <alex@example.com>' }, { name: 'Subject', value: '회의 확인' }, { name: 'Message-ID', value: '<message-1@example.com>' }], body: { data: b64('회의 일정이 괜찮으신가요?') } } };
  const gmail = fetchMock.get('https://gmail.googleapis.com');
  gmail.intercept({ path: /^\/gmail\/v1\/users\/me\/messages\?/ }).reply(200, { messages: [{ id: mail.id, threadId: mail.threadId }] }).persist();
  gmail.intercept({ path: `/gmail/v1/users/me/messages/${mail.id}?format=full` }).reply(200, mail).persist();
  gmail.intercept({ path: `/gmail/v1/users/me/threads/${mail.threadId}?format=full` }).reply(200, { messages: [mail] }).persist();
  const candidate = await s.actionScan('trip', 0, Date.now() + 4800);
  return s.actionPropose({ tripId: 'trip', requestId, kind: 'mail_reply', candidateId: candidate.candidateId, text: '내일 보내드릴게요.' }, 0, 'a'.repeat(64), Date.now() + 4800);
}
async function rejected(stub: any, operation: (agent: DeviceAgent) => Promise<unknown>) {
  return runInDurableObject(stub, async (agent: DeviceAgent) => {
    try { const result = await operation(agent) as { actionError?: number }; return result?.actionError ? `ACTION_HTTP_${result.actionError}` : 'unexpected_success'; }
    catch (cause) { return (cause as Error).message; }
  });
}

describe('durable approved action lifecycle', () => {
  it.each(['A01회의', '프로젝트 007 회의', 'v2 회의', '회의 2A', '회의 1,2,3번', '회의 3.5', '회의 1234567'])('rejects an unreadable calendar title before leaving an active action: %s', async title => {
    const s: any = await setup();
    const result = await propose(s, { ...input(), text: `내일 오후 두 시 ${title} 추가해` });
    expect(result.status).toBe('rejected');
    expect(result.contentHash).toBeUndefined();
    const count = await runInDurableObject(s, (_, st) => st.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM actions WHERE status='awaiting_approval'").one().count);
    expect(count).toBe(0);
  });
  it('does not approve a title whose unsupported symbols would be removed from readback', async () => {
    const s: any = await setup();
    const result = await propose(s, { ...input(), text: '내일 오후 두 시 A+B 팀 회의 추가해' });
    expect(result.status).toBe('rejected');
    expect(result.contentHash).toBeUndefined();
  });
  it('keeps the calendar readback year and speech parts stable across New Year', async () => {
    vi.setSystemTime(new Date('2026-12-31T14:59:59Z'));
    const s: any = await setup();
    const proposal = await s.actionPropose({ ...input(), text: '2027-01-01T10:00 팀 회의 추가해' }, 0, 'a'.repeat(64), Date.now() + 4800);
    expect(proposal.status).toBe('awaiting_approval');
    expect(proposal.speechText).toContain('2027년 1월 1일');
    const originalParts = proposal.calendarSpeechParts;

    vi.setSystemTime(new Date('2026-12-31T15:00:01Z'));
    const reread = await s.actionReadback(proposal.actionId, 0);
    expect(reread.speechText).toBe(proposal.speechText);
    expect(reread.calendarSpeechParts).toEqual(originalParts);
  });
  it('returns the same action for concurrent identical request IDs instead of a UNIQUE conflict', async () => {
    const s: any = await setup(), same = input();
    const results = await Promise.all(Array.from({ length: 8 }, () => propose(s, same)));
    expect(results.every(p => p.status === 'awaiting_approval')).toBe(true);
    expect(new Set(results.map(p => p.actionId)).size).toBe(1);
    const count = await runInDurableObject(s, (_, st) => st.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM actions').one().count);
    expect(count).toBe(1);
  });
  it('recovers the requestId row when both final lookups miss before the UNIQUE insert', async () => {
    const s = await setup(), same = input();
    const results = await runInDurableObject(s, async (agent: DeviceAgent) => {
      const store = (agent as any).actions;
      const existing = store.existing.bind(store);
      let lookups = 0;
      vi.spyOn(store, 'existing').mockImplementation(async (...args: unknown[]) => ++lookups <= 4 ? null : existing(...args));
      return Promise.all(Array.from({ length: 2 }, () => store.propose(same, 0, 'a'.repeat(64), Date.now() + 4800).catch((cause: Error) => ({ error: cause.message }))));
    });
    expect(results.every((p: any) => p.status === 'awaiting_approval')).toBe(true);
    expect(results[0].actionId).toBe(results[1].actionId);
  });
  it('does not repopulate an old account payload when disconnect wins during encryption', async () => {
    const s: any = await setup();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (algorithm, key, data) => {
      if (typeof algorithm === 'object' && 'additionalData' in algorithm) { entered(); await gate; }
      return encrypt(algorithm, key, data);
    });
    const pending = propose(s);
    await started;
    fetchMock.get('https://oauth2.googleapis.com').intercept({ method: 'POST', path: '/revoke' }).reply(200, {});
    await s.disconnectGoogle();
    release();
    expect(await pending).toEqual({ actionError: 403 });
    const rows = await runInDurableObject(s, (_, st) => st.storage.sql.exec('SELECT id FROM actions').toArray());
    expect(rows).toEqual([]);
  });
  it('expires pending proposals, enforces a single active action, and deduplicates request IDs', async () => {
    const s: any = await setup(), i = input();
    const p = await propose(s, i);
    expect(p.status).toBe('awaiting_approval');
    expect((await propose(s, i)).actionId).toBe(p.actionId);
    expect(await rejected(s, a => a.actionPropose(i, 0, 'b'.repeat(64), Date.now() + 4800))).toBe('ACTION_HTTP_409');
    const replacement = await propose(s);
    expect(replacement.status).toBe('awaiting_approval');
    expect((await s.actionStatus(p.actionId)).outcomeCode).toBe('superseded');
    vi.setSystemTime(Date.now() + 90001);
    expect((await s.actionStatus(p.actionId)).status).toBe('cancelled');
    expect((await s.actionStatus(replacement.actionId)).status).toBe('expired');
  });
  it.each(['awaiting_approval', 'needs_clarification'] as const)('not_approved terminates %s and immediately frees the slot', async status => {
    const s: any = await setup();
    const p = await propose(s);
    if (status === 'needs_clarification') await runInDurableObject(s, (_, st) => st.storage.sql.exec("UPDATE actions SET status='needs_clarification' WHERE id=?", p.actionId));
    const result = await s.actionNotApproved(p.actionId, 0, p.version, p.contentHash);
    expect(result).toMatchObject({ actionId: p.actionId, status: 'cancelled', cancelled: true });
    expect((await s.actionStatus(p.actionId)).outcomeCode).toBe('not_approved');
    expect(await runInDurableObject(s, (_, st) => st.storage.sql.exec('SELECT envelope,draft_id FROM actions WHERE id=?', p.actionId).one())).toMatchObject({ envelope: '', draft_id: null });
    expect((await propose(s)).status).toBe('awaiting_approval');
  });
  it.each(['holding', 'preparing', 'sending', 'unknown', 'succeeded'] as const)('not_approved leaves %s untouched', async status => {
    const s: any = await setup(), p = await propose(s);
    await runInDurableObject(s, (_, st) => st.storage.sql.exec('UPDATE actions SET status=? WHERE id=?', status, p.actionId));
    expect(await s.actionNotApproved(p.actionId, 0, p.version, p.contentHash)).toMatchObject({ cancelled: false, status });
    expect((await s.actionStatus(p.actionId)).outcomeCode).toBeUndefined();
  });
  it('rejects stale not_approved version or hash without changing the proposal', async () => {
    const s: any = await setup(), p = await propose(s);
    expect(await rejected(s, a => a.actionNotApproved(p.actionId, 0, p.version + 1, p.contentHash))).toBe('ACTION_HTTP_409');
    expect(await rejected(s, a => a.actionNotApproved(p.actionId, 0, p.version, 'f'.repeat(64)))).toBe('ACTION_HTTP_409');
    expect((await s.actionStatus(p.actionId)).status).toBe('awaiting_approval');
  });
  it.each(['awaiting_approval', 'needs_clarification'] as const)('supersedes old %s for both calendar and mail proposals', async oldStatus => {
    for (const newKind of ['calendar_insert', 'mail_reply'] as const) {
      const s: any = await setup();
      const first = await propose(s);
      if (oldStatus === 'needs_clarification') await runInDurableObject(s, (_, st) => st.storage.sql.exec("UPDATE actions SET status='needs_clarification' WHERE id=?", first.actionId));
      const next = newKind === 'calendar_insert' ? await propose(s) : await proposeMail(s);
      expect(next.actionError).toBeUndefined();
      expect((await s.actionStatus(first.actionId))).toMatchObject({ status: 'cancelled', outcomeCode: 'superseded' });
      expect((await s.actionStatus(next.actionId)).status).toBe('awaiting_approval');
      expect(await runInDurableObject(s, (_, st) => st.storage.sql.exec('SELECT envelope,draft_id FROM actions WHERE id=?', first.actionId).one())).toMatchObject({ envelope: '', draft_id: null });
    }
  });
  it.each(['holding', 'preparing', 'sending', 'unknown'] as const)('blocks every new proposal while old action is %s', async status => {
    const s: any = await setup(), p = await propose(s);
    await runInDurableObject(s, (_, st) => st.storage.sql.exec('UPDATE actions SET status=? WHERE id=?', status, p.actionId));
    expect(await propose(s)).toEqual({ actionError: 409 });
    expect((await s.actionStatus(p.actionId)).status).toBe(status);
  });
  it('holds for the audio plus 14.5 seconds, permits twenty approve retries, and writes one event across six alarm replays', async () => {
    const s: any = await setup(), p = await propose(s);
    const command = { contentHash: p.contentHash, version: p.version, channel: 'parked_button' };
    const results = await Promise.all(Array.from({ length: 20 }, () => s.actionApprove(p.actionId, command, 0)));
    expect(new Set(results.map((r: any) => r.executeAt)).size).toBe(1);
    expect(results[0].executeAt).toBe(Date.now() + results[0].holdAudioMs + 14_500);
    let writes = 0;
    fetchMock.get('https://www.googleapis.com').intercept({ method: 'POST', path: '/calendar/v3/calendars/primary/events?sendUpdates=none' }).reply(() => { writes++; return { statusCode: 200, data: '{}' }; }).persist();
    await runInDurableObject(s, (a: DeviceAgent) => a.alarm()); expect(writes).toBe(0);
    vi.setSystemTime(results[0].executeAt);
    for (let n = 0; n < 6; n++) await runInDurableObject(s, (a: DeviceAgent) => a.alarm());
    expect(writes).toBe(1);
    expect((await s.actionStatus(p.actionId)).status).toBe('succeeded');
    expect(await propose(s)).toEqual({ actionError: 409 });
  });
  it('cancels before execution and never reports a sending action cancelled', async () => {
    const s: any = await setup(), p = await propose(s);
    expect(await s.actionCancel(p.actionId)).toMatchObject({ cancelled: true, status: 'cancelled' });
    const q = await propose(s);
    await runInDurableObject(s, (_, st) => st.storage.sql.exec("UPDATE actions SET status='sending', send_attempted=1 WHERE id=?", q.actionId).toArray());
    expect(await s.actionCancel(q.actionId)).toMatchObject({ cancelled: false, status: 'sending' });
    await runInDurableObject(s, (a: DeviceAgent) => a.alarm());
    expect((await s.actionStatus(q.actionId)).status).toBe('unknown');
  });
  it('rejects stale hash/version and invalidates pending actions on disconnect without logging private text', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const s: any = await setup(), p = await propose(s);
    expect(await rejected(s, a => a.actionApprove(p.actionId, { contentHash: 'f'.repeat(64), version: 1, channel: 'parked_button' }, 0))).toBe('ACTION_HTTP_409');
    expect(await rejected(s, a => a.actionApprove(p.actionId, { contentHash: p.contentHash, version: 2, channel: 'parked_button' }, 0))).toBe('ACTION_HTTP_409');
    fetchMock.get('https://oauth2.googleapis.com').intercept({ method: 'POST', path: '/revoke' }).reply(200, {});
    await s.disconnectGoogle();
    expect((await s.actionStatus(p.actionId)).status).toBe('cancelled');
    expect(JSON.stringify(logs.mock.calls)).not.toContain('팀 회의');
  });
});
