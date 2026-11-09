import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyReplyDraft } from '../src/gmail';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const encoder = new TextEncoder();
const b64 = (value: string) => btoa(String.fromCharCode(...encoder.encode(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const makeFixture = () => {
  const candidate = {
    candidateId: 'candidate-private-71', messageId: 'message-private-82', threadId: 'thread-private-93',
    sender: 'Private Person', senderAddress: 'address-private@example.invalid', subject: 'subject-private-104',
    body: 'source-body-private-115', messageIdHeader: '<source-private-126@example.invalid>',
    references: '<reference-private-137@example.invalid>', sensitive: false, canReply: true,
    canAddCalendar: false, summary: 'private summary',
  };
  const payload = { kind: 'mail_reply' as const, candidate, body: 'approved-body-private-148', correlationId: 'correlation-private-159' };
  const draft: any = {
    id: 'draft-private-160', message: { id: 'reply-private-171', threadId: candidate.threadId, payload: {
      mimeType: 'text/plain', headers: [
        { name: 'To', value: candidate.senderAddress }, { name: 'Subject', value: `Re: ${candidate.subject}` },
        { name: 'In-Reply-To', value: candidate.messageIdHeader },
        { name: 'References', value: `${candidate.references} ${candidate.messageIdHeader}` },
        { name: 'Message-ID', value: '<mobi-correlation-private-159@mobi.invalid>' },
      ], body: { data: b64(payload.body), size: payload.body.length },
    } },
  };
  return { candidate, payload, draft };
};

async function run(draft: unknown, options: { id?: string; aborted?: boolean; fetchError?: boolean } = {}) {
  const fetchMock = vi.fn().mockImplementation(() => options.fetchError
    ? Promise.resolve(new Response('provider-private-error', { status: 503 }))
    : Promise.resolve(response(draft)));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal('fetch', fetchMock);
  const { payload } = makeFixture();
  const controller = new AbortController();
  if (options.aborted) controller.abort();
  const verified = await verifyReplyDraft('access-token-private-182', options.id ?? 'draft-private-160', payload, controller.signal);
  const lines = log.mock.calls.map(call => call.map(String).join(' ')).filter(line => {
    try { JSON.parse(line); return true; } catch { return false; }
  });
  return { result: !!verified, verified, fetchMock, log, lines };
}

function diagnostic(lines: string[]) {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]);
}

describe('draft verification diagnostics', () => {
  it('logs one safe structured line for an approved exact draft', async () => {
    const { draft } = makeFixture();
    const { result, lines } = await run(draft);
    expect(result).toBe(true);
    expect(diagnostic(lines)).toEqual({
      reasonCodes: [], structureReason: null, headerNames: ['To', 'Subject', 'In-Reply-To', 'References', 'Message-ID'],
      mimeType: 'text/plain', messageId: { exactlyOne: true, domainEndsWithMailGmailCom: false },
      body: { expectedLength: 25, actualLength: 25, equalsAfterCrlfAndTrailingWhitespace: true, endsWithNewline: false },
    });
  });

  it.each([
    ['draft_id', (draft: any) => draft, { id: 'bad id' }],
    ['thread', (draft: any) => { draft.message.threadId = 'thread-other-private'; return draft; }],
    ['to', (draft: any) => { draft.message.payload.headers[0].value = 'other-private@example.invalid'; return draft; }],
    ['cc_bcc', (draft: any) => { draft.message.payload.headers.push({ name: 'Bcc', value: 'blind-private@example.invalid' }); return draft; }],
    ['subject', (draft: any) => { draft.message.payload.headers[1].value = 'subject-mutated-private'; return draft; }],
    ['in_reply_to', (draft: any) => { draft.message.payload.headers[2].value = '<different-private@example.invalid>'; return draft; }],
    ['references', (draft: any) => { draft.message.payload.headers[3].value = '<different-private@example.invalid>'; return draft; }],
    ['message_id', (draft: any) => { draft.message.payload.headers[4].value = '<invalid-private>'; return draft; }],
    ['body', (draft: any) => { draft.message.payload.body.data = b64('changed-body-private'); return draft; }],
  ])('reports the %s mismatch from its matching fake draft', async (code: string, mutate: (draft: any) => any, options: { id?: string } = {}) => {
    const { draft } = makeFixture();
    const result = await run(mutate(draft), options as any);
    expect(result.result).toBe(false);
    expect(diagnostic(result.lines).reasonCodes).toContain(code);
  });

  it.each([
    ['extra_payload_key', (p: any) => { p.unexpectedPrivateKey = 'private-value'; }],
    ['mime_type', (p: any) => { p.mimeType = 'application/x-private-type'; }],
    ['filename', (p: any) => { p.filename = 'private-name.txt'; }],
    ['parts', (p: any) => { p.parts = []; }],
    ['part_id', (p: any) => { p.partId = 7; }],
    ['header_unparsed', (p: any) => { p.headers.push({ name: 7, value: 'private-header-value' }); }],
    ['content_disposition', (p: any) => { p.headers.push({ name: 'Content-Disposition', value: 'attachment; filename=private.txt' }); }],
    ['content_type', (p: any) => { p.headers.push({ name: 'Content-Type', value: 'text/html; x-private=1' }); }],
    ['body_keys', (p: any) => { p.body.privateKey = 'private-value'; }],
    ['body_data', (p: any) => { p.body.data = 'not-base64-private'; }],
    ['body_size', (p: any) => { p.body.size = 'invalid-private-size'; }],
  ])('reports structural subcode %s from the offending fake payload', async (subcode, mutate) => {
    const { draft } = makeFixture();
    mutate(draft.message.payload);
    const { result, lines } = await run(draft);
    expect(result).toBe(false);
    expect(diagnostic(lines)).toMatchObject({ reasonCodes: ['structure'], structureReason: subcode });
  });

  it('reports normalized body equivalence and final newline without accepting a byte mismatch', async () => {
    const { draft } = makeFixture();
    draft.message.payload.body.data = b64('approved-body-private-148\r\n  ');
    draft.message.payload.body.size = 'approved-body-private-148\r\n  '.length;
    const { result, lines } = await run(draft);
    expect(result).toBe(false);
    expect(diagnostic(lines)).toMatchObject({
      reasonCodes: ['body'], body: { expectedLength: 25, actualLength: 29, equalsAfterCrlfAndTrailingWhitespace: true, endsWithNewline: false },
    });
  });

  it('reports a literal final newline independently from normalized body equivalence', async () => {
    const { draft } = makeFixture();
    draft.message.payload.body.data = b64('approved-body-private-148\r\n');
    draft.message.payload.body.size = 'approved-body-private-148\r\n'.length;
    const { result, lines } = await run(draft);
    expect(result).toBe(false);
    expect(diagnostic(lines)).toMatchObject({
      reasonCodes: ['body'], body: { expectedLength: 25, actualLength: 27, equalsAfterCrlfAndTrailingWhitespace: true, endsWithNewline: true },
    });
  });

  it('captures a safe rewritten Gmail Message-ID and still logs only its domain observation', async () => {
    const { draft } = makeFixture();
    draft.message.payload.headers[4].value = '<reply@mail.gmail.com>';
    const { result, lines } = await run(draft);
    expect(result).toBe(true);
    expect(diagnostic(lines)).toMatchObject({ reasonCodes: [], messageId: { exactlyOne: true, domainEndsWithMailGmailCom: true } });
    expect(lines.join('')).not.toContain('<reply@mail.gmail.com>');
  });

  it.each(['reply@mail.gmail.com', '<missing-domain>', '<a@@mail.gmail.com>', '<a b@mail.gmail.com>',
    '<a@mail.gmail.com>\r\nBcc: hidden@example.invalid', '<.a@mail.gmail.com>', '<a..b@mail.gmail.com>',
    '<a@-mail.gmail.com>', '<a@mail..gmail.com>', `<${'a'.repeat(1_000)}@mail.gmail.com>`])(
    'rejects a malformed or unsafe stored Message-ID (%#)', async messageId => {
      const { draft } = makeFixture();
      draft.message.payload.headers[4].value = messageId;
      const { result, lines } = await run(draft);
      expect(result).toBe(false);
      expect(diagnostic(lines).reasonCodes).toEqual(['message_id']);
      expect(lines.join('')).not.toContain(messageId);
    },
  );

  it('rejects a missing stored Message-ID', async () => {
    const { draft } = makeFixture();
    draft.message.payload.headers.pop();
    const { result, lines } = await run(draft);
    expect(result).toBe(false);
    expect(diagnostic(lines)).toMatchObject({ reasonCodes: ['message_id'], messageId: { exactlyOne: false } });
  });

  it('reports duplicate Message-ID headers and suppresses unrecognized header and MIME values', async () => {
    const { draft } = makeFixture();
    draft.message.payload.headers.push({ name: 'X-Private-Header-Name', value: 'header-value-private' });
    draft.message.payload.headers.push({ name: 'Message-ID', value: '<second-private@example.invalid>' });
    draft.message.payload.mimeType = 'application/x-private-mime';
    const { result, lines } = await run(draft);
    const line = diagnostic(lines);
    expect(result).toBe(false);
    expect(line).toMatchObject({ reasonCodes: ['message_id', 'structure'], messageId: { exactlyOne: false }, mimeType: 'other' });
    expect(line.headerNames).toContain('other');
    expect(JSON.stringify(line)).not.toContain('X-Private-Header-Name');
    expect(JSON.stringify(line)).not.toContain('application/x-private-mime');
  });

  it('logs read errors once without provider details or another request', async () => {
    const { draft } = makeFixture();
    const { result, fetchMock, lines } = await run(draft, { fetchError: true });
    expect(result).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(diagnostic(lines).reasonCodes).toEqual(['read_error']);
  });

  it('reports a returned draft ID mismatch', async () => {
    const { draft } = makeFixture();
    draft.id = 'returned-draft-private';
    const { result, lines } = await run(draft);
    expect(result).toBe(false);
    expect(diagnostic(lines).reasonCodes).toEqual(['draft_id']);
  });

  it('reports comparison exceptions without exposing exception text', async () => {
    const { draft, payload } = makeFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(draft)));
    const candidate = Object.defineProperty({ ...payload.candidate }, 'threadId', {
      get() { throw new Error('comparison-private-value'); },
    });
    const result = await verifyReplyDraft('token', 'draft-private-160', { ...payload, candidate }, new AbortController().signal);
    expect(result).toBeNull();
    const line = diagnostic(log.mock.calls.map(call => call.map(String).join(' ')).filter(value => {
      try { JSON.parse(value); return true; } catch { return false; }
    }));
    expect(line.reasonCodes).toEqual(['comparison_error']);
    expect(JSON.stringify(line)).not.toContain('comparison-private-value');
  });

  it.each([
    ['invalid id', { id: 'bad id' }, ['draft_id']],
    ['aborted signal', { aborted: true }, ['precondition']],
  ])('diagnoses %s before fetching', async (_name, options, reasons) => {
    const { draft } = makeFixture();
    const { result, fetchMock, lines } = await run(draft, options as any);
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(diagnostic(lines).reasonCodes).toEqual(reasons);
  });

  it('never emits mail values, identifiers, tokens, or provider error text', async () => {
    const { draft } = makeFixture();
    draft.message.payload.headers.push({ name: 'X-Private-Header-Name', value: 'header-value-private' });
    draft.message.payload.mimeType = 'application/x-private-mime';
    const { lines } = await run(draft);
    const serialized = lines.join('\n');
    for (const secret of [
      'subject-private-104', 'approved-body-private-148', 'address-private@example.invalid',
      '<mobi-correlation-private-159@mobi.invalid>', '<source-private-126@example.invalid>',
      '<reference-private-137@example.invalid>', 'reply-private-171', 'draft-private-160',
      'access-token-private-182', 'header-value-private', 'X-Private-Header-Name', 'application/x-private-mime',
    ]) expect(serialized).not.toContain(secret);
  });

  it.each([true, false])('preserves verification result when the diagnostic logger throws (%s)', async expected => {
    const { draft } = makeFixture();
    if (!expected) draft.message.payload.body.data = b64('changed-body-private');
    vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('logger-private-error'); });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(draft)));
    const { payload } = makeFixture();
    await expect(verifyReplyDraft('token', 'draft-private-160', payload, new AbortController().signal)).resolves.toEqual(expected ? { messageId: '<mobi-correlation-private-159@mobi.invalid>' } : null);
  });
});
