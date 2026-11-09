import { DurableObject } from 'cloudflare:workers';
import { createDeadline, exchangeCode, GoogleError, googleConfig, googleCapabilities, googleJson, refreshTokens, revokeToken, type TokenPayload } from './google';
import { decryptTokens, encryptTokens, validateEncryptionKey } from './token-crypto';
import { fetchToday, dayBounds } from './calendar';
import { createBriefingCacheEntry, getCompatibleBriefing, type BriefingAudio, type BriefingCacheEntry, type BriefingCacheKey } from './briefing-cache';
import { withDeadline } from './deadline';
import { ActionRequestTiming, type CalendarTiming } from './timing';
import { DeviceActions, ActionError, type ActionInput, type ApprovalInput, type ActionRpcResult } from './actions';

type TodayResult = { status: 200; data: Awaited<ReturnType<typeof fetchToday>> } | { status: 403 | 500 | 502 };

export interface Env {
  AI: Ai;
  DEVICE_AGENTS: DurableObjectNamespace<DeviceAgent>;
  PAIRING: DurableObjectNamespace<Pairing>;
  DEVICE_DAILY_CAP: string;
  GLOBAL_DAILY_CAP: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  PUBLIC_ORIGIN?: string;
}

// One row per object: old days are replaced rather than accumulating records.
function createCounter(sql: SqlStorage): void {
  sql.exec('CREATE TABLE IF NOT EXISTS daily (id INTEGER PRIMARY KEY CHECK (id = 1), day TEXT NOT NULL, used INTEGER NOT NULL)');
}

function consume(sql: SqlStorage, day: string, cap: number, amount = 1): boolean {
  if (cap === 0) return false;
  // A single SQLite statement makes admission atomic even for concurrent RPCs.
  return sql.exec(
    `INSERT INTO daily (id, day, used) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET day = excluded.day,
       used = CASE WHEN daily.day = excluded.day THEN daily.used + excluded.used ELSE excluded.used END
     WHERE daily.day < excluded.day OR (daily.day = excluded.day AND daily.used <= ?) RETURNING used`,
    day, amount, cap - amount,
  ).toArray().length === 1;
}

