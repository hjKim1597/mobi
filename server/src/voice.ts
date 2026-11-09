import { z } from 'zod';
import { inspectPcmWav, readAudioResponse, AudioInputError } from './audio';
import { withDeadline, assertBeforeDeadline, runHedged, trackInference, reserveInference, type HedgeContext, VOICE_STAGE_ADMISSION, VoiceDeadlineError } from './deadline';
import { sanitizeTtsText } from './tts';
import { WorkersAiLlmProvider, type LlmProvider } from './llm';
import type { TodayCalendar, TodayEvent } from './calendar';
import { routeCalendarQuestion, type CalendarQuestionAnswer } from './calendar-router';
import { failureSentences } from './failure-audio';
import { ActionError, calendarAddRequest } from './actions';
import type { actionProposalSchema } from './action-schemas';
import { calendarUnavailableSentence } from './calendar-unavailable-audio';

export type InputAudio = { data: string; mimeType: 'audio/wav' | 'audio/webm' | 'audio/mp4' };
export type OutputAudio = { data: string; mimeType: 'audio/wav' };
export type TranscriptionMode = 'confirm' | 'turn' | 'dictation' | 'approval_mail' | 'approval_calendar';
export class VoiceHttpError extends Error {
  constructor(readonly status: 403 | 500 | 502) { super('Voice request failed'); }
}
export const REPLIES = ['응', '네', '됐어', '보내', '취소', '하지 마', '아니', '그래', '들려줘', '나중에', '조용히', '그만', '괜찮아', '보내줘', '바꿔', '바꿔줘', '보내지 마', '바꾸지 마', '말해줘', '안내해줘'] as const;
const WRITE = new Set(['보내', '보내줘', '바꿔', '바꿔줘']);
const LISTEN = new Set(['응', '네', '그래', '들려줘', '말해줘', '안내해줘']);
const CANCEL = new Set(['취소', '보내지마', '바꾸지마']);
const normalize = (text: string) => text.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '').toLowerCase();
type Match = { label: typeof REPLIES[number] | 'NONE'; action: 'SEND' | 'CHANGE' | 'CANCEL' | 'LISTEN' | 'NOT_NOW'; mode: 'exact' | 'fuzzy-safe' | 'none' };
function action(label: string): Match['action'] {
  const text = normalize(label);
  return WRITE.has(text) ? (text.startsWith('보내') ? 'SEND' : 'CHANGE') : CANCEL.has(text) ? 'CANCEL' : LISTEN.has(text) ? 'LISTEN' : 'NOT_NOW';
}
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const row = [i + 1];
    for (let j = 0; j < b.length; j++) row.push(Math.min(row[j] + 1, prev[j + 1] + 1, prev[j] + (a[i] === b[j] ? 0 : 1)));
    prev = row;
  }
  return prev[b.length];
}
export function matchClosedSet(text: string): Match {
  const n = normalize(text), exact = REPLIES.find(label => normalize(label) === n);
  if (exact) return { label: exact, action: action(exact), mode: 'exact' };
  const none: Match = { label: 'NONE', action: 'NOT_NOW', mode: 'none' };
  if (n.length < 3 || n.length > 12 || [...WRITE].some(label => distance(n, label) <= 1)) return none;
  const candidates = REPLIES.filter(label => !WRITE.has(normalize(label)) && normalize(label).length >= 3)
    .map(label => ({ label, distance: distance(n, normalize(label)) })).sort((a, b) => a.distance - b.distance);
  if (candidates[0]?.distance !== 1 || candidates[1]?.distance === 1) return none;
  return { label: candidates[0].label, action: action(candidates[0].label), mode: 'fuzzy-safe' };
}

