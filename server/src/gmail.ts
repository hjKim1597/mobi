import { GoogleError, googleJson } from './google';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_TEXT = 2_000;
const MAX_HEADER = 2_000;
const MAX_POST_RESPONSE = 64 * 1024;

export interface MailCandidate {
  candidateId: string; messageId: string; threadId: string; sender: string; senderAddress: string;
  subject: string; body: string; messageIdHeader: string; references: string; sensitive: boolean;
  canReply: boolean; canAddCalendar: boolean; summary: string;
}
export interface ReplyPayload { kind: 'mail_reply'; candidate: MailCandidate; body: string; correlationId?: string; draftMessageId?: string }
export interface MailScanTiming {
  measure<T>(stage: 'google_list' | 'google_message_gets', work: () => Promise<T>): Promise<T>;
  setMessageCount(count: number): void;
}

type Header = { name: string; value: string };
type GmailMessage = { id?: unknown; threadId?: unknown; internalDate?: unknown; labelIds?: unknown; payload?: unknown };
type GmailPart = { mimeType?: unknown; headers?: unknown; body?: unknown; parts?: unknown };

function record(v: unknown): Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {}; }
function headersOf(v: unknown): Header[] {
  if (!Array.isArray(v) || v.length > 100) return [];
  return v.filter((x): x is Header => typeof record(x).name === 'string' && typeof record(x).value === 'string') as Header[];
}
function header(headers: Header[], name: string): string[] { return headers.filter(h => h.name.toLowerCase() === name.toLowerCase()).map(h => h.value); }
function safeHeader(value: string, max = MAX_HEADER): boolean { return value.length > 0 && value.length <= max && !/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value); }
function b64decode(data: string): string | null {
  if (data.length > 16_000 || !/^[A-Za-z0-9_+=/-]*$/.test(data)) return null;
  try { const raw = atob(data.replace(/-/g, '+').replace(/_/g, '/')); const bytes = Uint8Array.from(raw, c => c.charCodeAt(0)); return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); } catch { return null; }
}
function extractPlain(partValue: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  const p = record(partValue) as GmailPart;
  if (p.mimeType === 'text/plain') {
    const body = record(p.body); const decoded = typeof body.data === 'string' ? b64decode(body.data) : null;
    return decoded !== null && decoded.length <= MAX_TEXT ? decoded : null;
  }
  if (p.mimeType !== 'multipart/alternative' || !Array.isArray(p.parts) || p.parts.length > 8) return null;
  const plain = p.parts.map(child => extractPlain(child, depth + 1)).find(text => text !== null);
  return plain ?? null;
}
type DraftStructureReason = 'extra_payload_key' | 'mime_type' | 'filename' | 'parts' | 'part_id'
  | 'header_unparsed' | 'content_disposition' | 'content_type' | 'body_keys' | 'body_data' | 'body_size';