export class DeviceAgent extends DurableObject<Env> {
  private refreshInFlight?: { epoch: number; promise: Promise<TokenPayload> };
  private todayCache?: { epoch: number; expiresAt: number; data: Awaited<ReturnType<typeof fetchToday>> };
  private todayInFlight?: { epoch: number; now: number; promise: Promise<TodayResult>; timing: CalendarTiming };
  private briefingCache?: BriefingCacheEntry;
  private actions: DeviceActions;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS device (id INTEGER PRIMARY KEY CHECK (id = 1), token_hash TEXT NOT NULL, paired INTEGER NOT NULL DEFAULT 0)');
    createCounter(ctx.storage.sql);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS connection_state (id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL DEFAULT 0, attempt_id TEXT)');
    ctx.storage.sql.exec('INSERT OR IGNORE INTO connection_state (id) VALUES (1)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS google_connection (id INTEGER PRIMARY KEY CHECK (id = 1), device_id TEXT NOT NULL, envelope TEXT NOT NULL)');
    this.actions = new DeviceActions(ctx, env, {
      epoch: () => this.getConnectionState().epoch,
      connection: signal => this.actionConnection(signal),
      timeZone: async (token, signal) => {
        if (this.todayCache && this.todayCache.epoch === this.getConnectionState().epoch && this.todayCache.expiresAt > Date.now()) return this.todayCache.data.timeZone;
        const raw = await googleJson(new URL('https://www.googleapis.com/calendar/v3/calendars/primary'), token, signal) as { timeZone?: unknown };
        if (typeof raw.timeZone !== 'string' || raw.timeZone.length > 100) throw new ActionError(502);
        try { new Intl.DateTimeFormat('en', { timeZone: raw.timeZone }); } catch { throw new ActionError(502); }
        return raw.timeZone;
      },
      invalidateCalendar: () => { this.todayCache = undefined; this.todayInFlight = undefined; this.briefingCache = undefined; },
    });
  }

  private async actionConnection(signal: AbortSignal): Promise<{ epoch: number; tokens: TokenPayload }> {
    const epoch = this.getConnectionState().epoch;
    const row = this.ctx.storage.sql.exec<{ device_id: string; envelope: string }>('SELECT device_id,envelope FROM google_connection WHERE id=1').toArray()[0];
    if (!row) throw new ActionError(403);
    try {
      let tokens = await decryptTokens(this.env.TOKEN_ENCRYPTION_KEY!, row.device_id, JSON.parse(row.envelope));
      if (!this.current(epoch) || signal.aborted) throw new ActionError(403);
      if (tokens.expiresAt <= Date.now() + 60_000) tokens = await this.refresh(epoch, row.device_id, tokens, signal);
      if (!this.current(epoch) || signal.aborted) throw new ActionError(403);
      return { epoch, tokens };
    } catch (cause) {
      if (cause instanceof GoogleError && cause.kind === 'auth') this.clearConnection(epoch);
      throw cause;
    }
  }

  async actionCapabilities() {
    const row = this.ctx.storage.sql.exec<{ device_id: string; envelope: string }>('SELECT device_id,envelope FROM google_connection WHERE id=1').toArray()[0];
    if (!row) return googleCapabilities([]);
    const epoch = this.getConnectionState().epoch;
    const tokens = await decryptTokens(this.env.TOKEN_ENCRYPTION_KEY!, row.device_id, JSON.parse(row.envelope));
    return googleCapabilities(this.current(epoch) ? tokens.scopes : []);
  }
  // Return bounded error data across RPC: provider errors/private exceptions never
  // escape into workerd's uncaught RPC exception logs.
  private async actionRpc<T>(operation: () => T | Promise<T>): Promise<ActionRpcResult<T>> {
    try { return await operation(); }
    catch (cause) { return { actionError: cause instanceof ActionError ? cause.status : 502 }; }
  }
  async actionScan(tripId: string, epoch: number, deadlineAt: number) { return this.actionRpc(() => this.actions.scan(tripId, epoch, deadlineAt)); }
  async actionScanMeasured(tripId: string, epoch: number, deadlineAt: number) {
    const timing = new ActionRequestTiming('/v1/mail/scan');
    const result = await this.actionRpc(() => timing.measure('google_scan', () => this.actions.scan(tripId, epoch, deadlineAt, timing)));
    return { result, timing: timing.snapshot() };
  }
  async actionExisting(requestId: string, fingerprint: string) { return this.actionRpc(() => this.actions.existing(requestId, fingerprint)); }
  async actionReadback(id: string, epoch: number) { return this.actionRpc(() => this.actions.readback(id, epoch)); }
  async actionPropose(input: ActionInput, epoch: number, fingerprint: string, deadlineAt: number) { return this.actionRpc(() => this.actions.propose(input, epoch, fingerprint, deadlineAt)); }
  async actionClarify(id: string, version: number, text: string, epoch: number) { return this.actionRpc(() => this.actions.clarify(id, version, text, epoch)); }
  async actionApprove(id: string, input: ApprovalInput, epoch: number, holdAudioMs = 1000) {
    return this.actionRpc(async () => {
      const result = this.actions.approve(id, input, epoch, holdAudioMs);
      await this.actions.arm();
      return result;
    });
  }
  async actionCancel(id: string) { return this.actionRpc(() => this.actions.cancel(id)); }
  async actionNotApproved(id: string, epoch: number, version?: number, contentHash?: string) { return this.actionRpc(() => this.actions.notApproved(id, epoch, version, contentHash)); }
  async actionStatus(id: string) { return this.actionRpc(() => this.actions.status(id)); }
  async alarm() { await this.actions.alarm(); }

  register(tokenHash: string): void {
    this.briefingCache = undefined;
    this.ctx.storage.sql.exec('INSERT INTO device (id, token_hash) VALUES (1, ?)', tokenHash);
  }

  authenticate(tokenHash: string): { paired: boolean; epoch: number } | null {
    const rows = this.ctx.storage.sql.exec<{ token_hash: string; paired: number; epoch: number }>(
      'SELECT device.token_hash, device.paired, connection_state.epoch FROM device JOIN connection_state ON connection_state.id = device.id WHERE device.id = 1',
    ).toArray();
    if (!rows[0] || rows[0].token_hash !== tokenHash) return null;
    return { paired: rows[0].paired === 1, epoch: rows[0].epoch };
  }

  consumeDaily(day: string, cap: number): boolean {
    return consume(this.ctx.storage.sql, day, cap);
  }

  getConnectionState(): { epoch: number; attemptId: string | null } {
    const row = this.ctx.storage.sql.exec<{ epoch: number; attempt_id: string | null }>(
      'SELECT epoch, attempt_id FROM connection_state WHERE id = 1',
    ).one();
    return { epoch: row.epoch, attemptId: row.attempt_id };
  }

  private current(epoch: number): boolean {
    return this.getConnectionState().epoch === epoch;
  }

  private clearConnection(expectedEpoch?: number): boolean {
    return this.ctx.storage.transactionSync(() => {
      if (expectedEpoch !== undefined && !this.current(expectedEpoch)) return false;
      this.todayCache = undefined;
      this.todayInFlight = undefined;
      this.briefingCache = undefined;
      this.actions.clear();
      this.ctx.storage.sql.exec('DELETE FROM google_connection');
      this.ctx.storage.sql.exec('UPDATE connection_state SET epoch = epoch + 1, attempt_id = NULL WHERE id = 1');
      this.ctx.storage.sql.exec('UPDATE device SET paired = 0 WHERE id = 1');
      return true;
    });
  }

  async connectGoogle(deviceId: string, authorizationCode: string, expectedEpoch: number, attemptId: string, expiresAt: number): Promise<'connected' | 'gone' | 'upstream' | 'config'> {
    const deadline = createDeadline();
    let tokens: TokenPayload | undefined;
    try {
      googleConfig(this.env);
      try { validateEncryptionKey(this.env.TOKEN_ENCRYPTION_KEY ?? ''); }
      catch { throw new GoogleError('config'); }
      if (!this.current(expectedEpoch) || Date.now() >= expiresAt) return 'gone';
      tokens = await exchangeCode(this.env, authorizationCode, deadline.signal);
      const envelope = await encryptTokens(this.env.TOKEN_ENCRYPTION_KEY!, deviceId, tokens);
      const committed = this.ctx.storage.transactionSync(() => {
        if (!this.current(expectedEpoch) || Date.now() >= expiresAt || deadline.signal.aborted) return false;
        this.ctx.storage.sql.exec('INSERT INTO google_connection (id, device_id, envelope) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET device_id = excluded.device_id, envelope = excluded.envelope', deviceId, JSON.stringify(envelope));
        this.ctx.storage.sql.exec('UPDATE connection_state SET epoch = epoch + 1, attempt_id = ? WHERE id = 1', attemptId);
        this.ctx.storage.sql.exec('UPDATE device SET paired = 1 WHERE id = 1');
        this.todayCache = undefined;
        this.todayInFlight = undefined;
        this.briefingCache = undefined;
        this.actions.clear();
        return true;
      });
      if (committed) return 'connected';
      try { await revokeToken(this.env, tokens, deadline.signal); } catch { /* Local state remains authoritative. */ }
      return 'gone';
    } catch (cause) {
      return cause instanceof GoogleError && cause.kind === 'config' ? 'config' : 'upstream';
    } finally { deadline.dispose(); }
  }

  private refresh(epoch: number, deviceId: string, tokens: TokenPayload, signal: AbortSignal): Promise<TokenPayload> {
    if (this.refreshInFlight?.epoch === epoch) return this.refreshInFlight.promise;
    const promise = (async () => {
      const row = this.ctx.storage.sql.exec<{ envelope: string }>('SELECT envelope FROM google_connection WHERE id = 1').toArray()[0];
      if (!row || !this.current(epoch)) throw new GoogleError('auth');
      const latest = await decryptTokens(this.env.TOKEN_ENCRYPTION_KEY!, deviceId, JSON.parse(row.envelope));
      if (!this.current(epoch)) throw new GoogleError('auth');
      if (signal.aborted) throw new GoogleError('upstream');
      // Another request may have refreshed while this caller decrypted its snapshot.
      if ((latest.accessToken !== tokens.accessToken || latest.expiresAt !== tokens.expiresAt) && latest.expiresAt > Date.now() + 60_000) return latest;
      const updated = await refreshTokens(this.env, tokens, signal);
      const envelope = await encryptTokens(this.env.TOKEN_ENCRYPTION_KEY!, deviceId, updated);
      if (!this.current(epoch)) throw new GoogleError('auth');
      if (signal.aborted) throw new GoogleError('upstream');
      this.ctx.storage.sql.exec('UPDATE google_connection SET envelope = ? WHERE id = 1', JSON.stringify(envelope));
      return updated;
    })();
    this.refreshInFlight = { epoch, promise };
    void promise.finally(() => {
      if (this.refreshInFlight?.promise === promise) this.refreshInFlight = undefined;
    }).catch(() => {});
    return promise;
  }

  async todayWithTiming(now: number, deadlineAt?: number): Promise<{ result: TodayResult; timing: CalendarTiming }> {
    const timing: CalendarTiming = { cache: 'miss', tokenRefresh: false };
    const result = await this.readToday(now, deadlineAt, timing);
    return { result, timing };
  }

  async today(now: number, deadlineAt?: number): Promise<TodayResult> {
    return this.readToday(now, deadlineAt, { cache: 'miss', tokenRefresh: false });
  }

  getBriefingCache(input: { key: BriefingCacheKey; now: number }): BriefingCacheEntry | null {
    return this.ctx.storage.transactionSync(() => {
      if (!this.current(input.key.epoch)) return null;
      if (this.briefingCache && input.now >= this.briefingCache.expiresAt) this.briefingCache = undefined;
      return getCompatibleBriefing(this.briefingCache, input.key, input.now);
    });
  }

  publishBriefingCache(input: { key: BriefingCacheKey; audio: BriefingAudio; now: number; nextStartAt?: number }): boolean {
    return this.ctx.storage.transactionSync(() => {
      if (!this.current(input.key.epoch)) return false;
      const entry = createBriefingCacheEntry(input);
      if (!entry) return false;
      this.briefingCache = entry;
      return true;
    });
  }

  private async readToday(now: number, deadlineAt: number | undefined, timing: CalendarTiming): Promise<TodayResult> {
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) return { status: 502 };
    const epoch = this.getConnectionState().epoch;
    const cache = this.todayCache;
    if (cache?.epoch === epoch && now < cache.expiresAt
      && cache.data.date === dayBounds(new Date(now), cache.data.timeZone).date) { timing.cache = 'hit'; return { status: 200, data: cache.data }; }
    const pending = this.todayInFlight;
    if (pending?.epoch === epoch && now >= pending.now && now < pending.now + 30_000) {
      let result: TodayResult;
      try { result = deadlineAt === undefined ? await pending.promise : await withDeadline(deadlineAt, () => pending.promise); }
      catch { return { status: 502 }; }
      timing.tokenRefresh = pending.timing.tokenRefresh;
      if (!this.current(epoch)) return { status: 403 };
      if (result.status !== 200 || result.data.date === dayBounds(new Date(now), result.data.timeZone).date) return result;
      // A request crossing calendar-local midnight must fetch its own day.
    }
    const promise = this.fetchCalendar(now, deadlineAt, timing).then(result => {
      if (result.status === 200 && this.current(epoch)) this.todayCache = { epoch, expiresAt: now + 30_000, data: result.data };
      return result;
    });
    this.todayInFlight = { epoch, now, promise, timing };
    try { return await promise; }
    finally { if (this.todayInFlight?.promise === promise) this.todayInFlight = undefined; }
  }

  private async fetchCalendar(now: number, deadlineAt: number | undefined, timing: CalendarTiming): Promise<TodayResult> {
    const epoch = this.getConnectionState().epoch;
    const row = this.ctx.storage.sql.exec<{ device_id: string; envelope: string }>('SELECT device_id, envelope FROM google_connection WHERE id = 1').toArray()[0];
    if (!row) return { status: 403 };
    const deadline = createDeadline(deadlineAt === undefined ? 6_000 : Math.max(0, deadlineAt - Date.now()));
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) { deadline.dispose(); return { status: 502 }; }
    try {
      let tokens = await decryptTokens(this.env.TOKEN_ENCRYPTION_KEY ?? '', row.device_id, JSON.parse(row.envelope));
      if (!this.current(epoch)) return { status: 403 };
      if (tokens.expiresAt <= now + 60_000) { timing.tokenRefresh = true; tokens = await this.refresh(epoch, row.device_id, tokens, deadline.signal); }
      if (!this.current(epoch)) return { status: 403 };
      let data: Awaited<ReturnType<typeof fetchToday>>;
      try { data = await fetchToday(tokens.accessToken, new Date(now), deadline.signal); }
      catch (cause) {
        if (!(cause instanceof GoogleError) || cause.kind !== 'auth') throw cause;
        timing.tokenRefresh = true;
        tokens = await this.refresh(epoch, row.device_id, tokens, deadline.signal);
        if (!this.current(epoch)) return { status: 403 };
        data = await fetchToday(tokens.accessToken, new Date(now), deadline.signal);
      }
      if (!this.current(epoch)) return { status: 403 };
      if (deadline.signal.aborted) return { status: 502 };
      return { status: 200, data };
    } catch (cause) {
      if (!this.current(epoch)) return { status: 403 };
      if (cause instanceof GoogleError && cause.kind === 'auth') {
        this.clearConnection(epoch);
        return { status: 403 };
      }
      return { status: cause instanceof GoogleError && cause.kind === 'upstream' ? 502 : 500 };
    } finally { deadline.dispose(); }
  }

  async disconnectGoogle(): Promise<'revoked' | 'failed' | 'not_needed'> {
    const row = this.ctx.storage.sql.exec<{ device_id: string; envelope: string }>('SELECT device_id, envelope FROM google_connection WHERE id = 1').toArray()[0];
    this.clearConnection();
    if (!row) return 'not_needed';
    const deadline = createDeadline();
    try {
      const tokens = await decryptTokens(this.env.TOKEN_ENCRYPTION_KEY ?? '', row.device_id, JSON.parse(row.envelope));
      await revokeToken(this.env, tokens, deadline.signal);
      return 'revoked';
    } catch { return 'failed'; }
    finally { deadline.dispose(); }
  }
}