function hasSpeech(audio: InputAudio): boolean {
  if (audio.mimeType !== 'audio/wav') throw new VoiceHttpError(502);
  const stats = inspectPcmWav(audio.data);
  return stats.rmsDb >= -45 && stats.activeRatio >= 0.06;
}
export async function transcribe(ai: Ai, audio: InputAudio, mode: TranscriptionMode, deadlineAt: number, context: HedgeContext = {}): Promise<string> {
  try {
    assertBeforeDeadline(deadlineAt);
    return hasSpeech(audio) ? await transcribeSpeech(ai, audio, mode, deadlineAt, context) : '';
  } finally { audio.data = ''; }
}
async function transcribeSpeech(ai: Ai, audio: InputAudio, mode: TranscriptionMode, deadlineAt: number, context: HedgeContext = {}): Promise<string> {
  const audioData = audio.data;
  const approvalPrompt = mode === 'approval_mail'
    ? '짧은 한국어 승인 응답입니다. 가능한 응답: 보내. 보내줘. 보내 줘. 취소. 아니. 하지 마. 보내지 마.'
    : mode === 'approval_calendar'
      ? '짧은 한국어 승인 응답입니다. 가능한 응답: 추가해. 추가해줘. 추가해 줘. 등록해. 등록해줘. 등록해 줘. 취소. 아니. 하지 마. 추가하지 마. 등록하지 마.'
      : undefined;
  const parameters = {
    audio: audioData, task: 'transcribe', language: 'ko', vad_filter: true, condition_on_previous_text: false,
    ...(mode === 'confirm' ? { initial_prompt: '짧은 한국어 확인 응답입니다. 가능한 응답: ' + REPLIES.join('. ') + '.' }
      : approvalPrompt ? { initial_prompt: approvalPrompt } : {}),
  };
  // Turn/confirm race identical Korean Turbo requests. Action modes stay primary-only.
  return runHedged('stt', deadlineAt, async (call, signal) => {
    // Both real Turbo calls reserve the same conservative audio-minute estimate.
    await reserveInference(context, 'stt', call, Math.ceil(audioData.length * 0.75 / 32000 * 46.63 / 60), deadlineAt, signal);
    const pending = ai.run('@cf/openai/whisper-large-v3-turbo', { ...parameters });
    const result = await trackInference(pending, signal, context);
    const text = z.object({ text: z.string().max(4000) }).parse(result).text;
    // Turns keep their frozen filter; action dictation suppresses only a whole known hallucination phrase.
    if (mode === 'dictation') {
      const phrase = text.trim().replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '').toLocaleLowerCase();
      return new Set(['시청', '구독', '좋아요', '자막', '감사합니다', 'thank you', 'subscribe']).has(phrase) ? '' : text.trim();
    }
    return /시청|구독|좋아요|자막|감사합니다|thank you|subscribe/i.test(text) ? '' : text.trim();
  }, context, mode === 'confirm' ? 1400 : mode === 'turn' ? 1000 : null);
}

export async function synthesize(ai: Ai, value: string, deadlineAt: number, context: HedgeContext = {}, mode: 'general' | 'reply_readback' = 'general'): Promise<{ text: string; audio: OutputAudio }> {
  const sanitized = sanitizeTtsText(mode === 'reply_readback' ? value : value.slice(0, MAX_TTS_TEXT_LENGTH * 4), mode);
  if (mode === 'reply_readback' && sanitized.length > MAX_TTS_TEXT_LENGTH) throw Error('Reply readback too long');
  const text = mode === 'reply_readback' ? sanitized : truncateText(sanitized, MAX_TTS_TEXT_LENGTH);
  if (!text) throw Error('Empty TTS text');
  return runHedged('tts', deadlineAt, async (call, signal) => {
    // The output reader caps decoded WAV at 2MiB (~66s at PCM16/16kHz).
    await reserveInference(context, 'tts', call, 21, deadlineAt, signal);
    const response = await trackInference(ai.run('@cf/myshell-ai/melotts', { prompt: text, lang: 'kr' }, { returnRawResponse: true }), signal, context);
    if (!(response instanceof Response)) throw Error('Expected TTS response');
    if (signal.aborted) { void response.body?.cancel().catch(() => {}); throw Error('Aborted'); }
    const audio = await readAudioResponse(response, signal).catch(() => { throw new VoiceHttpError(502); });
    return { text, audio };
  }, context);
}

export const MAX_TTS_TEXT_LENGTH = 1200;
function truncateText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

