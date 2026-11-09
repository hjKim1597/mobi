import { describe, expect, it } from 'vitest';
import { terminalSpeech, type ActionKind } from '../src/actions';
import { actionWordingSentences } from '../src/action-wording-audio';

describe('action terminal speech by result stage', () => {
  it.each([
    ['mail_reply', 'cancelled', '보내지 않았어요.'],
    ['mail_reply', 'expired', '보내지 않았어요.'],
    ['mail_reply', 'rejected', '보내지 않았어요.'],
    ['mail_reply', 'failed', '보내지 못했어요.'],
    ['mail_reply', 'unknown', '처리 결과를 확인하지 못했어요. 중복을 막기 위해 다시 보내지 않을게요.'],
    ['calendar_insert', 'cancelled', '일정을 추가하지 않았어요.'],
    ['calendar_insert', 'expired', '일정을 추가하지 않았어요.'],
    ['calendar_insert', 'rejected', '일정을 추가하지 않았어요.'],
    ['calendar_insert', 'failed', '일정을 추가하지 못했어요.'],
    ['calendar_insert', 'unknown', '처리 결과를 확인하지 못했어요. 중복을 막기 위해 다시 추가하지 않을게요.'],
  ] as const)('%s %s maps to its actual terminal stage', (kind, status, expected) => {
    expect(terminalSpeech(kind as ActionKind, status)).toBe(expected);
  });

  it('keeps success wording unchanged and has no message for nonterminal statuses', () => {
    expect(terminalSpeech('mail_reply', 'succeeded')).toBe('회신을 보냈어요.');
    expect(terminalSpeech('calendar_insert', 'succeeded')).toBe('캘린더에 추가했어요.');
    expect(terminalSpeech('mail_reply', 'holding')).toBeNull();
  });

  it('has pre-generated MeloTTS audio keyed by every changed fixed sentence', () => {
    expect(actionWordingSentences.map(({ text }) => text).sort()).toEqual([
      '보내지 않았어요.',
      '보내지 못했어요.',
      '일정을 추가하지 않았어요.',
      '일정을 추가하지 못했어요.',
      '처리 결과를 확인하지 못했어요. 중복을 막기 위해 다시 추가하지 않을게요.',
      '회신 내용을 작성할까요?',
      '일정 내용을 확인할까요?',
    ].sort());
    for (const { audio } of actionWordingSentences) {
      expect(audio.mimeType).toBe('audio/wav');
      expect(audio.data.length).toBeGreaterThan(0);
    }
  });
});
