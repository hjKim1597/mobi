import { env, fetchMock, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { encryptTokens } from '../src/token-crypto';

beforeEach(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(() => { fetchMock.deactivate(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function device(scopes: string[] = []) {
  const r = await worker.fetch(new Request('https://mobi.invalid/v1/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), env);
  const d = await r.json() as { deviceId: string; deviceToken: string };
  const stub = env.DEVICE_AGENTS.getByName(d.deviceId);
  const envelope = await encryptTokens(env.TOKEN_ENCRYPTION_KEY!, d.deviceId, {
    accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600000,
    scopes: ['https://www.googleapis.com/auth/calendar.events.readonly', 'https://www.googleapis.com/auth/calendar.calendars.readonly', ...scopes],
  });
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec('UPDATE device SET paired = 1 WHERE id = 1');
    state.storage.sql.exec('INSERT INTO google_connection (id,device_id,envelope) VALUES (1,?,?)', d.deviceId, JSON.stringify(envelope));
  });
  return { ...d, stub };
}

describe('actions HTTP and legacy calendar capability', () => {
  it('keeps calendar-only connections valid and reports action reconnection rather than clearing them', async () => {
    const d = await device();
    const r = await worker.fetch(new Request('https://mobi.invalid/v1/capabilities', { headers: { Authorization: `Bearer ${d.deviceToken}` } }), env);
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(await r.json()).toEqual({ calendarRead: true, mailRead: false, mailReply: false, calendarInsert: false, reconnectRequired: true });
    expect((await d.stub.getConnectionState()).epoch).toBe(0);
  });
  it('requires device authentication for actions before decoding private request data', async () => {
    const r = await worker.fetch(new Request('https://mobi.invalid/v1/actions/proposals', { method: 'POST', body: 'invalid' }), env);
    expect(r.status).toBe(401);
  });
});