function extractExactPlain(partValue: unknown): { text: string | null; reason: DraftStructureReason | null } {
  const fail = (reason: DraftStructureReason) => ({ text: null, reason });
  const p = record(partValue);
  // Classify parts separately, but continue to reject even an empty parts array.
  const allowed = new Set(['partId', 'mimeType', 'filename', 'headers', 'body', 'parts']);
  if (Object.keys(p).some(key => !allowed.has(key))) return fail('extra_payload_key');
  if (p.mimeType !== 'text/plain') return fail('mime_type');
  if (p.filename !== undefined && p.filename !== '') return fail('filename');
  if (Object.hasOwn(p, 'parts')) return fail('parts');
  if (typeof p.partId !== 'undefined' && typeof p.partId !== 'string') return fail('part_id');
  const hs = headersOf(p.headers);
  if (!Array.isArray(p.headers) || hs.length !== p.headers.length) return fail('header_unparsed');
  if (header(hs, 'Content-Disposition').length) return fail('content_disposition');
  const contentTypes = header(hs, 'Content-Type');
  if (contentTypes.length > 1 || contentTypes.some(value => !/^text\/plain(?:\s*;|\s*$)/i.test(value))) return fail('content_type');
  const body = record(p.body);
  if (Object.keys(body).some(key => key !== 'data' && key !== 'size')) return fail('body_keys');
  if (typeof body.data !== 'string') return fail('body_data');
  if (body.size !== undefined && (typeof body.size !== 'number' || !Number.isFinite(body.size) || body.size < 0)) return fail('body_size');
  const decoded = b64decode(body.data);
  return decoded !== null && decoded.length <= MAX_TEXT ? { text: decoded, reason: null } : fail('body_data');
}
function parseAddress(raw: string): { name: string; address: string } | null {
  if (!safeHeader(raw, 500) || raw.includes(',') || raw.includes(';') || raw.includes('<') !== raw.includes('>')) return null;
  const match = /^(?:\s*([^<>]{1,100}?)\s*)?<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,200}@[A-Za-z0-9.-]{1,200})>\s*$/.exec(raw)
    ?? /^([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,200}@[A-Za-z0-9.-]{1,200})$/.exec(raw);
  if (!match) return null;
  const address = (match[2] ?? match[1]).toLowerCase();
  if (!address.includes('.') || address.startsWith('.') || address.includes('..')) return null;
  const name = match[2] ? (match[1] ?? '').replace(/["']/g, '').trim() : address.split('@')[0];
  if (!name || /[<>\[\]{}]/.test(name)) return null;
  return { name: name.slice(0, 80), address };
}
const sensitivePattern = /\b(?:\d{3}-\d{2}-\d{4}|\d{13,19}|\d{6,8})\b|\b(?:password|passcode|verification code|one[- ]time code|otp|account number|credit card|card number|diagnosis|medical|health|healthcare|hospital|clinic|treatment|surgery|prescription|patient|salary|payroll|termination|lawyer|legal advice|lawsuit|court|bank account|routing number|social security)\b|주민등록|여권|인증\s*번호|인증\s*코드|otp|비밀번호|계좌|카드\s*번호|카드번호|건강|정신과|정신건강|심리\s*상담|상담\s*치료|병원|진료|검사\s*결과|진단|치료|(?<![\p{L}\p{N}])암(?![\p{L}\p{N}])|암\s*(?:진단|치료|검사|수술)|수술|처방|입원|건강검진|법률|법무|소송|변호사|법원|고소|합의|인사\s*(?:평가|발령|위원회)|성과\s*평가|근무\s*평가|연봉|급여|해고|징계/iu;
const injectionPattern = /ignore (?:all |the )?(?:previous|prior|above) instructions|system\s*:|developer\s*:|\btool\s*[:{]|\b(?:send|forward|transfer|cancel|delete|reveal|upload)\b|이미 승인|승인받았|보내(?:줘|세요|라)?|취소(?:해|하세요)?|전달해|https?:\/\/|<\/?(?:script|style|div|span|img|a|iframe)\b|\b(?:attach|attachment|credentials)\b|@/i;
function suspicious(text: string): boolean { return injectionPattern.test(text) || /(^|\n)\s*>/.test(text) || /(?:^|\n)\s*(?:list-id|precedence)\s*:/i.test(text); }
function sanitizeText(value: string, max = MAX_TEXT): string | null {
  if (!safeHeader(value, max * 2) || /<[^>]+>|https?:\/\//i.test(value) || /(?:^|\n)\s*>/.test(value)) return null;
  const clean = value.replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return clean.length && clean.length <= max ? clean : null;
}
function makeCandidate(message: GmailMessage, now = Date.now()): MailCandidate | null {
  const id = typeof message.id === 'string' ? message.id : '';
  const threadId = typeof message.threadId === 'string' ? message.threadId : '';
  const payload = record(message.payload) as GmailPart;
  const hs = headersOf(payload.headers);
  const froms = header(hs, 'From'); const replyTos = header(hs, 'Reply-To'); const subjects = header(hs, 'Subject');
  const from = froms.length === 1 ? parseAddress(froms[0]) : null;
  const body = extractPlain(payload);
  const subject = subjects.length === 1 ? sanitizeText(subjects[0], 250) : null;
  const messageIds = header(hs, 'Message-ID'); const references = header(hs, 'References');
  const date = Number(message.internalDate);
  if (!id || !threadId || !Number.isFinite(date) || !Array.isArray(message.labelIds) || !(message.labelIds as unknown[]).includes('INBOX')
      || date < now - 48 * 60 * 60 * 1000 || date > now + 60_000 || !from || !body || !subject || messageIds.length !== 1 || !safeHeader(messageIds[0], 998)
      || references.length > 1 || (references.length === 1 && !safeHeader(references[0], 998))) return null;
  if (replyTos.length && (replyTos.length !== 1 || !parseAddress(replyTos[0]) || parseAddress(replyTos[0])!.address !== from.address)) return null;
  if (/\b(?:no[-_. ]?reply|do[-_. ]?not[-_. ]?reply|mailer-daemon)\b/i.test(from.address) || header(hs, 'Auto-Submitted').some(v => !/^no$/i.test(v))
      || header(hs, 'Precedence').some(v => /bulk|list|junk/i.test(v)) || header(hs, 'List-ID').length > 0) return null;
  const isSensitive = sensitivePattern.test(`${subject}\n${body}`);
  if (suspicious(`${from.name}\n${subject}\n${body}`)) return null;
  if (isSensitive) return { candidateId: id, messageId: id, threadId, sender: '', senderAddress: '', subject: '', body: '', messageIdHeader: '', references: '', sensitive: true, canReply: false, canAddCalendar: false, summary: '' };
  const canReply = /\?|\b(?:please|could you|can you|let me know|confirm|RSVP|are you available)\b|(?:부탁|가능하신가요|괜찮으신가요|확인해|알려주실|답변)/i.test(body);
  const canAddCalendar = /\b(?:meeting|appointment|schedule)\b|회의|약속|일정/i.test(body) && /오전|오후|\d\s*시|\d:\d|\d\s*월|오늘|내일|모레|요일|\b(?:am|pm|tomorrow)\b/i.test(body);
  if (!canReply && !canAddCalendar) return null;
  const summary = canReply ? (/회의|meeting/i.test(subject) ? '회의 관련해 답변을 요청하는 메일입니다.' : '답변을 요청하는 메일입니다.') : '회의 일정을 알려 온 메일이에요';
  return { candidateId: id, messageId: id, threadId, sender: from.name, senderAddress: from.address, subject, body, messageIdHeader: messageIds[0], references: references[0] ?? '', sensitive: false, canReply, canAddCalendar, summary };
}

export async function fetchMailCandidate(accessToken: string, now: number, signal: AbortSignal, timing?: MailScanTiming, isHandled?: (messageId: string) => Promise<boolean>): Promise<MailCandidate | null> {
  const url = new URL(`${API}/messages`); url.search = new URLSearchParams({ labelIds: 'INBOX', q: 'newer_than:2d -category:promotions -category:social -in:spam -in:trash', maxResults: '10' }).toString();
  const listedResult = timing
    ? await timing.measure('google_list', () => googleJson(url, accessToken, signal))
    : await googleJson(url, accessToken, signal);
  const listed = record(listedResult);
  if (!Array.isArray(listed.messages)) return null;
  const items = listed.messages.slice(0, 10).map(record).filter(m => typeof m.id === 'string');
  timing?.setMessageCount(items.length);
  const getMessages = () => Promise.all(items.map(async item =>
    record(await googleJson(new URL(`${API}/messages/${encodeURIComponent(item.id as string)}?format=full`), accessToken, signal)) as GmailMessage));
  const messages = timing
    ? await timing.measure('google_message_gets', getMessages)
    : await getMessages();
  messages.sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
  for (const msg of messages) {
    const result = makeCandidate(msg, now);
    if (result && (!isHandled || !await isHandled(result.messageId))) return result;
  }
  return null;
}

export async function fetchMailMessage(accessToken: string, messageId: string, signal: AbortSignal): Promise<MailCandidate | null> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(messageId)) return null;
  const original = record(await googleJson(new URL(`${API}/messages/${encodeURIComponent(messageId)}?format=full`), accessToken, signal)) as GmailMessage;
  const threadId = typeof original.threadId === 'string' ? original.threadId : '';
  if (!threadId) return null;
  const value = record(await googleJson(new URL(`${API}/threads/${encodeURIComponent(threadId)}?format=full`), accessToken, signal));
  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 100) return null;
  if (value.messages.some(raw => {
    const msg = record(raw);
    return typeof msg.id !== 'string' || msg.id !== messageId && Number(msg.internalDate) > Number(original.internalDate);
  })) return null;
  const candidate = makeCandidate(original);
  if (!candidate) return null;
  return candidate;
}

