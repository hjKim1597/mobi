export type ActionKind = 'mail_reply' | 'calendar_insert';
export class ActionError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 410 | 429 | 502) { super(`ACTION_HTTP_${status}`); this.name = 'ActionError'; }
}
export type ActionRpcResult<T> = T | { actionError: number };
export function unwrapAction<T>(result: T): Exclude<T, { actionError: number }> {
  if (result && typeof result === 'object' && 'actionError' in result) throw new ActionError(result.actionError as ActionError['status']);
  return result as Exclude<T, { actionError: number }>;
}
export function isActionApproval(kind: ActionKind, transcript: string): boolean {
  const text = transcript.normalize('NFKC').trim().replace(/\s+/gu, ' ').replace(/[.!?。！？]+$/u, '').trim();
  return (kind === 'mail_reply' ? ['보내', '보내줘', '보내 줘'] : ['추가해', '추가해줘', '추가해 줘', '등록해', '등록해줘', '등록해 줘']).includes(text);
}
export function calendarAddRequest(text: string): boolean {
  return !/하지\s*마|하지\s*않|말아|취소|아니|하지말/u.test(text)
    && /일정|회의|약속/u.test(text) && /추가|등록|잡아/u.test(text);
}
import { createDeadline, googleCapabilities, type TokenPayload } from './google';
import { encryptPrivateValue, decryptPrivateValue, validateEncryptionKey } from './token-crypto';
import { fetchMailCandidate, fetchMailMessage, createReplyDraft, verifyReplyDraft, sendReplyDraft, deleteReplyDraft, reconcileReply, type MailCandidate, type ReplyPayload } from './gmail';
import { calendarEventId, calendarReadbackParts, resolveCalendarRequest, insertCalendarEvent, type CalendarPayload } from './calendar-actions';
import type { Env } from './state';
import { isSafeReplyBody, sanitizeTtsText } from './tts';
import type { ActionRequestTiming } from './timing';
import { polishReplyDictation } from './dictation-polish';