export type PairingRecord = {
  device_id: string;
  expected_epoch: number;
  issued_at: number;
  expires_at: number;
  status: 'pending' | 'processing' | 'paired' | 'failed';
  state_hash: string | null;
  cookie_hash: string | null;
};

// Admission counters retain their original names; codes use pairing:<random>.
export class Pairing extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    createCounter(ctx.storage.sql);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS pairing_code (id INTEGER PRIMARY KEY CHECK (id = 1), device_id TEXT NOT NULL, expected_epoch INTEGER NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL, state_hash TEXT, cookie_hash TEXT)");
  }

  // These tables live only in the fixed 'admission' object. No untrusted key
  // selects a new object, and rejected requests never allocate rows.
  private admissionSql(): SqlStorage {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS admitted_devices (device_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS admission_daily (key TEXT PRIMARY KEY, day TEXT NOT NULL, used INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS issued_pairs (code_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
    return sql;
  }

  private take(key: string, day: string, cap: number): boolean {
    return this.admissionSql().exec(
      `INSERT INTO admission_daily (key, day, used) VALUES (?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET day = excluded.day,
         used = CASE WHEN admission_daily.day = excluded.day THEN admission_daily.used + 1 ELSE 1 END
       WHERE admission_daily.day < excluded.day OR (admission_daily.day = excluded.day AND admission_daily.used < ?) RETURNING used`,
      key, day, cap,
    ).toArray().length === 1;
  }

  admitRegistration(ipHash: string, day: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.admissionSql();
      // Prune obsolete IP buckets; retain device quotas for delayed requests.
      sql.exec("DELETE FROM admission_daily WHERE day < ? AND key LIKE 'registration:ip:%'", day);
      const global = sql.exec<{ day: string; used: number }>("SELECT day, used FROM admission_daily WHERE key = 'registration:global'").toArray()[0];
      if (global && (global.day > day || global.day === day && global.used >= 100)) return false;
      if (!this.take(`registration:ip:${ipHash}`, day, 5)) return false;
      return this.take('registration:global', day, 100);
    });
  }

  admitDevice(deviceId: string, tokenHash: string): void {
    this.admissionSql().exec('INSERT INTO admitted_devices (device_id, token_hash) VALUES (?, ?)', deviceId, tokenHash);
  }

  knowsDevice(deviceId: string, tokenHash: string): boolean {
    return this.admissionSql().exec('SELECT device_id FROM admitted_devices WHERE device_id = ? AND token_hash = ?', deviceId, tokenHash).toArray().length === 1;
  }

  admitPairing(deviceId: string, day: string): boolean {
    return this.take(`pairing:${deviceId}`, day, 5);
  }

  async rememberPairing(codeHash: string, expiresAt: number): Promise<void> {
    const sql = this.admissionSql();
    // Only an expiry marker survives for a day so expired links retain 410;
    // OAuth state, cookie digests and device records are deleted at expiry.
    sql.exec('DELETE FROM issued_pairs WHERE expires_at <= ?', Date.now() - 86_400_000);
    sql.exec('INSERT INTO issued_pairs (code_hash, expires_at) VALUES (?, ?)', codeHash, expiresAt);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > expiresAt + 86_400_000) await this.ctx.storage.setAlarm(expiresAt + 86_400_000);
  }

  pairingExpiry(codeHash: string): number | null {
    return this.admissionSql().exec<{ expires_at: number }>('SELECT expires_at FROM issued_pairs WHERE code_hash = ?', codeHash).toArray()[0]?.expires_at ?? null;
  }

  admitCalendar(deviceId: string, day: string): 'DEVICE_DAILY_LIMIT' | 'GLOBAL_DAILY_LIMIT' | null {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.admissionSql();
      const global = sql.exec<{ day: string; used: number }>("SELECT day, used FROM admission_daily WHERE key = 'calendar:global'").toArray()[0];
      if (global && (global.day > day || global.day === day && global.used >= 1000)) return 'GLOBAL_DAILY_LIMIT';
      if (!this.take(`calendar:${deviceId}`, day, 120)) return 'DEVICE_DAILY_LIMIT';
      this.take('calendar:global', day, 1000);
      return null;
    });
  }

  consumeDaily(day: string, cap: number): boolean {
    return consume(this.ctx.storage.sql, day, cap);
  }

  reserveNeurons(day: string, neurons: number): boolean {
    if (!Number.isSafeInteger(neurons) || neurons <= 0 || neurons > 10000) return false;
    return consume(this.ctx.storage.sql, day, 10000, neurons);
  }

  async create(deviceId: string, expectedEpoch: number, now: number): Promise<boolean> {
    const created = this.ctx.storage.sql.exec("INSERT OR IGNORE INTO pairing_code (id, device_id, expected_epoch, issued_at, expires_at, status) VALUES (1, ?, ?, ?, ?, 'pending') RETURNING id", deviceId, expectedEpoch, now, now + 300_000).toArray().length === 1;
    if (created) await this.ctx.storage.setAlarm(now + 300_000);
    return created;
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'issued_pairs'").toArray().length) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const sql = this.admissionSql();
    sql.exec('DELETE FROM issued_pairs WHERE expires_at <= ?', Date.now() - 86_400_000);
    const next = sql.exec<{ expires_at: number | null }>('SELECT MIN(expires_at) AS expires_at FROM issued_pairs').one().expires_at;
    if (next !== null) await this.ctx.storage.setAlarm(next + 86_400_000);
  }

  read(): PairingRecord | null {
    return this.ctx.storage.sql.exec<PairingRecord>('SELECT device_id, expected_epoch, issued_at, expires_at, status, state_hash, cookie_hash FROM pairing_code WHERE id = 1').toArray()[0] ?? null;
  }

  setBrowser(stateHash: string, cookieHash: string, now: number): boolean {
    return this.ctx.storage.sql.exec("UPDATE pairing_code SET state_hash = ?, cookie_hash = ? WHERE id = 1 AND status = 'pending' AND expires_at > ? RETURNING id", stateHash, cookieHash, now).toArray().length === 1;
  }

  claim(stateHash: string, cookieHash: string, now: number): 'claimed' | 'invalid' | 'gone' {
    const row = this.read();
    if (!row || row.status !== 'pending' || row.expires_at <= now) return 'gone';
    const claimed = this.ctx.storage.sql.exec("UPDATE pairing_code SET status = 'processing', state_hash = NULL, cookie_hash = NULL WHERE id = 1 AND status = 'pending' AND expires_at > ? AND state_hash = ? AND cookie_hash = ? RETURNING id", now, stateHash, cookieHash).toArray();
    return claimed.length ? 'claimed' : 'invalid';
  }

  finish(status: 'paired' | 'failed'): void {
    this.ctx.storage.sql.exec("UPDATE pairing_code SET status = ?, state_hash = NULL, cookie_hash = NULL WHERE id = 1 AND status = 'processing'", status);
  }
}