async function postJson(url: URL, accessToken: string, value: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (signal.aborted) throw new GoogleError('upstream');
  let response: Response;
  try { response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal, redirect: 'manual' }); }
  catch { throw new GoogleError('upstream'); }
  if (response.status === 401) throw new GoogleError('auth');
  if (!response.ok || response.redirected) throw new GoogleError('upstream');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_POST_RESPONSE) throw new GoogleError('upstream');
  if (!response.body) throw new GoogleError('upstream');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const { done, value: chunk } = await reader.read(); if (done) break; size += chunk.byteLength; if (size > MAX_POST_RESPONSE) { await reader.cancel(); throw new GoogleError('upstream'); } chunks.push(chunk); } }
  finally { reader.releaseLock(); }
  try { const body = JSON.parse(new TextDecoder().decode(new Uint8Array(chunks.flatMap(c => [...c])))); return record(body); } catch { throw new GoogleError('upstream'); }
}
function base64url(value: string): string { const bytes = new TextEncoder().encode(value); let binary = ''; for (const b of bytes) binary += String.fromCharCode(b); return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function base64(value: string): string { const bytes = new TextEncoder().encode(value); let binary = ''; for (const b of bytes) binary += String.fromCharCode(b); return btoa(binary); }
/** RFC 2047: independently decodable UTF-8 words, separated by folded whitespace. */
function encodeHeaderText(value: string): string {
  if (!/[^\x00-\x7f]/.test(value)) return value;
  const words: string[] = [];
  const encoder = new TextEncoder();
  let chunk = '', bytes = 0;
  for (const char of value) {
    const size = encoder.encode(char).length;
    // 39 bytes -> 52 base64 chars + 12 delimiters; with "Subject: " < 76.
    if (bytes + size > 39) { words.push(`=?UTF-8?B?${base64(chunk)}?=`); chunk = ''; bytes = 0; }
    chunk += char; bytes += size;
  }
  if (chunk) words.push(`=?UTF-8?B?${base64(chunk)}?=`);
  return words.join('\r\n ');
}
function replyMime(payload: ReplyPayload): string {
  const c = payload.candidate;
  if (!c.canReply || c.sensitive || !parseAddress(`${c.sender} <${c.senderAddress}>`) || !safeHeader(c.subject, 250) || !safeHeader(c.messageIdHeader, 998)
      || (c.references && !safeHeader(c.references, 998)) || !c.threadId || payload.body.length < 1 || [...payload.body].length > 120 || /[\r\x00]/.test(payload.body)) throw new GoogleError('upstream');
  const subject = replySubject(c);
  const refs = replyReferences(c);
  const correlation = correlationMessageId(payload);
  if (payload.correlationId && !correlation) throw new GoogleError('upstream');
  return [`To: ${c.senderAddress}`, `Subject: ${encodeHeaderText(subject)}`, `In-Reply-To: ${c.messageIdHeader}`, `References: ${refs}`, ...(correlation ? [`Message-ID: ${correlation}`] : []), 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64(payload.body)].join('\r\n');
}

function replySubject(candidate: MailCandidate): string { return /^Re:/i.test(candidate.subject) ? candidate.subject : `Re: ${candidate.subject}`; }
function replyReferences(candidate: MailCandidate): string { return [candidate.references, candidate.messageIdHeader].filter(Boolean).join(' ').slice(-998); }
function correlationMessageId(payload: ReplyPayload): string {
  if (!payload.correlationId) return '';
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(payload.correlationId)) throw new GoogleError('upstream');
  return `<mobi-${payload.correlationId}@mobi.invalid>`;
}