export interface ActionInput { tripId: string; requestId: string; kind: ActionKind; candidateId?: string; text?: string }
export interface ApprovalInput { contentHash: string; version?: number; channel?: 'voice' | 'parked_button' }
type Status = 'awaiting_approval' | 'needs_clarification' | 'holding' | 'preparing' | 'sending' | 'succeeded' | 'failed' | 'unknown' | 'cancelled' | 'expired' | 'rejected';
type ActionRow = {
  id: string; request_id: string; fingerprint: string; epoch: number; version: number; kind: ActionKind; status: Status;
  content_hash: string; envelope: string; draft_id: string | null; event_id: string | null; send_attempted: number;
  execute_at: number | null; expires_at: number; cleanup_at: number; outcome: string; clarified: number;
  reconcile_at: number | null; reconcile_attempts: number;
  hold_audio_ms: number;
}
type CandidateRow = { candidate_id: string; epoch: number; expires_at: number; envelope: string };
interface PrivateAction {
  status: 'awaiting_approval' | 'needs_clarification' | 'rejected'; readback: string; display: Record<string, string>;
  calendarSpeechParts?: Array<{ text: string; fixed: boolean }>;
  reasonCode?: string; reply?: ReplyPayload; calendar?: CalendarPayload; sourceText?: string; timeZone?: string; mailTitle?: string; mailMessageId?: string;
}
export interface StoredProposal {
  actionId: string; version: number; status: PrivateAction['status']; contentHash?: string; speechText: string;
  calendarSpeechParts?: Array<{ text: string; fixed: boolean }>;
  display: Record<string, string>; expiresAt: string; reasonCode?: string;
}
const ACTIVE = "'awaiting_approval','needs_clarification','holding','preparing','sending'";
const TERMINAL = new Set<Status>(['succeeded', 'failed', 'unknown', 'cancelled', 'expired', 'rejected']);
const DAY = 86_400_000;
function calendarTitleFromSubject(subject: string): string {
  const title = subject.trim().replace(/^(?:(?:re|fwd|fw):\s*)+/i, '').trim();
  if (!isSafeReplyBody(title)) return '메일 일정';
  try { sanitizeTtsText(title, 'reply_readback'); return title; }
  catch { return '메일 일정'; }
}
function spokenSender(displayName: string): string {
  let depth = 0, result = '';
  for (const char of displayName.normalize('NFKC')) {
    if ('([{<'.includes(char)) { depth++; result += ' '; }
    else if (')]}>' .includes(char)) { depth = Math.max(0, depth - 1); result += ' '; }
    else if (depth === 0) result += /[\p{Script=Hangul}\p{Script=Latin}0-9 ]/u.test(char) ? char : ' ';
  }
  return result.replace(/ +/g, ' ').trim() || '보낸 분';
}
async function hash(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

/** Durable execution truth. Audio/STT stay in the authenticated HTTP layer. */
export class DeviceActions {
  private offered = new Map<string, { candidate: MailCandidate | null; epoch: number; expiresAt: number }>();
  private executing = new Set<string>();
  private handledKey?: Promise<CryptoKey>;
  constructor(private ctx: DurableObjectState, private env: Env, private hooks: {
    epoch(): number;
    connection(signal: AbortSignal): Promise<{ epoch: number; tokens: TokenPayload }>;
    timeZone(token: string, signal: AbortSignal): Promise<string>;
    invalidateCalendar(): void;
  }) {
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS actions (
      id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, epoch INTEGER NOT NULL,
      version INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, content_hash TEXT NOT NULL,
      envelope TEXT NOT NULL, draft_id TEXT, event_id TEXT, send_attempted INTEGER NOT NULL DEFAULT 0,
      execute_at INTEGER, expires_at INTEGER NOT NULL, cleanup_at INTEGER NOT NULL, outcome TEXT NOT NULL DEFAULT '', clarified INTEGER NOT NULL DEFAULT 0,
      reconcile_at INTEGER, reconcile_attempts INTEGER NOT NULL DEFAULT 0, hold_audio_ms INTEGER NOT NULL DEFAULT 1000)`);
    if (!ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(actions)').toArray().some(column => column.name === 'hold_audio_ms')) {
      ctx.storage.sql.exec('ALTER TABLE actions ADD COLUMN hold_audio_ms INTEGER NOT NULL DEFAULT 1000');
    }
    ctx.storage.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS one_active_action ON actions((1)) WHERE status IN (${ACTIVE})`);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS action_limits (name TEXT PRIMARY KEY, day TEXT NOT NULL, used INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS action_candidates (candidate_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL, envelope TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS handled_mail (message_hash TEXT PRIMARY KEY, epoch INTEGER NOT NULL, handled_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
  }
  private aad(row: Pick<ActionRow, 'id' | 'epoch' | 'version'>) { return new TextEncoder().encode(`mobi:action:${this.ctx.id.toString()}:${row.epoch}:${row.id}:${row.version}`); }
  private async encrypt(row: Pick<ActionRow, 'id' | 'epoch' | 'version'>, value: PrivateAction) { return JSON.stringify(await encryptPrivateValue(this.env.TOKEN_ENCRYPTION_KEY!, this.aad(row), value)); }
  private async payload(row: ActionRow) { return await decryptPrivateValue(this.env.TOKEN_ENCRYPTION_KEY!, this.aad(row), JSON.parse(row.envelope)) as PrivateAction; }
  private async handledHash(messageId: string, epoch: number): Promise<string> {
    const encoder = new TextEncoder();
    this.handledKey ??= (async () => {
      const secret = validateEncryptionKey(this.env.TOKEN_ENCRYPTION_KEY!);
      try {
        const root = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
        return await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('mobi:handled-mail:v1'), info: encoder.encode(this.ctx.id.toString()) }, root, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
      } finally { secret.fill(0); }
    })();
    const digest = await crypto.subtle.sign('HMAC', await this.handledKey, encoder.encode(JSON.stringify([epoch, messageId])));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  private async isHandled(messageId: string, epoch: number): Promise<boolean> {
    const digest = await this.handledHash(messageId, epoch);
    if (this.hooks.epoch() !== epoch) throw new ActionError(403);
    return this.ctx.storage.sql.exec('SELECT message_hash FROM handled_mail WHERE message_hash=? AND epoch=? AND expires_at>?', digest, epoch, Date.now()).toArray().length > 0;
  }
  private candidateAad(row: Omit<CandidateRow, 'envelope'>) {
    return new TextEncoder().encode(`mobi:mail-candidate:${this.ctx.id.toString()}:${row.epoch}:${row.candidate_id}:${row.expires_at}:v1`);
  }
  private async candidate(id: string, epoch: number): Promise<MailCandidate> {
    const row = this.ctx.storage.sql.exec<CandidateRow>('SELECT * FROM action_candidates WHERE candidate_id=?', id).toArray()[0];
    if (!row || row.epoch !== epoch || row.expires_at <= Date.now()) throw new ActionError(410);
    let value: MailCandidate;
    try { value = await decryptPrivateValue(this.env.TOKEN_ENCRYPTION_KEY!, this.candidateAad(row), JSON.parse(row.envelope)) as MailCandidate; }
    catch { throw new ActionError(410); }
    if (this.hooks.epoch() !== epoch) throw new ActionError(403);
    if (!value || value.candidateId !== id || row.expires_at <= Date.now()) throw new ActionError(410);
    return value;
  }
  private row(id: string): ActionRow {
    this.expire();
    const row = this.ctx.storage.sql.exec<ActionRow>('SELECT * FROM actions WHERE id=?', id).toArray()[0];
    if (!row) throw new ActionError(404);
    return row;
  }
  private expire() {
    const now = Date.now();
    this.ctx.storage.sql.exec("UPDATE actions SET status='expired', outcome='approval_expired', cleanup_at=? WHERE status IN ('awaiting_approval','needs_clarification') AND expires_at<=?", now + DAY, now);
    this.ctx.storage.sql.exec('DELETE FROM actions WHERE cleanup_at<=?', now);
    this.ctx.storage.sql.exec('DELETE FROM action_candidates WHERE expires_at<=? OR epoch!=?', now, this.hooks.epoch());
    this.ctx.storage.sql.exec('DELETE FROM handled_mail WHERE expires_at<=? OR epoch!=?', now, this.hooks.epoch());
    for (const [id, c] of this.offered) if (c.expiresAt <= now || c.epoch !== this.hooks.epoch()) this.offered.delete(id);
  }
  private async schedule() {
    const row = this.ctx.storage.sql.exec<{ next: number | null }>(`SELECT MIN(t) AS next FROM (
      SELECT execute_at AS t FROM actions WHERE status='holding' UNION ALL
      SELECT reconcile_at AS t FROM actions WHERE status='unknown' AND kind='mail_reply' AND send_attempted=1 AND envelope!='' AND reconcile_at IS NOT NULL AND reconcile_attempts<6 UNION ALL
      SELECT expires_at AS t FROM actions WHERE status IN ('awaiting_approval','needs_clarification') UNION ALL SELECT cleanup_at AS t FROM actions UNION ALL
      SELECT expires_at AS t FROM action_candidates)`).one();
    // DO SQLite permits only five terms in a compound SELECT.
    const handled = this.ctx.storage.sql.exec<{ next: number | null }>('SELECT MIN(expires_at) AS next FROM handled_mail').one();
    const next = Math.min(row.next ?? Infinity, handled.next ?? Infinity);
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
  }
  private finish(id: string, status: Status, outcome: string) {
    this.ctx.storage.sql.exec('UPDATE actions SET status=?,outcome=?,cleanup_at=?,reconcile_at=? WHERE id=?', status, outcome, Date.now() + DAY, status === 'unknown' ? Date.now() + 2000 : null, id);
  }
  private async succeed(row: ActionRow, payload: PrivateAction, outcome: string): Promise<boolean> {
    const messageId = payload.reply?.candidate.messageId ?? payload.mailMessageId;
    const digest = messageId ? await this.handledHash(messageId, row.epoch) : undefined;
    if (this.hooks.epoch() !== row.epoch) return false;
    const completed = this.ctx.storage.transactionSync(() => {
      if (this.hooks.epoch() !== row.epoch || !['sending', 'unknown'].includes(this.row(row.id).status)) return false;
      const now = Date.now();
      this.finish(row.id, 'succeeded', outcome);
      if (digest) this.ctx.storage.sql.exec('INSERT INTO handled_mail(message_hash,epoch,handled_at,expires_at) VALUES(?,?,?,?) ON CONFLICT(message_hash) DO UPDATE SET handled_at=excluded.handled_at,expires_at=excluded.expires_at', digest, row.epoch, now, now + 7 * DAY);
      return true;
    });
    if (completed && digest) this.offered.clear();
    return completed;
  }
  clear() {
    this.ctx.storage.sql.exec('DELETE FROM action_candidates');
    this.ctx.storage.sql.exec('DELETE FROM handled_mail');
    this.offered.clear();
    this.ctx.storage.sql.exec(`UPDATE actions SET status='cancelled', outcome='connection_changed', envelope='',draft_id=NULL,cleanup_at=? WHERE status IN (${ACTIVE}) AND status!='sending'`, Date.now() + DAY);
    this.ctx.storage.sql.exec("UPDATE actions SET status='unknown', outcome='connection_changed',envelope='',draft_id=NULL,cleanup_at=? WHERE status='sending'", Date.now() + DAY);
    this.ctx.storage.sql.exec("UPDATE actions SET envelope='',draft_id=NULL");
  }
  private limit(name: string, maximum: number) {
    const day = new Date().toISOString().slice(0, 10);
    if (!this.ctx.storage.sql.exec(`INSERT INTO action_limits(name,day,used) VALUES(?,?,1) ON CONFLICT(name) DO UPDATE SET day=excluded.day,used=CASE WHEN action_limits.day=excluded.day THEN used+1 ELSE 1 END WHERE action_limits.day!=excluded.day OR used<? RETURNING used`, name, day, maximum).toArray().length) throw new ActionError(429);
  }
  async scan(tripId: string, epoch: number, deadlineAt: number, timing?: ActionRequestTiming): Promise<MailCandidate | null> {
    this.expire();
    const cached = this.offered.get(tripId);
    if (cached && (!cached.candidate || !await this.isHandled(cached.candidate.messageId, epoch))) return cached.candidate;
    this.limit('mail_scan', 30);
    const deadline = createDeadline(Math.max(1, deadlineAt - Date.now()));
    const controller = new AbortController();
    const abort = () => controller.abort(deadline.signal.reason);
    deadline.signal.addEventListener('abort', abort, { once: true });
    const signal = controller.signal;
    try {
      const connection = await this.hooks.connection(signal);
      if (connection.epoch !== epoch || !googleCapabilities(connection.tokens.scopes).mailRead) throw new ActionError(403);
      let candidate = await fetchMailCandidate(connection.tokens.accessToken, Date.now(), signal, timing, id => this.isHandled(id, epoch));
      if (candidate && !candidate.sensitive) {
        const messageId = candidate.messageId;
        const validate = () => fetchMailMessage(connection.tokens.accessToken, messageId, signal);
        candidate = await (timing ? timing.measure('google_validation', validate) : validate());
      }
      if (this.hooks.epoch() !== epoch || signal.aborted) throw new ActionError(403);
      if (candidate) {
        candidate = { ...candidate, candidateId: crypto.randomUUID() };
        const row = { candidate_id: candidate.candidateId, epoch, expires_at: Date.now() + 90_000 };
        const envelope = JSON.stringify(await encryptPrivateValue(this.env.TOKEN_ENCRYPTION_KEY!, this.candidateAad(row), candidate));
        if (this.hooks.epoch() !== epoch || signal.aborted) throw new ActionError(403);
        this.ctx.storage.sql.exec('INSERT INTO action_candidates(candidate_id,epoch,expires_at,envelope) VALUES(?,?,?,?)', row.candidate_id, row.epoch, row.expires_at, envelope);
        await this.schedule();
      }
      if (this.hooks.epoch() !== epoch || signal.aborted) throw new ActionError(403);
      this.offered.set(tripId, { candidate, epoch, expiresAt: Date.now() + 60_000 });
      return candidate;
    } finally {
      controller.abort();
      deadline.signal.removeEventListener('abort', abort);
      deadline.dispose();
    }
  }
  async existing(requestId: string, fingerprint: string): Promise<StoredProposal | null> {
    this.expire();
    const r = this.ctx.storage.sql.exec<ActionRow>('SELECT * FROM actions WHERE request_id=?', requestId).toArray()[0];
    if (!r) return null;
    if (r.fingerprint !== fingerprint || r.epoch !== this.hooks.epoch()) throw new ActionError(409);
    if (r.expires_at <= Date.now() || !r.envelope) throw new ActionError(410);
    return this.view(r, await this.payload(r));
  }
  private view(r: ActionRow, p: PrivateAction): StoredProposal {
    return { actionId: r.id, version: r.version, status: p.status, ...(p.status === 'awaiting_approval' ? { contentHash: r.content_hash } : {}), speechText: p.readback, ...(p.calendarSpeechParts ? { calendarSpeechParts: p.calendarSpeechParts } : {}), display: p.display, expiresAt: new Date(r.expires_at).toISOString(), ...(p.reasonCode ? { reasonCode: p.reasonCode } : {}) };
  }
  async readback(id: string, epoch: number): Promise<StoredProposal> {
    const readable = (r: ActionRow) => {
      if (r.epoch !== epoch || this.hooks.epoch() !== epoch) throw new ActionError(403);
      if (!r.envelope || r.expires_at <= Date.now() || r.status === 'expired') throw new ActionError(410);
      if (!['awaiting_approval', 'needs_clarification', 'rejected'].includes(r.status)) throw new ActionError(409);
    };
    const r = this.row(id);
    readable(r);
    const p = await this.payload(r);
    const current = this.row(id);
    readable(current);
    if (current.version !== r.version || current.status !== r.status || current.envelope !== r.envelope) throw new ActionError(409);
    return this.view(current, p);
  }
  async propose(input: ActionInput, epoch: number, fingerprint: string, deadlineAt: number): Promise<StoredProposal> {
    const previous = await this.existing(input.requestId, fingerprint); if (previous) return previous;
    if (this.ctx.storage.sql.exec(`SELECT id FROM actions WHERE status IN ('holding','preparing','sending','unknown')`).toArray().length) throw new ActionError(409);
    const deadline = createDeadline(Math.max(1, deadlineAt - Date.now()));
    try {
      const c = await this.hooks.connection(deadline.signal);
      if (c.epoch !== epoch || this.hooks.epoch() !== epoch) throw new ActionError(403);
      const caps = googleCapabilities(c.tokens.scopes);
      if (!(input.kind === 'mail_reply' ? caps.mailReply : caps.calendarInsert)) throw new ActionError(403);
      const candidate = input.candidateId ? await this.candidate(input.candidateId, epoch) : undefined;
      if (candidate?.sensitive) throw new ActionError(410);
      const id = crypto.randomUUID(), version = 1;
      let p: PrivateAction;
      if (input.kind === 'mail_reply') {
        if (!candidate?.canReply) throw new ActionError(400);
        const { body, reason, rawLength, finalLength } = polishReplyDictation(input.text ?? '');
        try { console.log(JSON.stringify({ reason, rawLength, finalLength })); } catch { /* Diagnostics cannot affect approval. */ }
        if (reason === 'raw_invalid') p = { status: 'rejected', readback: '한 문장으로 짧게 다시 말씀해 주세요.', reasonCode: 'unreadable_or_long_reply', display: {} };
        else {
          const sender = spokenSender(candidate.sender);
          const reply: ReplyPayload = { kind: 'mail_reply', candidate, body, correlationId: id };
          p = { status: 'awaiting_approval', reply, readback: `${sender} 님에게 '${body}'라고 회신할게요. 보내려면 '보내'라고 말씀해 주세요.`, display: { sender, subject: candidate.subject, body } };
          try { sanitizeTtsText(p.readback, 'reply_readback'); }
          catch { p = { status: 'rejected', readback: '한 문장으로 짧게 다시 말씀해 주세요.', reasonCode: 'unreadable_or_long_reply', display: {} }; }
        }
      } else {
        if (candidate && !candidate.canAddCalendar) throw new ActionError(400);
        const text = candidate ? candidate.body : input.text ?? '';
        const zone = await this.hooks.timeZone(c.tokens.accessToken, deadline.signal);
        p = await this.calendarProposal(text, zone, id, epoch, undefined, candidate ? calendarTitleFromSubject(candidate.subject) : undefined);
        if (candidate) p.mailMessageId = candidate.messageId;
      }
      if (deadline.signal.aborted || this.hooks.epoch() !== epoch) throw new ActionError(403);
      const contentHash = await hash(JSON.stringify({ id, epoch, version, p }));
      const envelope = await this.encrypt({ id, epoch, version }, p);
      const now = Date.now();
      const prior = this.ctx.storage.sql.exec<ActionRow>("SELECT * FROM actions WHERE epoch=? AND kind=? AND status IN ('unknown','succeeded') AND envelope!=''", epoch, input.kind).toArray();
      for (const oldRow of prior) {
        const old = await this.payload(oldRow);
        const sameMail = p.reply && old.reply && p.reply.candidate.messageId === old.reply.candidate.messageId;
        const a = p.calendar, b = old.calendar;
        const sameEvent = a && b && a.title === b.title && a.start === b.start && a.end === b.end && a.timeZone === b.timeZone;
        if (sameMail || sameEvent) throw new ActionError(409);
      }
      // A second request can pass the first lookup while crypto/fetch yields.
      const replay = await this.existing(input.requestId, fingerprint); if (replay) return replay;
      if (this.hooks.epoch() !== epoch || deadline.signal.aborted) throw new ActionError(403);
      try {
        this.ctx.storage.transactionSync(() => {
          if (this.hooks.epoch() !== epoch || deadline.signal.aborted) throw new ActionError(403);
          if (this.ctx.storage.sql.exec("SELECT id FROM actions WHERE status IN ('holding','preparing','sending','unknown')").toArray().length) throw new ActionError(409);
          this.ctx.storage.sql.exec("UPDATE actions SET status='cancelled',outcome='superseded',envelope='',draft_id=NULL,cleanup_at=? WHERE status IN ('awaiting_approval','needs_clarification')", now + DAY);
          this.ctx.storage.sql.exec('INSERT INTO actions(id,request_id,fingerprint,epoch,version,kind,status,content_hash,envelope,event_id,expires_at,cleanup_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', id, input.requestId, fingerprint, epoch, version, input.kind, p.status, contentHash, envelope, p.calendar?.eventId ?? null, now + 90_000, now + DAY);
        });
      } catch (cause) {
        if (cause instanceof Error && /unique/i.test(cause.message)) {
          const winner = await this.existing(input.requestId, fingerprint);
          if (winner) return winner;
          throw new ActionError(409);
        }
        if (cause instanceof Error && /constraint/i.test(cause.message)) throw new ActionError(409);
        throw cause;
      }
      await this.schedule();
      return this.view(this.row(id), p);
    } finally { deadline.dispose(); }
  }
  private async calendarProposal(text: string, zone: string, id: string, epoch: number, clarification?: string, mailTitle?: string): Promise<PrivateAction> {
    const resolution = resolveCalendarRequest(text, zone, Date.now(), clarification, mailTitle);
    if (resolution.status === 'needs_clarification') return { status: resolution.status, readback: resolution.question, reasonCode: resolution.reasonCode, sourceText: text, timeZone: zone, ...(mailTitle !== undefined ? { mailTitle } : {}), display: {} };
    if (resolution.status === 'rejected') return { status: 'rejected', readback: '시간이 분명하지 않아 추가하지 않았어요.', reasonCode: resolution.reasonCode, display: {} };
    const calendar: CalendarPayload = { kind: 'calendar_insert', ...resolution.payload, eventId: await calendarEventId(`${this.ctx.id.toString()}:${epoch}:${id}`) };
    if (!isSafeReplyBody(calendar.title)) return { status: 'rejected', readback: '제목을 정확히 읽을 수 없어 추가하지 않았어요.', reasonCode: 'unreadable_title', display: {} };
    const calendarSpeechParts = calendarReadbackParts(calendar);
    const readback = calendarSpeechParts.map(part => part.text).join(' ');
    try { sanitizeTtsText(readback, 'reply_readback'); }
    catch { return { status: 'rejected', readback: '제목을 정확히 읽을 수 없어 추가하지 않았어요.', reasonCode: 'unreadable_title', display: {} }; }
    return { status: 'awaiting_approval', calendar, sourceText: text, timeZone: zone, readback, calendarSpeechParts, display: { title: calendar.title, start: calendar.start, end: calendar.end, timeZone: calendar.timeZone, duration: calendar.defaultDuration ? '30분' : '지정 시간' } };
  }
  async clarify(id: string, version: number, text: string, epoch: number): Promise<StoredProposal> {
    const r = this.row(id);
    if (r.epoch !== epoch || this.hooks.epoch() !== epoch) throw new ActionError(403);
    if (r.status !== 'needs_clarification' || r.version !== version || r.clarified || r.kind !== 'calendar_insert') throw new ActionError(409);
    const old = await this.payload(r), p = await this.calendarProposal(old.sourceText!, old.timeZone!, id, epoch, text, old.mailTitle);
    if (old.mailMessageId) p.mailMessageId = old.mailMessageId;
    const next = { ...r, version: version + 1 };
    const envelope = await this.encrypt(next, p), contentHash = await hash(JSON.stringify({ id, epoch, version: next.version, p }));
    const changed = this.ctx.storage.sql.exec("UPDATE actions SET version=?,status=?,content_hash=?,envelope=?,event_id=?,clarified=1 WHERE id=? AND status='needs_clarification' AND version=? RETURNING id", next.version, p.status, contentHash, envelope, p.calendar?.eventId ?? null, id, version).toArray();
    if (!changed.length || this.hooks.epoch() !== epoch) throw new ActionError(409);
    return this.view(this.row(id), p);
  }
  approve(id: string, input: ApprovalInput, epoch: number, holdAudioMs = 1000) {
    const r = this.row(id), now = Date.now();
    if (r.epoch !== epoch || epoch !== this.hooks.epoch()) throw new ActionError(403);
    if (r.version !== input.version || r.content_hash !== input.contentHash) throw new ActionError(409);
    if (r.status === 'holding') return { actionId: id, status: 'holding' as const, executeAt: r.execute_at!, serverNow: now, holdAudioMs: r.hold_audio_ms };
    if (r.status !== 'awaiting_approval') throw new ActionError(r.status === 'expired' ? 410 : 409);
    this.limit('approve', 20);
    if (!Number.isSafeInteger(holdAudioMs) || holdAudioMs < 0 || !Number.isSafeInteger(now + holdAudioMs + 14_500)) throw new ActionError(400);
    const executeAt = now + holdAudioMs + 14_500;
    this.ctx.storage.sql.exec("UPDATE actions SET status='holding',execute_at=?,hold_audio_ms=? WHERE id=? AND status='awaiting_approval'", executeAt, holdAudioMs, id);
    return { actionId: id, status: 'holding' as const, executeAt, serverNow: now, holdAudioMs };
  }
  async arm() { await this.schedule(); }
  cancel(id: string) {
    const r = this.row(id);
    const changed = this.ctx.storage.sql.exec("UPDATE actions SET status='cancelled',outcome=CASE WHEN outcome='draft_create_in_flight' THEN 'cancelled_draft_cleanup_unconfirmed' ELSE 'user_cancelled' END,cleanup_at=? WHERE id=? AND status IN ('awaiting_approval','needs_clarification','holding','preparing') RETURNING id", Date.now() + DAY, id).toArray().length > 0;
    return { actionId: id, status: changed ? 'cancelled' as const : r.status, cancelled: changed };
  }
  notApproved(id: string, epoch: number, version?: number, contentHash?: string) {
    const r = this.row(id);
    if (r.epoch !== epoch || epoch !== this.hooks.epoch()) throw new ActionError(403);
    if (!['awaiting_approval', 'needs_clarification'].includes(r.status)) return { actionId: id, status: r.status, cancelled: false };
    if (version !== undefined && version !== r.version || contentHash !== undefined && contentHash !== r.content_hash) throw new ActionError(409);
    const changed = this.ctx.storage.sql.exec("UPDATE actions SET status='cancelled',outcome='not_approved',envelope='',draft_id=NULL,cleanup_at=? WHERE id=? AND epoch=? AND version=? AND content_hash=? AND status IN ('awaiting_approval','needs_clarification') RETURNING id", Date.now() + DAY, id, epoch, r.version, r.content_hash).toArray().length > 0;
    return { actionId: id, status: changed ? 'cancelled' as const : this.row(id).status, cancelled: changed };
  }
  status(id: string) {
    const r = this.row(id);
    return { actionId: id, kind: r.kind, status: r.status, ...(r.execute_at !== null ? { executeAt: r.execute_at } : {}), ...(r.outcome ? { outcomeCode: r.outcome } : {}) };
  }
  async alarm() {
    this.expire();
    const rows = this.ctx.storage.sql.exec<ActionRow>("SELECT * FROM actions WHERE status IN ('holding','preparing','sending','unknown')").toArray();
    for (const r of rows) {
      if (this.executing.has(r.id)) continue;
      if (r.status === 'sending' || r.status === 'preparing') { this.finish(r.id, 'unknown', 'interrupted_external_operation'); continue; }
      if (r.status === 'unknown') {
        if (!r.envelope || !r.send_attempted || r.reconcile_at === null || r.reconcile_at > Date.now() || r.reconcile_attempts >= 6 || r.epoch !== this.hooks.epoch()) continue;
        const deadline = createDeadline(4000);
        try {
          const p = await this.payload(r);
          if (this.hooks.epoch() !== r.epoch) continue;
          const c = await this.hooks.connection(deadline.signal);
          if (this.hooks.epoch() !== r.epoch) continue;
          const captured = r.draft_id
            ? await decryptPrivateValue(this.env.TOKEN_ENCRYPTION_KEY!, this.aad(r), JSON.parse(r.draft_id)) as { messageId?: unknown }
            : null;
          if (this.hooks.epoch() !== r.epoch) continue;
          const reply = p.reply && typeof captured?.messageId === 'string'
            ? { ...p.reply, draftMessageId: captured.messageId }
            : null;
          if (reply && await reconcileReply(c.tokens.accessToken, reply, deadline.signal) && this.hooks.epoch() === r.epoch) await this.succeed(r, p, 'sent_confirmed');
        } catch { /* Absence or read failure is never proof of non-delivery. */ }
        finally {
          deadline.dispose();
          this.ctx.storage.sql.exec("UPDATE actions SET reconcile_attempts=reconcile_attempts+1,reconcile_at=? WHERE id=? AND status='unknown'", Date.now() + Math.min(30_000, 2000 * 2 ** r.reconcile_attempts), r.id);
        }
        continue;
      }
      if (r.execute_at === null || r.execute_at > Date.now()) continue;
      if (Date.now() > r.execute_at + 30_000 || r.epoch !== this.hooks.epoch()) { this.finish(r.id, 'expired', 'execution_expired'); continue; }
      if (!this.ctx.storage.sql.exec("UPDATE actions SET status='preparing' WHERE id=? AND status='holding' RETURNING id", r.id).toArray().length) continue;
      this.executing.add(r.id);
      const d = createDeadline(10_000);
      let stage = 'authorization';
      try {
        const p = await this.payload(r), c = await this.hooks.connection(d.signal), caps = googleCapabilities(c.tokens.scopes);
        const valid = () => this.hooks.epoch() === r.epoch && this.row(r.id).status === 'preparing' && !d.signal.aborted;
        if (!valid() || !(r.kind === 'mail_reply' ? caps.mailReply : caps.calendarInsert)) { if (valid()) this.finish(r.id, 'failed', 'permission_missing'); continue; }
        if (r.content_hash !== await hash(JSON.stringify({ id: r.id, epoch: r.epoch, version: r.version, p }))) { this.finish(r.id, 'failed', 'payload_changed'); continue; }
        if (p.reply) {
          stage = 'source_read';
          const fresh = await fetchMailMessage(c.tokens.accessToken, p.reply.candidate.messageId, d.signal);
          if (!valid()) continue;
          if (!fresh || fresh.senderAddress !== p.reply.candidate.senderAddress || fresh.threadId !== p.reply.candidate.threadId || fresh.subject !== p.reply.candidate.subject || fresh.messageIdHeader !== p.reply.candidate.messageIdHeader) { this.finish(r.id, 'failed', 'source_changed'); continue; }
          // preparing is persisted before create; a crash here can never create another draft.
          stage = 'draft_create';
          if (!this.ctx.storage.sql.exec("UPDATE actions SET outcome='draft_create_in_flight' WHERE id=? AND status='preparing' RETURNING id", r.id).toArray().length) continue;
          const draftId = await createReplyDraft(c.tokens.accessToken, p.reply, d.signal);
          const cleanupCancelledDraft = async () => {
            const deleted = await deleteReplyDraft(c.tokens.accessToken, draftId, d.signal);
            this.ctx.storage.sql.exec("UPDATE actions SET outcome=? WHERE id=? AND status='cancelled'", deleted ? 'user_cancelled' : 'cancelled_draft_cleanup_unconfirmed', r.id);
          };
          if (!valid()) { await cleanupCancelledDraft(); continue; }
          stage = 'draft_persist';
          const draftEnvelope = JSON.stringify(await encryptPrivateValue(this.env.TOKEN_ENCRYPTION_KEY!, this.aad(r), { draftId }));
          this.ctx.storage.sql.exec("UPDATE actions SET draft_id=? WHERE id=? AND status='preparing'", draftEnvelope, r.id);
          if (!valid()) { await cleanupCancelledDraft(); continue; }
          stage = 'draft_verify';
          const verifiedDraft = await verifyReplyDraft(c.tokens.accessToken, draftId, p.reply, d.signal);
          if (!valid()) { await cleanupCancelledDraft(); continue; }
          if (!verifiedDraft) {
            await cleanupCancelledDraft();
            if (this.row(r.id).status === 'preparing') this.finish(r.id, 'failed', 'draft_mismatch');
            continue;
          }
          stage = 'draft_id_persist';
          const capturedEnvelope = JSON.stringify(await encryptPrivateValue(this.env.TOKEN_ENCRYPTION_KEY!, this.aad(r), { draftId, messageId: verifiedDraft.messageId }));
          if (!valid()) { await cleanupCancelledDraft(); continue; }
          if (!this.ctx.storage.sql.exec("UPDATE actions SET draft_id=? WHERE id=? AND status='preparing' RETURNING id", capturedEnvelope, r.id).toArray().length) { await cleanupCancelledDraft(); continue; }
          if (!valid()) { await cleanupCancelledDraft(); continue; }
          if (!this.ctx.storage.sql.exec("UPDATE actions SET status='sending',send_attempted=1 WHERE id=? AND status='preparing' AND send_attempted=0 RETURNING id", r.id).toArray().length) continue;
          stage = 'send';
          const result = await sendReplyDraft(c.tokens.accessToken, draftId, d.signal);
          if (this.hooks.epoch() !== r.epoch || result.threadId !== p.reply.candidate.threadId) { this.finish(r.id, 'unknown', 'send_result_unconfirmed'); continue; }
          await this.succeed(r, p, 'gmail_accepted');
        } else if (p.calendar) {
          if (!valid() || !this.ctx.storage.sql.exec("UPDATE actions SET status='sending',send_attempted=1 WHERE id=? AND status='preparing' AND send_attempted=0 RETURNING id", r.id).toArray().length) continue;
          const outcome = await insertCalendarEvent(c.tokens.accessToken, p.calendar, d.signal);
          if (outcome === 'succeeded' && this.hooks.epoch() === r.epoch) {
            if (await this.succeed(r, p, 'calendar_created')) this.hooks.invalidateCalendar();
          } else this.finish(r.id, this.hooks.epoch() === r.epoch ? outcome : 'unknown', outcome === 'succeeded' ? 'calendar_created' : 'calendar_unconfirmed');
        } else this.finish(r.id, 'failed', 'payload_missing');
      } catch {
        const current = this.row(r.id);
        if (current.status === 'preparing' || current.status === 'sending') this.finish(r.id, 'unknown', `${stage}_result_unknown`);
      } finally { d.dispose(); this.executing.delete(r.id); }
    }
    await this.schedule();
  }
}

export function terminalSpeech(kind: ActionKind, status: string) {
  if (status === 'succeeded') return kind === 'mail_reply' ? '회신을 보냈어요.' : '캘린더에 추가했어요.';
  if (status === 'unknown') return kind === 'mail_reply'
    ? '처리 결과를 확인하지 못했어요. 중복을 막기 위해 다시 보내지 않을게요.'
    : '처리 결과를 확인하지 못했어요. 중복을 막기 위해 다시 추가하지 않을게요.';
  if (status === 'cancelled' || status === 'expired' || status === 'rejected') return kind === 'mail_reply'
    ? '보내지 않았어요.'
    : '일정을 추가하지 않았어요.';
  if (status === 'failed') return kind === 'mail_reply'
    ? '보내지 못했어요.'
    : '일정을 추가하지 못했어요.';
  return null;
}
