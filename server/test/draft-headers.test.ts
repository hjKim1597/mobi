import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReplyDraft } from '../src/gmail';

afterEach(() => { vi.unstubAllGlobals(); });

const response = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

const candidate = (subject: string) => ({
  candidateId: 'candidate-1', messageId: 'message-1', threadId: 'thread-1',
  sender: 'Alex Kim', senderAddress: 'alex@example.com', subject, body: '확인 부탁드립니다.',
  messageIdHeader: '<message-1@example.com>', references: '', sensitive: false,
  canReply: true, canAddCalendar: false, summary: '회의 확인 요청입니다.',
});

async function generatedSubject(sourceSubject: string): Promise<string> {
  let raw = '';
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    const encoded = request.message.raw.replace(/-/g, '+').replace(/_/g, '/');
    raw = atob(encoded + '='.repeat((4 - encoded.length % 4) % 4));
    return response({ id: 'draft-1' });
  }));

  await createReplyDraft('token', {
    kind: 'mail_reply', candidate: candidate(sourceSubject), body: '답장 본문입니다.',
  }, new AbortController().signal);

  const subjectLines = raw.split('\r\n').filter((line, index, lines) =>
    line.startsWith('Subject:') || (index > 0 && /^[ \t]/.test(line) && lines.slice(0, index).some(previous => previous.startsWith('Subject:'))),
  );
  expect(subjectLines.length).toBeGreaterThan(0);
  for (const line of subjectLines) expect(line.length).toBeLessThanOrEqual(76);
  return subjectLines.join('\r\n').replace(/\r\n[ \t]+/g, ' ').slice('Subject: '.length);
}

function decodeEncodedWords(value: string): string {
  const words = [...value.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/]+=*)\?=/g)];
  expect(words.length).toBeGreaterThan(0);
  for (const word of words) expect(word[0].length).toBeLessThanOrEqual(75);
  return words.map((word) => {
    const bytes = Uint8Array.from(atob(word[1]), char => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  }).join('');
}

describe('reply draft Subject header encoding', () => {
  it('encodes Korean and decodes back to the exact reply subject', async () => {
    const subject = await generatedSubject('회의 일정 확인');
    expect(decodeEncodedWords(subject)).toBe('Re: 회의 일정 확인');
  });

  it('splits long Korean text into bounded encoded words without splitting UTF-8 sequences', async () => {
    const expected = `Re: ${'가나다라마바사'.repeat(24)}`;
    const subject = await generatedSubject(expected.slice(4));
    expect(decodeEncodedWords(subject)).toBe(expected);
  });

  it('encodes four-byte UTF-8 characters without splitting a character', async () => {
    const expected = 'Re: 회의 😀 일정';
    const subject = await generatedSubject(expected.slice(4));
    expect(decodeEncodedWords(subject)).toBe(expected);
  });

  it('keeps ASCII subjects unchanged', async () => {
    expect(await generatedSubject('Project update')).toBe('Re: Project update');
  });
});
