import { describe, expect, it, vi } from 'vitest';
import { isSafeReplyBody, sanitizeTtsText } from '../src/tts';
import { synthesize } from '../src/voice';

const cases = [
  ['**오늘** 일정은 3개입니다.', '오늘 일정은 세 개입니다.'],
  ['회의는 09:05에 시작해요.', '회의는 아홉 시 오 분에 시작해요.'],
  ['오후 3:30에 출발해요.', '오후 세 시 삼십 분에 출발해요.'],
  ['00:00에 점검해요.', '자정에 점검해요.'],
  ['12:00에 만나요.', '정오에 만나요.'],
  ['남은 시간은 15분이에요.', '남은 시간은 십오 분이에요.'],
  ['1시간 20분 남았어요.', '한 시간 이십 분 남았어요.'],
  ['일정은 2개, 알림은 4개예요.', '일정은 두 개, 알림은 네 개예요.'],
  ['거리는 3.5km예요.', '거리는 삼 점 오 킬로미터예요.'],
  ['요금은 12,000원이에요.', '요금은 일만 이천 원이에요.'],
  ['진행률은 50%예요.', '진행률은 오십 퍼센트예요.'],
  ['기온은 -3도예요.', '기온은 영하 삼 도예요.'],
  ['[자료](https://example.invalid/a?x=1) 확인해요.', '자료 확인해요.'],
  ['링크 https://example.invalid/a?x=1 확인해요.', '링크 확인해요.'],
  ['**회의** #준비 완료 ✅.', '회의 준비 완료.'],
  ['회의 👨‍👩‍👧‍👦 👍🏽 🇰🇷 준비됐어요.', '회의 준비됐어요.'],
  ['<b>일정</b><script>alert(1)</script> 확인해요.', '일정 확인해요.'],
  ['준비물: 서류/필기구 & 가방 → 확인.', '준비물 서류 필기구 가방 확인.'],
  ['  회의\t\n 장소는\u200B 회의실입니다.  ', '회의 장소는 회의실입니다.'],
  ['알림 2️⃣개 🔔 확인해요.', '알림 두 개 확인해요.'],
] as const;