export function buildBriefing(calendar: TodayCalendar, remainingSeconds: number | null): { bucket: 'short' | 'summary' | 'full'; text: string } {
  const bucket = remainingSeconds === null ? 'summary' : remainingSeconds < 300 ? 'short' : remainingSeconds < 900 ? 'summary' : 'full';
  const count = calendar.events.length;
  const sentences = [count ? `오늘 일정은 ${count}개예요.` : '오늘 일정은 없어요.'];
  const eventSentence = (event: TodayEvent) => {
    const title = event.title.replace(/[\r\n.!?。？！]/g, ' ');
    const time = 'date' in event.start ? '종일' : new Intl.DateTimeFormat('en-GB', { timeZone: calendar.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(event.start.dateTime)) + '에';
    return `${time} ${title} 일정이 있어요.`;
  };
  if (bucket === 'summary' && count) sentences.push(eventSentence(calendar.events[0]));
  if (bucket === 'full') sentences.push(...calendar.events.map(eventSentence));
  return { bucket, text: truncateText(sentences.join(' '), MAX_TTS_TEXT_LENGTH) };
}

export async function handleConfirm(ai: Ai, audio: InputAudio, deadlineAt: number, context: HedgeContext = {}) {
  const transcript = await transcribe(ai, audio, 'confirm', deadlineAt, context);
  return { transcript, match: matchClosedSet(transcript) };
}
export async function handleTurn(input: { tripId: string; audio: InputAudio }, context: {
  ai: Ai; deadlineAt: number; responseReadyAt: number;
  readCalendar(): Promise<TodayCalendar>; check(): Promise<void>; provider?: LlmProvider;
  defer?(work: Promise<unknown>): void; hedge?: HedgeContext;
  readCached?(calendar: TodayCalendar, answer: CalendarQuestionAnswer, tripId: string): Promise<{ audio: OutputAudio; expiresAt: number } | null>;
  onAnswerValidity?(expiresAt: number): void;
  observeAnswer?(intent: CalendarQuestionAnswer['intent'] | 'abstain', cache: 'hit' | 'miss' | 'unused', degraded: boolean): void;
  proposeCalendar?(transcript: string, requestId: string): Promise<{
    sentences: { text: string; audio: OutputAudio }[];
    actionProposal?: z.infer<typeof actionProposalSchema>;
    actionProposalPending?: { actionId: string; version: number };
  }>;
}) {
  const { ai, deadlineAt } = context;
  const responseReadyAt = Math.min(deadlineAt, context.responseReadyAt);
  const turnId = crypto.randomUUID();
  let transcript = '', authorizationFailed = false;
  const check = async (until = responseReadyAt) => {
    assertBeforeDeadline(until);
    try { await withDeadline(until, () => context.check()); }
    catch (cause) { authorizationFailed = true; throw cause; }
  };
  let calendarWork: Promise<{ ok: true; calendar: TodayCalendar } | { ok: false; error: unknown }> | undefined;
  try {
    assertBeforeDeadline(responseReadyAt);
    if (!hasSpeech(input.audio)) { await check(deadlineAt); return { turnId, transcript: '', sentences: [] }; }
    const calendarRead = Promise.resolve().then(() => context.readCalendar());
    // Keep the entire read (including its final epoch RPC) alive past the ready cutoff.
    context.defer?.(calendarRead.then(() => undefined, () => undefined));
    calendarWork = withDeadline(responseReadyAt, () => calendarRead).then(
      calendar => ({ ok: true as const, calendar }), error => ({ ok: false as const, error }),
    );
    const hedge: HedgeContext = { ...context.hedge, defer: context.hedge?.defer ?? context.defer,
      minimumRemaining: VOICE_STAGE_ADMISSION };
    transcript = await transcribe(ai, input.audio, 'turn', responseReadyAt, hedge);
    await check();
    if (!transcript) return { turnId, transcript, sentences: [] };
    const result = await calendarWork;
    await check();
    if (!result.ok) throw result.error;
    const calendar = result.calendar;
    if (context.proposeCalendar && calendarAddRequest(transcript)) {
      let handoff;
      try { handoff = await context.proposeCalendar(transcript, turnId); }
      catch (cause) {
        if (!(cause instanceof ActionError)) throw cause;
        await check(deadlineAt);
        return { turnId, transcript, sentences: [calendarUnavailableSentence] };
      }
      await check(deadlineAt);
      return { turnId, transcript, ...handoff, sentences: handoff.sentences.slice(0, 1) };
    }
    const routed = routeCalendarQuestion(transcript, calendar, new Date());
    let text: string;
    if (routed) {
      const cached = context.readCached ? await withDeadline(responseReadyAt, () => context.readCached!(calendar, routed, input.tripId)) : null;
      context.observeAnswer?.(routed.intent, cached ? 'hit' : 'miss', false);
      if (cached) {
        if (responseReadyAt - Date.now() < 200) throw new VoiceDeadlineError();
        await check(deadlineAt);
        context.onAnswerValidity?.(Math.min(routed.expiresAt, cached.expiresAt));
        return { turnId, transcript, sentences: [{ text: routed.text, audio: cached.audio }] };
      }
      text = routed.text;
    } else {
      context.observeAnswer?.('abstain', 'unused', false);
      if (responseReadyAt - Date.now() < VOICE_STAGE_ADMISSION.llm) throw new VoiceDeadlineError();
      const answer = await withDeadline(responseReadyAt, () => (context.provider ?? new WorkersAiLlmProvider(ai, hedge)).respond({ transcript, calendar }, responseReadyAt));
      await check();
      text = answer.text;
    }
    if (responseReadyAt - Date.now() < VOICE_STAGE_ADMISSION.tts) throw new VoiceDeadlineError();
    const sentence = await synthesize(ai, text, responseReadyAt, hedge);
    if (routed && Date.now() >= routed.expiresAt) throw new VoiceDeadlineError();
    await check(deadlineAt);
    if (routed) context.onAnswerValidity?.(routed.expiresAt);
    return { turnId, transcript, sentences: [sentence] };
  } catch (cause) {
    if (!transcript || authorizationFailed
      || !(cause instanceof VoiceDeadlineError)) throw cause;
    // Only an elapsed deadline/admission window permits this time-specific failure cue.
    await check(deadlineAt);
    context.observeAnswer?.('abstain', 'unused', true);
    return { turnId, transcript, sentences: [failureSentences.question] };
  } finally {
    input.audio.data = '';
    if (!context.defer) await calendarWork;
  }
}