function safeMessageId(value: unknown): value is string {
  // A conservative RFC 5322 dot-atom form. No comments, folding, quoted local
  // parts, control characters or surrounding text may enter recovery queries.
  return typeof value === 'string' && safeHeader(value, 998)
    && /^<[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*>$/.test(value);
}

type DraftReason = 'draft_id' | 'thread' | 'to' | 'cc_bcc' | 'subject' | 'in_reply_to'
  | 'references' | 'message_id' | 'structure' | 'body' | 'precondition' | 'read_error' | 'comparison_error';
// Fixed projections prevent arbitrary provider strings in header names/MIME types
// from smuggling mail values into otherwise content-free diagnostics.
const diagnosticHeaderNames = [
  'To', 'Cc', 'Bcc', 'From', 'Sender', 'Reply-To', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References',
  'MIME-Version', 'Content-Type', 'Content-Transfer-Encoding', 'Content-Disposition', 'Received', 'Return-Path',
  'Delivered-To', 'Authentication-Results', 'DKIM-Signature', 'X-Received', 'X-Google-Smtp-Source',
  'X-Gm-Message-State', 'X-Google-Original-Message-ID', 'X-Gmail-Original-Message-ID',
];
const diagnosticMimeTypes = ['text/plain', 'text/html', 'multipart/alternative', 'multipart/mixed', 'multipart/related', 'application/octet-stream'];

/** Read and compare the known draft against the approved MIME snapshot. Never writes or retries. */
export async function verifyReplyDraft(accessToken: string, draftId: string, payload: ReplyPayload, signal: AbortSignal): Promise<{ messageId: string } | null> {
  const diagnostic = {
    reasonCodes: [] as DraftReason[], structureReason: null as DraftStructureReason | null,
    headerNames: [] as string[], mimeType: null as string | null,
    messageId: { exactlyOne: false, domainEndsWithMailGmailCom: false },
    body: { expectedLength: payload.body.length, actualLength: null as number | null,
      equalsAfterCrlfAndTrailingWhitespace: false, endsWithNewline: false },
  };
  let reading = false;
  try {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(draftId)) { diagnostic.reasonCodes.push('draft_id'); return null; }
    if (signal.aborted) { diagnostic.reasonCodes.push('precondition'); return null; }
    reading = true;
    const draft = record(await googleJson(new URL(`${API}/drafts/${encodeURIComponent(draftId)}?format=full`), accessToken, signal));
    reading = false;
    const message = record(draft.message);
    if (draft.id !== draftId) diagnostic.reasonCodes.push('draft_id');
    if (message.threadId !== payload.candidate.threadId) diagnostic.reasonCodes.push('thread');
    const payloadPart = record(message.payload);
    const hs = headersOf(payloadPart.headers);
    diagnostic.headerNames = hs.map(h => diagnosticHeaderNames.find(name => name.toLowerCase() === h.name.toLowerCase()) ?? 'other');
    diagnostic.mimeType = typeof payloadPart.mimeType === 'string'
      ? diagnosticMimeTypes.find(type => type === payloadPart.mimeType) ?? 'other' : null;
    const messageIds = header(hs, 'Message-ID');
    diagnostic.messageId.exactlyOne = messageIds.length === 1;
    const messageIdParts = messageIds.length === 1 ? /^<[^<>@\s]+@([^<>@\s]+)>$/.exec(messageIds[0]) : null;
    diagnostic.messageId.domainEndsWithMailGmailCom = !!messageIdParts?.[1].toLowerCase().endsWith('mail.gmail.com');
    const tos = header(hs, 'To');
    const ccs = header(hs, 'Cc'); const bccs = header(hs, 'Bcc');
    const recipient = tos.length === 1 ? parseAddress(tos[0]) : null;
    if (!recipient || recipient.address !== payload.candidate.senderAddress.toLowerCase()) diagnostic.reasonCodes.push('to');
    if (ccs.length || bccs.length) diagnostic.reasonCodes.push('cc_bcc');
    const exactHeader = (name: string, expected: string): boolean => {
      const values = header(hs, name);
      return expected ? values.length === 1 && values[0] === expected : values.length === 0;
    };
    const exactPayload = extractExactPlain(payloadPart);
    if (!exactHeader('Subject', replySubject(payload.candidate))) diagnostic.reasonCodes.push('subject');
    if (!exactHeader('In-Reply-To', payload.candidate.messageIdHeader)) diagnostic.reasonCodes.push('in_reply_to');
    if (!exactHeader('References', replyReferences(payload.candidate))) diagnostic.reasonCodes.push('references');
    if (messageIds.length !== 1 || !safeMessageId(messageIds[0])) diagnostic.reasonCodes.push('message_id');
    if (exactPayload.reason) {
      diagnostic.reasonCodes.push('structure');
      diagnostic.structureReason = exactPayload.reason;
    } else if (exactPayload.text !== null) {
      const actual = exactPayload.text;
      diagnostic.body.actualLength = actual.length;
      const normalize = (text: string) => text.replace(/\r\n/g, '\n').trimEnd();
      diagnostic.body.equalsAfterCrlfAndTrailingWhitespace = normalize(actual) === normalize(payload.body);
      diagnostic.body.endsWithNewline = actual.endsWith('\n');
      if (actual !== payload.body) diagnostic.reasonCodes.push('body');
    }
    return diagnostic.reasonCodes.length === 0 ? { messageId: messageIds[0] } : null;
  } catch {
    diagnostic.reasonCodes.push(reading ? 'read_error' : 'comparison_error');
    return null;
  } finally {
    // Diagnostic failures must never change a verification or trigger a retry.
    try { console.log(JSON.stringify(diagnostic)); } catch { /* best effort */ }
  }
}

