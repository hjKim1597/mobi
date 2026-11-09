import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceActions } from '../src/actions';
import { GOOGLE_SCOPES } from '../src/google';

const b64 = (text: string) => btoa(Array.from(new TextEncoder().encode(text), byte => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function mail(id = 'message-original', sender = 'PRIVATE SENDER', subject = 'PRIVATE SUBJECT MARKER') {
  return { id, threadId: `thread-${id}`, internalDate: String(Date.now()), labelIds: ['INBOX'], payload: {
    mimeType: 'text/plain', headers: [
      { name: 'From', value: `${sender} <private-candidate@example.com>` },
      { name: 'Subject', value: subject }, { name: 'Message-ID', value: `<${id}@example.com>` },
    ], body: { data: b64('내일 오후 두 시 PRIVATE BODY MARKER 회의?') },
  } };
}
let currentMail: ReturnType<typeof mail>;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-08T00:00:00Z'));
  await runInDurableObject(env.DEVICE_AGENTS.getByName('candidate-alarm-fixture'), (_agent, state) => {
    vi.spyOn(Object.getPrototypeOf(state.storage), 'setAlarm').mockResolvedValue(undefined);
  });
  currentMail = mail();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://gmail.googleapis.com' || init?.method && init.method !== 'GET') throw new Error('Unexpected provider call');
    return Response.json(url.pathname.endsWith('/messages') ? { messages: [{ id: currentMail.id }] }
      : url.pathname.includes('/threads/') ? { messages: [currentMail] } : currentMail);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

function fresh(state: DurableObjectState, epoch = () => 0) {
  return new DeviceActions(state, env, {
    epoch, connection: async () => ({ epoch: epoch(), tokens: {
      accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3_600_000, scopes: [...GOOGLE_SCOPES],
    } }),
    timeZone: async () => 'Asia/Seoul', invalidateCalendar: () => {},
  });
}
function rows(state: DurableObjectState) {
  const table = state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='action_candidates'").one();
  expect(table.count, 'mail snapshots need durable encrypted storage').toBe(1);
  return state.storage.sql.exec<{ candidate_id: string; epoch: number; expires_at: number; envelope: string }>('SELECT * FROM action_candidates').toArray();
}
const input = (candidateId: string, kind: 'mail_reply' | 'calendar_insert' = 'mail_reply') => ({ tripId: 'candidate-flow', requestId: crypto.randomUUID(), kind, candidateId, text: kind === 'mail_reply' ? '네 가능합니다.' : undefined });
const propose = (store: DeviceActions, candidateId: string, kind: 'mail_reply' | 'calendar_insert' = 'mail_reply', epoch = 0) => store.propose(input(candidateId, kind), epoch, 'a'.repeat(64), Date.now() + 4800);

describe('encrypted durable mail candidates', () => {
  it.each(['mail_reply', 'calendar_insert'] as const)('uses a scanned candidate after instance replacement for %s', async kind => {
    await runInDurableObject(env.DEVICE_AGENTS.getByName(crypto.randomUUID()), async (_agent, state) => {
      const original = fresh(state);
      const candidate = await original.scan('candidate-flow', 0, Date.now() + 4800);
      expect(candidate?.canReply).toBe(true);
      vi.setSystemTime(Date.now() + 15_000);
      const replacement = fresh(state);
      const proposal = await propose(replacement, candidate!.candidateId, kind);
      expect(proposal.status).toBe('awaiting_approval');
      if (kind === 'mail_reply') expect(proposal.display).toMatchObject({ sender: 'PRIVATE SENDER', subject: 'PRIVATE SUBJECT MARKER', body: '네 가능합니다.' });
      else {
        expect(proposal.display).toMatchObject({ title: 'PRIVATE SUBJECT MARKER', start: '2026-11-09T14:00:00+09:00' });
        expect(proposal.speechText).toContain("'PRIVATE SUBJECT MARKER' 일정을");
        expect(proposal.speechText).not.toContain('PRIVATE BODY MARKER');
      }
    });
  });
  it('expires candidates at 90 seconds, deletes them on alarm, and returns 410 for missing IDs', async () => {
    await runInDurableObject(env.DEVICE_AGENTS.getByName(crypto.randomUUID()), async (_agent, state) => {
      const store = fresh(state), startedAt = Date.now();
      const candidate = await store.scan('candidate-flow', 0, Date.now() + 4800);
      expect(rows(state)).toHaveLength(1);
      expect(state.storage.setAlarm).toHaveBeenCalledWith(startedAt + 90_000);
      vi.setSystemTime(startedAt + 90_000);
      const replacement = fresh(state);
      await replacement.alarm();
      expect(rows(state)).toHaveLength(0);
      await expect(propose(replacement, candidate!.candidateId)).rejects.toMatchObject({ status: 410 });
      await expect(propose(replacement, 'missing-candidate')).rejects.toMatchObject({ status: 410 });
    });
  });
  it('stores no plaintext sender, address, subject, body, or message identifiers', async () => {
    await runInDurableObject(env.DEVICE_AGENTS.getByName(crypto.randomUUID()), async (_agent, state) => {
      const candidate = await fresh(state).scan('candidate-flow', 0, Date.now() + 4800);
      const saved = rows(state);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ candidate_id: candidate!.candidateId, epoch: 0, expires_at: Date.now() + 90_000 });
      expect(JSON.parse(saved[0].envelope)).toMatchObject({ v: 1, iv: expect.any(String), ciphertext: expect.any(String) });
      const serialized = JSON.stringify(saved);
      for (const secret of ['PRIVATE SENDER', 'private-candidate@example.com', 'PRIVATE SUBJECT MARKER', 'PRIVATE BODY MARKER', currentMail.id, currentMail.threadId]) expect(serialized).not.toContain(secret);
    });
  });
  it('keeps warm per-trip scans cached while cache loss cannot replace an older candidate', async () => {
    await runInDurableObject(env.DEVICE_AGENTS.getByName(crypto.randomUUID()), async (_agent, state) => {
      const original = fresh(state);
      const candidate = await original.scan('candidate-flow', 0, Date.now() + 4800);
      const calls = vi.mocked(fetch).mock.calls.length;
      currentMail = mail('message-new', 'NEW SENDER', 'NEW SUBJECT');
      expect((await original.scan('candidate-flow', 0, Date.now() + 4800))?.candidateId).toBe(candidate!.candidateId);
      expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
      const replacement = fresh(state);
      const newer = await replacement.scan('candidate-flow', 0, Date.now() + 4800);
      expect(newer!.candidateId).not.toBe(candidate!.candidateId);
      const proposal = await propose(fresh(state), candidate!.candidateId);
      expect(proposal.display).toMatchObject({ sender: 'PRIVATE SENDER', subject: 'PRIVATE SUBJECT MARKER' });
      expect(rows(state)).toHaveLength(2);
    });
  });
  it('deletes candidate snapshots on account clear and never restores them under a new epoch', async () => {
    await runInDurableObject(env.DEVICE_AGENTS.getByName(crypto.randomUUID()), async (_agent, state) => {
      let epoch = 0;
      const store = fresh(state, () => epoch);
      const candidate = await store.scan('candidate-flow', 0, Date.now() + 4800);
      expect(rows(state)).toHaveLength(1);
      store.clear(); epoch++;
      expect(rows(state)).toHaveLength(0);
      await expect(propose(fresh(state, () => epoch), candidate!.candidateId, 'mail_reply', epoch)).rejects.toMatchObject({ status: 410 });
    });
  });
  it('does not repopulate private candidates if account clear wins during candidate encryption', async () => {
    await runInDurableObject(env.DEVICE_AGENTS.getByName(crypto.randomUUID()), async (_agent, state) => {
      let epoch = 0;
      const store = fresh(state, () => epoch);
      rows(state);
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (algorithm, key, data) => {
        if (typeof algorithm === 'object' && 'additionalData' in algorithm) { entered(); await gate; }
        return encrypt(algorithm, key, data);
      });
      const pending = store.scan('candidate-flow', 0, Date.now() + 4800);
      const rejected = expect(pending).rejects.toMatchObject({ status: 403 });
      await started;
      store.clear(); epoch++;
      release();
      await rejected;
      expect(rows(state)).toHaveLength(0);
    });
  });
  it('rejects an encrypted candidate transplanted onto another candidate ID', async () => {
    await runInDurableObject(env.DEVICE_AGENTS.getByName(crypto.randomUUID()), async (_agent, state) => {
      const store = fresh(state);
      const first = await store.scan('first-trip', 0, Date.now() + 4800);
      currentMail = mail('message-new', 'NEW SENDER', 'NEW SUBJECT');
      const second = await store.scan('second-trip', 0, Date.now() + 4800);
      const other = rows(state).find(row => row.candidate_id === second!.candidateId)!;
      state.storage.sql.exec('UPDATE action_candidates SET envelope=? WHERE candidate_id=?', other.envelope, first!.candidateId);
      await expect(propose(fresh(state), first!.candidateId)).rejects.toMatchObject({ status: 410 });
      expect(state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM actions').one().count).toBe(0);
    });
  });
  it('retains clarification, approval, holding and cancellation across fresh instances', async () => {
    await runInDurableObject(env.DEVICE_AGENTS.getByName(crypto.randomUUID()), async (_agent, state) => {
      const first = await fresh(state).propose({ tripId: 'flow', requestId: crypto.randomUUID(), kind: 'calendar_insert', text: '내일 두 시 회의 추가해' }, 0, 'a'.repeat(64), Date.now() + 4800);
      expect(first.status).toBe('needs_clarification');
      vi.setSystemTime(Date.now() + 15_000);
      const clarified = await fresh(state).clarify(first.actionId, first.version, '오후', 0);
      expect(clarified.status).toBe('awaiting_approval');
      const holding = fresh(state).approve(first.actionId, { contentHash: clarified.contentHash!, version: clarified.version, channel: 'parked_button' }, 0, 200);
      expect(fresh(state).status(first.actionId)).toMatchObject({ status: 'holding', executeAt: holding.executeAt });
      expect(fresh(state).cancel(first.actionId)).toMatchObject({ status: 'cancelled', cancelled: true });
      expect(fresh(state).status(first.actionId)).toMatchObject({ status: 'cancelled' });
    });
  });
});
