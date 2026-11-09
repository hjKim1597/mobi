import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceActions, type ActionKind } from '../src/actions';
import { GOOGLE_SCOPES } from '../src/google';

const WEEK = 7 * 86_400_000;
const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function mail(id: string, age: number) {
  return { id, threadId: `thread-${id}`, internalDate: String(Date.now() - age), labelIds: ['INBOX'], payload: {
    mimeType: 'text/plain', headers: [
      { name: 'From', value: 'PRIVATE SENDER <private@example.com>' },
      { name: 'Subject', value: 'PRIVATE SUBJECT' }, { name: 'Message-ID', value: `<${id}@example.com>` },
    ], body: { data: b64('내일 오후 두 시 회의 가능하신가요?') },
  } };
}
let messages: ReturnType<typeof mail>[];
let draft: { id: string; message: { id: string; threadId: string; payload: { mimeType: string; headers: Array<{ name: string; value: string }>; body: { data: string } } } };
let sendFails: boolean, calendarFails: boolean, reconciled: boolean;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-09T00:00:00Z'));
  await runInDurableObject(env.DEVICE_AGENTS.getByName('handled-mail-alarm-fixture'), (_, state) => {
    vi.spyOn(Object.getPrototypeOf(state.storage), 'setAlarm').mockResolvedValue(undefined);
  });
  messages = [mail('private-newest-message', 0), mail('private-older-message', 1_000)];
  sendFails = calendarFails = reconciled = false;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    if (url.origin === 'https://www.googleapis.com' && url.pathname.endsWith('/events') && method === 'POST') {
      return Response.json({}, { status: calendarFails ? 400 : 200 });
    }
    if (url.origin !== 'https://gmail.googleapis.com') throw new Error('Unexpected external call');
    if (method === 'POST' && url.pathname.endsWith('/drafts')) {
      const request = JSON.parse(init!.body as string);
      const mime = new TextDecoder().decode(Uint8Array.from(atob(request.message.raw.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
      const [head, body] = mime.split('\r\n\r\n');
      draft = { id: 'fixture-draft', message: { id: 'fixture-draft-message', threadId: request.message.threadId, payload: {
        mimeType: 'text/plain', headers: head.split('\r\n').map(line => ({ name: line.slice(0, line.indexOf(':')), value: line.slice(line.indexOf(':') + 1).trim() })),
        body: { data: body.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') },
      } } };
      return Response.json({ id: draft.id });
    }
    if (method === 'POST' && url.pathname.endsWith('/drafts/send')) {
      if (sendFails) throw new Error('Simulated send response loss');
      return Response.json({ id: 'fixture-sent', threadId: draft.message.threadId });
    }
    if (method === 'GET' && url.pathname.endsWith('/drafts/fixture-draft')) return Response.json(draft);
    if (method === 'GET' && url.pathname.endsWith('/messages')) {
      if (url.searchParams.get('q')?.startsWith('in:sent')) return Response.json({ messages: reconciled ? [{ id: 'fixture-sent' }] : [] });
      return Response.json({ messages: messages.map(m => ({ id: m.id })) });
    }
    if (method === 'GET' && url.pathname.includes('/threads/')) {
      return Response.json({ messages: messages.filter(m => url.pathname.endsWith(`/${m.threadId}`)) });
    }
    if (method === 'GET' && url.pathname.endsWith('/messages/fixture-sent')) return Response.json(draft.message);
    if (method === 'GET' && url.pathname.includes('/messages/')) {
      const found = messages.find(m => url.pathname.endsWith(`/${m.id}`));
      if (found) return Response.json(found);
    }
    throw new Error('Unexpected mock provider route');
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

function fresh(state: DurableObjectState, epoch = () => 0) {
  return new DeviceActions(state, env, {
    epoch, connection: async () => ({ epoch: epoch(), tokens: {
      accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3_600_000, scopes: [...GOOGLE_SCOPES],
    } }), timeZone: async () => 'Asia/Seoul', invalidateCalendar: () => {},
  });
}
const scan = (store: DeviceActions, trip = crypto.randomUUID(), epoch = 0) => store.scan(trip, epoch, Date.now() + 8_500);
async function proposal(store: DeviceActions, kind: ActionKind) {
  const candidate = await scan(store);
  expect(candidate?.messageId).toBe('private-newest-message');
  return store.propose({ tripId: 'handled-trip', requestId: crypto.randomUUID(), kind, candidateId: candidate!.candidateId,
    ...(kind === 'mail_reply' ? { text: '네 가능합니다.' } : {}) }, 0, 'a'.repeat(64), Date.now() + 8_500);
}
async function execute(store: DeviceActions, p: Awaited<ReturnType<typeof proposal>>) {
  expect(p.status).toBe('awaiting_approval');
  const hold = store.approve(p.actionId, { contentHash: p.contentHash!, version: p.version, channel: 'parked_button' }, 0);
  vi.setSystemTime(hold.executeAt);
  await store.alarm();
}
function handledRows(state: DurableObjectState) {
  const exists = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='handled_mail'").toArray();
  return exists.length ? state.storage.sql.exec<{ message_hash: string; epoch: number; handled_at: number; expires_at: number }>('SELECT * FROM handled_mail').toArray() : [];
}

describe('successful mail actions suppress handled Gmail messages', () => {
  it.each(['mail_reply', 'calendar_insert'] as const)('skips a %s success across trips and cold instances, offering the next newest mail', async kind => {
    await runInDurableObject(env.DEVICE_AGENTS.getByName(crypto.randomUUID()), async (_, state) => {
      const store = fresh(state), p = await proposal(store, kind);
      await execute(store, p);
      expect(store.status(p.actionId).status).toBe('succeeded');
      expect((await scan(store))?.messageId).toBe('private-older-message');
      expect((await scan(fresh(state)))?.messageId).toBe('private-older-message');
    });
  });
  it('invalidates a warm trip cache when its candidate succeeds', async () => {
    await runInDurableObject(env.DEVICE_AGENTS.getByName(crypto.randomUUID()), async (_, state) => {
      const store = fresh(state), p = await proposal(store, 'calendar_insert');
      await scan(store, 'warm-trip');
      await execute(store, p);
      expect((await scan(store, 'warm-trip'))?.messageId).toBe('private-older-message');
    });
  });
  it('stores only a keyed digest with epoch and seven-day timestamps, retaining it after action cleanup', async () => {
    await runInDurableObject(env.DEVICE_AGENTS.getByName(crypto.randomUUID()), async (_, state) => {
      const store = fresh(state), p = await proposal(store, 'mail_reply');
      await execute(store, p);
      const handledAt = Date.now(), rows = handledRows(state);
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]).sort()).toEqual(['epoch', 'expires_at', 'handled_at', 'message_hash']);
      expect(rows[0]).toMatchObject({ epoch: 0, handled_at: handledAt, expires_at: handledAt + WEEK });
      expect(rows[0].message_hash).toMatch(/^[a-f0-9]{64}$/);
      const sha = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(messages[0].id));
      expect(rows[0].message_hash).not.toBe(Array.from(new Uint8Array(sha), x => x.toString(16).padStart(2, '0')).join(''));
      for (const value of [messages[0].id, messages[0].threadId, 'PRIVATE SENDER', 'PRIVATE SUBJECT', 'private@example.com']) expect(JSON.stringify(rows)).not.toContain(value);
      vi.setSystemTime(handledAt + WEEK - 1);
      await fresh(state).alarm();
      expect(handledRows(state)).toHaveLength(1);
      expect(state.storage.sql.exec('SELECT id FROM actions').toArray()).toEqual([]);
      expect(state.storage.setAlarm).toHaveBeenLastCalledWith(handledAt + WEEK);
      vi.setSystemTime(handledAt + WEEK);
      await fresh(state).alarm();
      expect(handledRows(state)).toEqual([]);
    });
  });
  it.each(['failed', 'cancelled', 'unknown', 'not_approved'] as const)('does not suppress mail for %s outcomes', async outcome => {
    await runInDurableObject(env.DEVICE_AGENTS.getByName(crypto.randomUUID()), async (_, state) => {
      const store = fresh(state), p = await proposal(store, outcome === 'unknown' ? 'mail_reply' : 'calendar_insert');
      if (outcome === 'cancelled') store.cancel(p.actionId);
      else if (outcome === 'not_approved') store.notApproved(p.actionId, 0, p.version, p.contentHash);
      else { sendFails = outcome === 'unknown'; calendarFails = outcome === 'failed'; await execute(store, p); }
      expect(store.status(p.actionId).status).toBe(outcome === 'not_approved' ? 'cancelled' : outcome);
      expect(handledRows(state)).toEqual([]);
      expect((await scan(fresh(state)))?.messageId).toBe('private-newest-message');
    });
  });
  it('marks a previously unknown reply only after read-only reconciliation confirms success', async () => {
    await runInDurableObject(env.DEVICE_AGENTS.getByName(crypto.randomUUID()), async (_, state) => {
      const store = fresh(state), p = await proposal(store, 'mail_reply');
      sendFails = true;
      await execute(store, p);
      expect(store.status(p.actionId).status).toBe('unknown');
      expect(handledRows(state)).toEqual([]);
      reconciled = true; vi.setSystemTime(Date.now() + 2_000);
      await fresh(state).alarm();
      expect(store.status(p.actionId).status).toBe('succeeded');
      expect((await scan(fresh(state)))?.messageId).toBe('private-older-message');
    });
  });
  it('keeps the mail origin through calendar clarification and instance replacement', async () => {
    messages[0].payload.body.data = b64('내일 두 시 회의 가능하신가요?');
    await runInDurableObject(env.DEVICE_AGENTS.getByName(crypto.randomUUID()), async (_, state) => {
      const p = await proposal(fresh(state), 'calendar_insert');
      expect(p.status).toBe('needs_clarification');
      const clarified = await fresh(state).clarify(p.actionId, p.version, '오후', 0);
      await execute(fresh(state), clarified);
      expect((await scan(fresh(state)))?.messageId).toBe('private-older-message');
    });
  });
  it('does not mark any mail for a direct voice calendar insertion', async () => {
    await runInDurableObject(env.DEVICE_AGENTS.getByName(crypto.randomUUID()), async (_, state) => {
      const store = fresh(state);
      const p = await store.propose({ tripId: 'direct', requestId: crypto.randomUUID(), kind: 'calendar_insert', text: '내일 오후 두 시 회의 추가해' }, 0, 'a'.repeat(64), Date.now() + 8_500);
      await execute(store, p);
      expect(store.status(p.actionId).status).toBe('succeeded');
      expect(handledRows(state)).toEqual([]);
      expect((await scan(store))?.messageId).toBe('private-newest-message');
    });
  });
  it('clears suppression on disconnect/account change and never reapplies an old epoch', async () => {
    await runInDurableObject(env.DEVICE_AGENTS.getByName(crypto.randomUUID()), async (_, state) => {
      let epoch = 0;
      const store = fresh(state, () => epoch), p = await proposal(store, 'calendar_insert');
      await execute(store, p);
      expect((await scan(fresh(state)))?.messageId).toBe('private-older-message');
      store.clear(); epoch++;
      expect(handledRows(state)).toEqual([]);
      expect((await scan(fresh(state, () => epoch), crypto.randomUUID(), epoch))?.messageId).toBe('private-newest-message');
    });
  });
  it('does not recreate a handled row if disconnect wins while success is being hashed', async () => {
    await runInDurableObject(env.DEVICE_AGENTS.getByName(crypto.randomUUID()), async (_, state) => {
      let epoch = 0;
      const store = fresh(state, () => epoch), p = await proposal(store, 'calendar_insert');
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const sign = crypto.subtle.sign.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (algorithm, key, data) => {
        entered(); await gate;
        return sign(algorithm, key, data);
      });
      const pending = execute(store, p);
      await started;
      store.clear(); epoch++;
      release(); await pending;
      expect(store.status(p.actionId).status).toBe('unknown');
      expect(handledRows(state)).toEqual([]);
      expect((await scan(fresh(state, () => epoch), crypto.randomUUID(), epoch))?.messageId).toBe('private-newest-message');
    });
  });
  it('uses different device-derived digests for the same Gmail message', async () => {
    const digests: string[] = [];
    for (let device = 0; device < 2; device++) {
      await runInDurableObject(env.DEVICE_AGENTS.getByName(crypto.randomUUID()), async (_, state) => {
        const store = fresh(state), p = await proposal(store, 'calendar_insert');
        await execute(store, p);
        digests.push(handledRows(state)[0].message_hash);
      });
    }
    expect(digests[0]).not.toBe(digests[1]);
  });
});