export async function createReplyDraft(accessToken: string, payload: ReplyPayload, signal: AbortSignal): Promise<string> {
  const result = await postJson(new URL(`${API}/drafts`), accessToken, { message: { threadId: payload.candidate.threadId, raw: base64url(replyMime(payload)) } }, signal);
  if (typeof result.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(result.id)) throw new GoogleError('upstream');
  return result.id;
}
export async function sendReplyDraft(accessToken: string, draftId: string, signal: AbortSignal): Promise<{ messageId: string; threadId: string }> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(draftId)) throw new GoogleError('upstream');
  const result = await postJson(new URL(`${API}/drafts/send`), accessToken, { id: draftId }, signal);
  if (typeof result.id !== 'string' || typeof result.threadId !== 'string' || !result.id || !result.threadId) throw new GoogleError('upstream');
  return { messageId: result.id, threadId: result.threadId };
}
/** Only a draft ID returned by this action's create request may be cleaned up. */
export async function deleteReplyDraft(accessToken: string, draftId: string, signal: AbortSignal): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(draftId) || signal.aborted) return false;
  try {
    const response = await fetch(new URL(`${API}/drafts/${encodeURIComponent(draftId)}`), { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` }, signal, redirect: 'manual' });
    void response.body?.cancel().catch(() => {});
    return response.ok || response.status === 404;
  } catch { return false; }
}
export async function reconcileReply(accessToken: string, payload: ReplyPayload, signal: AbortSignal): Promise<boolean> {
  if (!safeMessageId(payload.draftMessageId)) return false;
  const expectedId = payload.draftMessageId;
  const q = `in:sent rfc822msgid:${expectedId.slice(1, -1)}`;
  const url = new URL(`${API}/messages`); url.search = new URLSearchParams({ q, maxResults: '10' }).toString();
  const result = record(await googleJson(url, accessToken, signal));
  if (!Array.isArray(result.messages)) return false;
  for (const entry of result.messages.slice(0, 10)) {
    const id = record(entry).id;
    if (typeof id !== 'string') continue;
    const found = record(await googleJson(new URL(`${API}/messages/${encodeURIComponent(id)}?format=full`), accessToken, signal));
    const hs = headersOf(record(found.payload).headers);
    const to = header(hs, 'To'); const subject = header(hs, 'Subject'); const messageIds = header(hs, 'Message-ID');
    const recipient = to.length === 1 ? parseAddress(to[0]) : null;
    const expectedSubject = /^Re:/i.test(payload.candidate.subject) ? payload.candidate.subject : `Re: ${payload.candidate.subject}`;
    const plain = extractPlain(found.payload);
    if (found.threadId === payload.candidate.threadId && messageIds.length === 1 && messageIds[0] === expectedId
        && recipient?.address === payload.candidate.senderAddress && subject.length === 1 && subject[0] === expectedSubject
        && plain === payload.body) return true;
  }
  return false;
}
