import { afterEach, describe, expect, it, vi } from 'vitest';
import { speakProposal, type ActionHttpContext } from '../src/action-http';
import { ActionError, type StoredProposal } from '../src/actions';
import { calendarReadback, type CalendarPayload } from '../src/calendar-actions';
import type { Env } from '../src/state';
import { sanitizeTtsText } from '../src/tts';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function wav(): Uint8Array {
  const bytes = new Uint8Array(44 + 320 * 2), view = new DataView(bytes.buffer);
  const put = (at: number, value: string) => [...value].forEach((char, i) => { bytes[at + i] = char.charCodeAt(0); });
  put(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); put(8, 'WAVE'); put(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  put(36, 'data'); view.setUint32(40, 640, true);
  return bytes;
}

function context(run: (prompt: string) => Promise<Response>): ActionHttpContext {
  const ai = { run: vi.fn((_model: string, input: { prompt: string }) => run(input.prompt)) };
  return {
    env: { AI: ai } as unknown as Env,
    device: {} as ActionHttpContext['device'], epoch: 1, receivedAt: Date.now(), deadlineAt: Date.now() + 10_000,
    hedge: { reserve: vi.fn(), observe: vi.fn() }, check: vi.fn(async () => {}), admit: vi.fn(async () => {}),
  };
}

function response() { return new Response(wav(), { headers: { 'content-type': 'audio/wav' } }); }
function proposal(speechText: string, status: StoredProposal['status'] = 'awaiting_approval', display: Record<string, string> = {}): StoredProposal {
  return { actionId: 'speech-test', version: 1, status, speechText, display, expiresAt: new Date(0).toISOString(), contentHash: 'a'.repeat(64) };
}

describe('action proposal speech splitting', () => {
  it('keeps reply readback in ordered sender, body, and fixed instruction sentences', async () => {
    const sender = 'Alex Kim', body = '네, 참석하겠습니다.';
    const full = `${sender} 님에게 '${body}'라고 회신할게요. 보내려면 '보내'라고 말씀해 주세요.`;
    const c = context(async () => response());

    const value = proposal(full, 'awaiting_approval', { sender, body });
    const first = await speakProposal(value, c);
    (c.env.AI.run as ReturnType<typeof vi.fn>).mockClear();
    const result = await speakProposal(value, c);

    expect(first.sentences.map(sentence => sentence.text)).toEqual([
      `${sender} 님에게`, `'${body}'라고 회신할게요.`, "보내려면 '보내'라고 말씀해 주세요.",
    ]);
    expect(result.sentences.map(sentence => sentence.text)).toEqual([
      `${sender} 님에게`, `'${body}'라고 회신할게요.`, "보내려면 '보내'라고 말씀해 주세요.",
    ]);
    expect(result.sentences.map(sentence => sentence.text).join(' ')).toBe(sanitizeTtsText(full, 'reply_readback'));
    expect(c.env.AI.run).toHaveBeenCalledTimes(2);
    expect((c.env.AI.run as ReturnType<typeof vi.fn>).mock.calls.map(call => call[1].prompt)).toEqual([
      `${sender} 님에게`, `'${body}'라고 회신할게요.`,
    ]);
  });

  it.each([true, false])('splits a calendar readback into ordered sentences (default duration: %s)', async defaultDuration => {
    const payload: CalendarPayload = {
      kind: 'calendar_insert', title: '프로젝트 회의', start: '2026-10-24T14:00:00+09:00', end: '2026-10-24T14:30:00+09:00',
      timeZone: 'Asia/Seoul', defaultDuration, eventId: 'event-1',
    };
    const full = calendarReadback(payload), c = context(async () => response());
    const value = proposal(full, 'awaiting_approval', {
      title: payload.title, start: payload.start, end: payload.end, timeZone: payload.timeZone, duration: defaultDuration ? '30분' : '지정 시간',
    });
    const first = await speakProposal(value, c);
    (c.env.AI.run as ReturnType<typeof vi.fn>).mockClear();

    const result = await speakProposal(value, c);
    const fixedInstruction = "추가하려면 '추가해'라고 말씀해 주세요.";
    const expected = [
      '십월 이십사일 오후 두 시부터 두 시 반까지',
      "'프로젝트 회의' 일정을 내 캘린더에 추가할게요.", fixedInstruction,
    ];
    expect(first.sentences.map(sentence => sentence.text)).toEqual(expected);
    expect(result.sentences.map(sentence => sentence.text)).toEqual(expected);
    expect(result.sentences.map(sentence => sentence.text).join(' ')).toBe(sanitizeTtsText(full, 'reply_readback'));
    expect(c.env.AI.run).toHaveBeenCalledTimes(2);
    expect((c.env.AI.run as ReturnType<typeof vi.fn>).mock.calls.map(call => call[1].prompt)).toEqual([
      expected[0], expected[1],
    ]);
  });

  it('reuses cached fixed clarification or rejection speech on a second request', async () => {
    const text = '한 문장으로 짧게 다시 말씀해 주세요.', c = context(async () => response());
    const value = proposal(text, 'rejected');

    const first = await speakProposal(value, c);
    (c.env.AI.run as ReturnType<typeof vi.fn>).mockClear();
    const second = await speakProposal(value, c);

    expect(first.sentences.map(sentence => sentence.text)).toEqual([text]);
    expect(second.sentences.map(sentence => sentence.text)).toEqual([text]);
    expect(c.env.AI.run).not.toHaveBeenCalled();
  });

  it('rejects readback text that disagrees with reply display fields', async () => {
    const value = proposal('Alex 님에게 다른 내용이라고 회신할게요. 보내려면 \'보내\'라고 말씀해 주세요.', 'awaiting_approval', { sender: 'Alex', body: '네, 확인했습니다.' });
    await expect(speakProposal(value, context(async () => response()))).rejects.toEqual(new ActionError(502));
  });

  it('rejects readback text that disagrees with canonical calendar speech parts', async () => {
    const value = proposal('읽을 수 있는 기존 문장입니다.', 'awaiting_approval', { title: '팀 회의', start: '2026-10-24T14:00:00+09:00', end: '2026-10-24T14:30:00+09:00', timeZone: 'Asia/Seoul', duration: '지정 시간' });
    value.calendarSpeechParts = [{ text: '다른 고정 문구입니다.', fixed: false }];
    await expect(speakProposal(value, context(async () => response()))).rejects.toEqual(new ActionError(502));
  });

  it('keeps a validated legacy calendar readback when old display reconstruction matches', async () => {
    const legacy = '2026년 10월 24일 오후 2시 0분부터 2026년 10월 24일 오후 2시 30분까지 \'팀 회의\' 일정을 Asia 슬래시 Seoul 시간대 내 캘린더에 추가할게요. 추가하려면 \'추가해\'라고 말씀해 주세요.';
    const result = await speakProposal(proposal(legacy, 'awaiting_approval', { title: '팀 회의', start: '2026-10-24T14:00:00+09:00', end: '2026-10-24T14:30:00+09:00', timeZone: 'Asia/Seoul', duration: '지정 시간' }), context(async () => response()));
    expect(result.sentences).toHaveLength(1);
    expect(result.sentences[0].text).toBe(sanitizeTtsText(legacy, 'reply_readback'));
  });

  it('rejects a mismatched legacy calendar readback without synthesizing it', async () => {
    const legacy = '2026년 10월 24일 오후 3시 0분부터 2026년 10월 24일 오후 3시 30분까지 \'팀 회의\' 일정을 Asia 슬래시 Seoul 시간대 내 캘린더에 추가할게요. 추가하려면 \'추가해\'라고 말씀해 주세요.';
    const c = context(async () => response());
    await expect(speakProposal(proposal(legacy, 'awaiting_approval', { title: '팀 회의', start: '2026-10-24T14:00:00+09:00', end: '2026-10-24T14:30:00+09:00', timeZone: 'Asia/Seoul', duration: '지정 시간' }), c)).rejects.toEqual(new ActionError(502));
    expect(c.env.AI.run).not.toHaveBeenCalled();
  });

  it('synthesizes variable sentences concurrently while preserving their order', async () => {
    vi.useFakeTimers();
    const cacheWarmer = context(async () => response());
    await speakProposal(proposal("Lee 님에게 '네'라고 회신할게요. 보내려면 '보내'라고 말씀해 주세요.", 'awaiting_approval', { sender: 'Lee', body: '네' }), cacheWarmer);
    let active = 0, maxActive = 0;
    let announceBothStarted!: () => void;
    const bothStarted = new Promise<void>(resolve => { announceBothStarted = resolve; });
    const releaseSyntheses: Array<(value: Response) => void> = [];
    const c = context(() => new Promise<Response>(resolve => {
      active++; maxActive = Math.max(maxActive, active);
      releaseSyntheses.push(value => { active--; resolve(value); });
      if (releaseSyntheses.length === 2) announceBothStarted();
    }));
    const full = "Lee 님에게 '네'라고 회신할게요. 보내려면 '보내'라고 말씀해 주세요.";
    const pending = speakProposal(proposal(full, 'awaiting_approval', { sender: 'Lee', body: '네' }), c);
    await bothStarted;
    // Both variable sentences must start while neither synthesis can finish.
    expect(active).toBe(2);
    expect(c.env.AI.run).toHaveBeenCalledTimes(2);
    releaseSyntheses.forEach(release => release(response()));
    const result = await pending;

    expect(result.sentences.map(sentence => sentence.text)).toEqual([
      'Lee 님에게', "'네'라고 회신할게요.", "보내려면 '보내'라고 말씀해 주세요.",
    ]);
    expect(maxActive).toBe(2);
  });

  it('fails the full proposal response if any variable sentence synthesis fails', async () => {
    vi.useFakeTimers();
    const c = context(async prompt => {
      if (prompt.includes('회신할게요')) throw Error('tts failed');
      return response();
    });
    const full = "Lee 님에게 '네'라고 회신할게요. 보내려면 '보내'라고 말씀해 주세요.";

    const rejected = expect(speakProposal(proposal(full, 'awaiting_approval', { sender: 'Lee', body: '네' }), c)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(700);
    await rejected;
  });
});
