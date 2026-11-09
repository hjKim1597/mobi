import type { z } from 'zod';
import { actionRequests, type actionProposalSchema } from './action-schemas';
import { ActionError, isActionApproval, terminalSpeech, unwrapAction, type StoredProposal } from './actions';
import type { DeviceAgent, Env } from './state';
import { synthesize, transcribe, type InputAudio, type TranscriptionMode } from './voice';
import type { HedgeContext } from './deadline';
import { assertBeforeDeadline } from './deadline';
import { inspectBase64Wav } from './audio';
import type { ActionRequestTiming } from './timing';
import { calendarReadbackParts, legacyCalendarReadback } from './calendar-actions';
import { sanitizeTtsText } from './tts';
import { actionWordingSentences } from './action-wording-audio';
import { actionHoldSentence } from './action-hold-audio';

type Sentence = Awaited<ReturnType<typeof synthesize>>;
const fixedAudio = new Map<string, Sentence>(actionWordingSentences.map(({ text, audio }) => [text, { text, audio }]));
const bundledHoldAudioMs = holdAudioDurationMs(actionHoldSentence);
type SpeechPart = { text: string; fixed: boolean };
const fixedProposalSpeech = new Set([
  '한 문장으로 짧게 다시 말씀해 주세요.', '어느 날짜로 일정을 잡을까요?',
  '시작과 종료 시각을 숫자로 말씀해 주세요.', '몇 월 며칠 일정인가요?', '오전인가요, 오후인가요?', '몇 시까지 일정인가요?',
  '시간이 분명하지 않아 추가하지 않았어요.', '제목을 정확히 읽을 수 없어 추가하지 않았어요.',
]);
export interface ActionHttpContext {
  env: Env; device: DurableObjectStub<DeviceAgent>; epoch: number; receivedAt: number; deadlineAt: number; hedge: HedgeContext;
  timing?: ActionRequestTiming;
  check(): Promise<void>;
  admit(): Promise<void>;
}
export async function actionSentence(text: string, c: ActionHttpContext, fixed = false, mode: 'general' | 'reply_readback' = 'general'): Promise<Sentence> {
  const work = async () => {
    assertBeforeDeadline(c.deadlineAt);
    if (fixed && fixedAudio.has(text)) return fixedAudio.get(text)!;
    if (text.length > 900) throw new ActionError(400); // never silently truncate an approval readback
    const sentence = await synthesize(c.env.AI, text, c.deadlineAt, c.hedge, mode);
    await c.check();
    if (fixed) { if (fixedAudio.size >= 32) fixedAudio.delete(fixedAudio.keys().next().value!); fixedAudio.set(text, sentence); }
    return sentence;
  };
  return c.timing ? c.timing.measure('tts', work) : work();
}
export function holdAudioDurationMs(sentence: Sentence): number {
  const wav = inspectBase64Wav(sentence.audio.data);
  return Math.ceil(wav.size / (wav.channels * 2 * wav.sampleRate) * 1000);
}
function actionSentences(parts: readonly SpeechPart[], c: ActionHttpContext, mode: 'general' | 'reply_readback' = 'general'): Promise<Sentence[]> {
  return Promise.all(parts.map(part => actionSentence(part.text, c, part.fixed, mode)));
}
export async function speakProposal(proposal: StoredProposal, c: ActionHttpContext): Promise<z.infer<typeof actionProposalSchema>> {
  const { speechText, calendarSpeechParts, ...wire } = proposal;
  if (proposal.status !== 'awaiting_approval') {
    return { ...wire, sentences: await actionSentences([{ text: speechText, fixed: fixedProposalSpeech.has(speechText) }], c) };
  }
  if (speechText.length > 900) throw new ActionError(400);
  sanitizeTtsText(speechText, 'reply_readback');
  const isReply = Object.hasOwn(proposal.display, 'body');
  let parts: SpeechPart[] = isReply ? [
    { text: `${proposal.display.sender} 님에게`, fixed: false },
    { text: `'${proposal.display.body}'라고 회신할게요.`, fixed: false },
    { text: "보내려면 '보내'라고 말씀해 주세요.", fixed: true },
  ] : calendarSpeechParts ?? calendarReadbackParts({
    title: proposal.display.title, start: proposal.display.start, end: proposal.display.end,
    timeZone: proposal.display.timeZone, defaultDuration: proposal.display.duration === '30분',
  });
  // Reconstruct the validated snapshot exactly, without splitting dictated punctuation.
  if (parts.map(part => part.text).join(' ') !== speechText) {
    if (isReply || calendarSpeechParts) throw new ActionError(502);
    // Old pending calendar rows may have been saved before canonical parts existed.
    // Accept only the exact formatter output that was persisted before canonical parts existed.
    const legacy = legacyCalendarReadback({
      title: proposal.display.title, start: proposal.display.start, end: proposal.display.end,
      timeZone: proposal.display.timeZone, defaultDuration: proposal.display.duration === '30분',
    });
    if (legacy !== speechText) throw new ActionError(502);
    parts = [{ text: speechText, fixed: false }];
  }
  return { ...wire, sentences: await actionSentences(parts, c, 'reply_readback') };
}
async function transcript(audio: InputAudio | undefined, c: ActionHttpContext, mode: TranscriptionMode = 'turn') {
  if (!audio) return '';
  await c.admit();
  const work = () => transcribe(c.env.AI, audio, mode, c.deadlineAt, c.hedge);
  const text = await (c.timing ? c.timing.measure('stt', work) : work());
  await c.check();
  return text;
}
async function inputFingerprint(value: unknown) {
  const data = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(data), b => b.toString(16).padStart(2, '0')).join('');
}
function actionRpc<T>(c: ActionHttpContext, work: () => T): Promise<Awaited<T>> {
  const request = async (): Promise<Awaited<T>> => await work();
  return c.timing ? c.timing.measure('rpc', request) : request();
}
export async function handleActionHttp(path: string, body: unknown, c: ActionHttpContext): Promise<unknown> {
  if (path === '/v1/capabilities') return actionRpc(c, () => c.device.actionCapabilities());
  if (path === '/v1/mail/scan') {
    const v = body as z.infer<typeof actionRequests.scan>;
    c.timing?.startScan();
    const measured = await c.device.actionScanMeasured(v.tripId, c.epoch, c.deadlineAt);
    c.timing?.mergeScan(measured.timing);
    const mail = unwrapAction(measured.result);
    await c.check();
    if (!mail) return { candidate: null };
    if (mail.sensitive) return { candidate: {
      candidateId: mail.candidateId, sensitive: true, canReply: false, canAddCalendar: false,
      sentences: [await actionSentence('민감한 내용으로 보여 정차 후 확인해 주세요.', c, true)], replyPromptSentences: [], display: { sender: '' },
    } };
    if (v.quiet) return { candidate: {
      candidateId: mail.candidateId, sensitive: false, canReply: false, canAddCalendar: false,
      sentences: [await actionSentence('확인이 필요한 메일이 있어요. 정차 후 확인해 주세요.', c, true)],
      replyPromptSentences: [],
      display: { sender: mail.sender, subject: mail.subject, summary: mail.summary },
    } };
    const canReply = mail.canReply && (await actionRpc(c, () => c.device.actionCapabilities())).mailReply;
    const canAddCalendar = mail.canAddCalendar && (await actionRpc(c, () => c.device.actionCapabilities())).calendarInsert;
    const variableOffer = { text: `${mail.sender} 님이 ${mail.summary}.`, fixed: false };
    const offer: SpeechPart[] = canReply ? [
      { text: '회신이 필요해 보이는 메일이 있어요.', fixed: true }, variableOffer,
      { text: '회신 내용을 작성할까요?', fixed: true },
    ] : [variableOffer, ...(canAddCalendar ? [{ text: '일정 내용을 확인할까요?', fixed: true }] : [])];
    const [sentences, replyPrompt, calendarOffer] = await Promise.all([
      actionSentences(offer, c),
      canReply ? actionSentence('답장 내용을 짧게 말씀해 주세요.', c, true) : undefined,
      canAddCalendar ? actionSentence('일정 내용을 확인할까요?', c, true) : undefined,
    ]);
    return { candidate: {
      candidateId: mail.candidateId, sensitive: false, canReply, canAddCalendar,
      sentences,
      replyPromptSentences: replyPrompt ? [replyPrompt] : [],
      ...(calendarOffer ? { calendarOfferSentences: [calendarOffer] } : {}),
      display: { sender: mail.sender, subject: mail.subject, summary: mail.summary },
    } };
  }
  if (path === '/v1/actions/proposals') {
    const v = body as z.infer<typeof actionRequests.propose>, fingerprint = await inputFingerprint(v);
    const cached = unwrapAction(await actionRpc(c, () => c.device.actionExisting(v.requestId, fingerprint)));
    if (cached) return speakProposal(cached, c);
    const text = await transcript(v.audio, c, 'dictation');
    const proposal = unwrapAction(await actionRpc(c, () => c.device.actionPropose({ tripId: v.tripId, requestId: v.requestId, kind: v.kind, candidateId: v.candidateId, text }, c.epoch, fingerprint, c.deadlineAt)));
    await c.check();
    return speakProposal(proposal, c);
  }
  const match = path.match(/^\/v1\/actions\/([A-Za-z0-9_-]{1,64})(?:\/(approve|cancel|clarify|readback))?$/);
  if (!match) throw new ActionError(404);
  const [, id, operation] = match;
  if (operation === 'readback') {
    const proposal = unwrapAction(await actionRpc(c, () => c.device.actionReadback(id, c.epoch)));
    await c.check();
    return speakProposal(proposal, c);
  }
  const status = unwrapAction(await actionRpc(c, () => c.device.actionStatus(id)));
  if (operation === 'cancel') return unwrapAction(await actionRpc(c, () => c.device.actionCancel(id)));
  if (operation === 'clarify') {
    const v = body as z.infer<typeof actionRequests.clarify>;
    const text = await transcript(v.audio, c, 'dictation');
    const proposal = unwrapAction(await actionRpc(c, () => c.device.actionClarify(id, v.version, text, c.epoch)));
    await c.check();
    return speakProposal(proposal, c);
  }
  if (operation === 'approve') {
    const v = body as z.infer<typeof actionRequests.approve>;
    const mode = status.kind === 'mail_reply' ? 'approval_mail' : 'approval_calendar';
    if (status.status === 'holding' && v.version !== undefined && v.channel !== undefined) {
      const sentence = actionHoldSentence, holdAudioMs = bundledHoldAudioMs;
      await c.check();
      const result = unwrapAction(await actionRpc(c, () => c.device.actionApprove(id, v, c.epoch, holdAudioMs)));
      return { ...result, serverNow: c.receivedAt, holdAudioMs: result.holdAudioMs ?? holdAudioMs, holdSentences: [sentence] };
    }
    if (v.version === undefined || v.channel === undefined || (v.channel === 'voice' && (!v.audio || !isActionApproval(status.kind, await transcript(v.audio, c, mode))))) {
      if (v.channel === 'voice') {
        await c.check();
        unwrapAction(await actionRpc(c, () => c.device.actionNotApproved(id, c.epoch, v.version, v.contentHash)));
      }
      return { actionId: id, status: 'not_approved', reasonCode: 'explicit_approval_required', sentences: [await actionSentence(terminalSpeech(status.kind, 'cancelled')!, c, true)] };
    }
    // Bundled, validated audio needs no inference; retain the final guard before approval CAS.
    const sentence = actionHoldSentence, holdAudioMs = bundledHoldAudioMs;
    await c.check();
    const result = unwrapAction(await actionRpc(c, () => c.device.actionApprove(id, v, c.epoch, holdAudioMs)));
    return { ...result, serverNow: c.receivedAt, holdAudioMs: result.holdAudioMs ?? holdAudioMs, holdSentences: [sentence] };
  }
  const text = terminalSpeech(status.kind, status.status);
  if (!text) return status;
  // Status truth remains available when synthesis/quota is unavailable.
  try { return { ...status, sentences: [await actionSentence(text, c, true)] }; }
  catch { return { ...status, sentences: [] }; }
}