describe('sanitizeTtsText', () => {
  it.each(['A01회의', '프로젝트 007 회의', 'v2', '2A', 'é2', '00', '010 1234', '1,2,3번', '3.5', '10:30', '1234567'])('rejects ambiguous approved action text: %s', text => {
    expect(isSafeReplyBody(text)).toBe(false);
  });
  it.each([
    ['2026년', '이천이십육년'], ['3명', '삼명'], ['10시', '십시'], ['100명', '백명'], ['0명', '영명'],
  ])('accepts and only pronounces the numeric run in approved action text: %s', (text, expected) => {
    expect(isSafeReplyBody(text)).toBe(true);
    expect(sanitizeTtsText(text, 'reply_readback')).toBe(expected);
  });
  it.each(['Sender01 님에게 회신할게요.', 'Sender2 님에게 회신할게요.', '김 007 님에게 회신할게요.'])('rejects ambiguous numbers in a complete approval readback: %s', text => {
    expect(() => sanitizeTtsText(text, 'reply_readback')).toThrow();
  });
  it.each([
    ['Alex Kim 님에게 \'네,괜찮아요!\'라고 회신할게요. 보내려면 \'보내\'라고 말씀해 주세요.', 'Alex Kim 님에게 \'네,괜찮아요!\'라고 회신할게요. 보내려면 \'보내\'라고 말씀해 주세요.'],
    ['금액은 "3원"이고 수량은 2개입니다.', '금액은 "삼원"이고 수량은 이개입니다.'],
  ])('preserves reply readback except numeric pronunciation: %s', (input, expected) => {
    expect(sanitizeTtsText(input, 'reply_readback')).toBe(expected);
  });
  it.each(cases)('normalizes %s', (input, expected) => {
    const result = sanitizeTtsText(input);
    expect(result).toBe(expected);
    expect(result).not.toMatch(/https?:|<|>|[*#✅]|\d/);
  });

  it('cleans empty, emoji-only, URL-only, and whitespace-only input', () => {
    expect(sanitizeTtsText('')).toBe('');
    expect(sanitizeTtsText('✅ 👨‍👩‍👧‍👦 🇰🇷 🔔')).toBe('');
    expect(sanitizeTtsText('https://example.invalid/a?x=1')).toBe('');
    expect(sanitizeTtsText(' \t\n ')).toBe('');
  });

  it('preserves ordinary Korean and is idempotent', () => {
    const input = '내일 오전에 도서관에서 책을 읽어요.';
    const once = sanitizeTtsText(input);
    expect(once).toBe(input);
    expect(sanitizeTtsText(once)).toBe(once);
  });

  it('reads dates, standalone integers, decimals, and negative values deterministically', () => {
    expect(sanitizeTtsText('2026년 10월 23일 일정입니다.')).toBe('이천이십육 년 십 월 이십삼 일 일정입니다.');
    expect(sanitizeTtsText('숫자는 42입니다.')).toBe('숫자는 사십이입니다.');
    expect(sanitizeTtsText('값은 3.5입니다.')).toBe('값은 삼 점 오입니다.');
    expect(sanitizeTtsText('기온은 -3입니다.')).toBe('기온은 마이너스 삼입니다.');
  });

  it('preserves clock meaning, native counters, and standalone hour quantities', () => {
    expect(sanitizeTtsText('13:00에 시작해요.')).toBe('오후 한 시에 시작해요.');
    expect(sanitizeTtsText('09:00에 시작해요.')).toBe('아홉 시에 시작해요.');
    expect(sanitizeTtsText('21개 남았어요.')).toBe('스물한 개 남았어요.');
    expect(sanitizeTtsText('1시간 남았어요.')).toBe('한 시간 남았어요.');
  });

  it.each([
    ['진행률은 3.5%예요.', '진행률은 삼 점 오 퍼센트예요.'],
    ['금액은 3.5원이에요.', '금액은 삼 점 오 원이에요.'],
    ['금액은 1,234.50원이에요.', '금액은 천이백삼십사 점 오 영 원이에요.'],
    ['기온은 -3.5도예요.', '기온은 영하 삼 점 오 도예요.'],
  ])('preserves decimal meaning with units (F1): %s', (input, expected) => {
    const once = sanitizeTtsText(input);
    expect(once).toBe(expected);
    expect(sanitizeTtsText(once)).toBe(once);
  });

  it('is idempotent outside the integer formatting range (F2)', () => {
    const once = sanitizeTtsText('숫자는 1000000000000000000000입니다.');
    expect(sanitizeTtsText(once)).toBe(once);
    expect(once).toBe(`숫자는 일 ${'영 '.repeat(20)}영입니다.`);
  });

  it.each([
    '숫자는 1000000000000입니다.',
    '숫자는 9007199254740993입니다.',
    '금액은 1000000000000000000000원이에요.',
    '진행률은 1000000000000000000000.50%예요.',
  ])('preserves large digit strings without exponent notation (F2): %s', input => {
    const once = sanitizeTtsText(input);
    expect(once).not.toMatch(/[0-9e+]/);
    expect(sanitizeTtsText(once)).toBe(once);
  });
});


describe('TTS adapter boundary', () => {
  it('passes the punctuation-preserving approved reply text to the real synthesis adapter', async () => {
    const bytes = new Uint8Array(46), view = new DataView(bytes.buffer);
    for (const [at, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) [...text].forEach((c, i) => { bytes[at + i] = c.charCodeAt(0); });
    view.setUint32(4, 38, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, 2, true);
    const run = vi.fn(async () => new Response(bytes));
    const text = 'Alex 님에게 \'"3원"입니다.\'라고 회신할게요.';
    const result = await synthesize({ run } as unknown as Ai, text, Date.now() + 1000, {}, 'reply_readback');
    expect(result.text).toBe('Alex 님에게 \'"삼원"입니다.\'라고 회신할게요.');
    expect(run.mock.calls[0]).toMatchObject(['@cf/myshell-ai/melotts', { prompt: result.text }, { returnRawResponse: true }]);
  });
  it.each(cases)('sanitizes the actual MeloTTS prompt for %s', async (input, expected) => {
    const bytes = new Uint8Array(46), v = new DataView(bytes.buffer);
    for (const [at, value] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) [...value].forEach((c, i) => { bytes[at + i] = c.charCodeAt(0); });
    v.setUint32(4, 38, true); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 44100, true); v.setUint32(28, 88200, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); v.setUint32(40, 2, true);
    const run = vi.fn(async () => new Response(bytes, { headers: { 'Content-Type': 'audio/mpeg' } }));
    const result = await synthesize({ run } as unknown as Ai, input, Date.now() + 1000);
    expect(result.text).toBe(expected); expect(result.audio.mimeType).toBe('audio/wav');
    expect(run.mock.calls[0]).toMatchObject(['@cf/myshell-ai/melotts', { prompt: expected, lang: 'kr' }, { returnRawResponse: true }]);
  });
  it('never calls AI for an empty sanitized input', async () => {
    const run = vi.fn(); await expect(synthesize({ run } as unknown as Ai, '✅', Date.now() + 1000)).rejects.toThrow(); expect(run).not.toHaveBeenCalled();
  });
});
