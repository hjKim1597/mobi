import type { HedgeContext, VoiceStage } from './deadline';
import type { CalendarQuestionAnswer } from './calendar-router';

export type RpcSpan = 'digestMs'|'admissionMs'|'authenticationMs'|'quotaMs'|'reservationMs'|'epochMs'|'bodyMs'|'assemblyMs';
export type CalendarTiming = { cache: 'hit' | 'miss' | 'unused'; tokenRefresh: boolean };

// Only fixed route/model labels, durations, byte counts and status leave this object.
export class AiRequestTiming {
  private readonly startedAt = Date.now();
  private readonly stages: Record<VoiceStage, number> = { stt: 0, llm: 0, tts: 0 };
  private readonly active: Partial<Record<VoiceStage, number>> = {};
  private sttModel: '@cf/openai/whisper-large-v3-turbo' | 'none' = 'none';
  private hedgeFired = false;
  private calendarStart?: number;
  private calendarMs = 0;
  private calendar: CalendarTiming = { cache: 'unused', tokenRefresh: false };
  private readonly rpc: Record<RpcSpan, number> = { digestMs:0, admissionMs:0, authenticationMs:0, quotaMs:0, reservationMs:0, epochMs:0, bodyMs:0, assemblyMs:0 };
  recordRpc(span: RpcSpan, ms: number): void { this.rpc[span] += ms; }
  private question: { intent: CalendarQuestionAnswer['intent']|'abstain'|'unused'; cache: 'hit'|'miss'|'unused'; degraded: boolean } = { intent:'unused', cache:'unused', degraded:false };
  readonly observeAnswer = (intent: CalendarQuestionAnswer['intent']|'abstain', cache: 'hit'|'miss'|'unused', degraded: boolean): void => { this.question = { intent, cache, degraded }; };
  uploadBytes = 0;
  constructor(private readonly route: '/v1/turns' | '/v1/confirm' | '/v1/briefings') {}

  readonly observe: NonNullable<HedgeContext['observe']> = (stage, event) => {
    this.active[stage] ??= Date.now();
    if (stage === 'stt') {
      this.hedgeFired = event.hedged;
      this.sttModel = event.winner === 'none' ? 'none' : '@cf/openai/whisper-large-v3-turbo';
    }
  };
  readonly measure: NonNullable<HedgeContext['measure']> = (stage, ms) => {
    this.stages[stage] += ms;
    delete this.active[stage];
  };
  startCalendar(): void { this.calendarStart = Date.now(); this.calendar.cache = 'miss'; }
  finishCalendar(metadata?: CalendarTiming): void {
    if (this.calendarStart !== undefined) this.calendarMs = Date.now() - this.calendarStart;
    this.calendarStart = undefined;
    if (metadata) this.calendar = { cache: metadata.cache, tokenRefresh: metadata.tokenRefresh };
  }
  log(status: number): void {
    const now = Date.now();
    const ms = (stage: VoiceStage) => this.stages[stage] + (this.active[stage] === undefined ? 0 : now - this.active[stage]!);
    console.log(JSON.stringify({ route: this.route, totalMs: now - this.startedAt,
      stt: { ms: ms('stt'), model: this.sttModel, hedgeFired: this.hedgeFired },
      calendar: { ms: this.calendarStart === undefined ? this.calendarMs : now - this.calendarStart, ...this.calendar },
      llm: { ms: ms('llm') }, tts: { ms: ms('tts') }, uploadBytes: this.uploadBytes, rpc: this.rpc, question: this.question, status }));
  }
}

export type ActionTimingStage = 'request' | 'rpc' | 'google_scan' | 'google_list' | 'google_message_gets' | 'google_validation' | 'stt' | 'tts';
type ActionFailure = { name: string; stage: ActionTimingStage };
export interface ActionTimingSnapshot {
  googleListMs: number | null; googleMessageGetsMs: number | null; googleValidationMs: number | null;
  messageCount: number | null; error?: ActionFailure;
}

export function actionRouteLabel(path: string): string | undefined {
  if (['/v1/capabilities', '/v1/mail/scan', '/v1/actions/proposals'].includes(path)) return path;
  const match = /^\/v1\/actions\/[A-Za-z0-9_-]{1,64}(?:\/(approve|cancel|clarify|readback))?$/.exec(path);
  return match ? `/v1/actions/:id${match[1] ? `/${match[1]}` : ''}` : undefined;
}

// Never serialize an exception, arbitrary name/message, route ID or provider data.
function actionErrorName(cause: unknown): string {
  const allowed = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'GoogleError', 'GooglePayloadTooLarge', 'ActionError', 'VoiceDeadlineError', 'VoiceHttpError', 'AudioInputError', 'DOMException'];
  const name = cause instanceof Error ? cause.constructor.name : 'Error';
  return allowed.includes(name) ? name : 'Error';
}

export class ActionRequestTiming {
  private readonly startedAt = Date.now();
  private stage: ActionTimingStage = 'request';
  private failure?: ActionFailure;
  private logged = false;
  private scanPending = false;
  private messageCount = 0;
  private readonly elapsed: Partial<Record<ActionTimingStage, number>> = {};
  private readonly active: Partial<Record<ActionTimingStage, { since: number; count: number }>> = {};
  constructor(private readonly route: string) {}

  setStage(stage: ActionTimingStage): void { this.stage = stage; }
  startScan(): void { this.scanPending = true; this.stage = 'google_scan'; }
  setMessageCount(count: number): void { this.messageCount = count; }
  fail(cause: unknown, stage = this.stage): void { this.failure ??= { name: actionErrorName(cause), stage }; }
  async measure<T>(stage: ActionTimingStage, work: () => Promise<T>): Promise<T> {
    this.stage = stage;
    const span = this.active[stage] ??= { since: Date.now(), count: 0 };
    span.count++;
    try { return await work(); }
    catch (cause) { this.fail(cause, stage); throw cause; }
    finally {
      if (--span.count === 0) {
        this.elapsed[stage] = (this.elapsed[stage] ?? 0) + Date.now() - span.since;
        delete this.active[stage];
      }
    }
  }
  private ms(stage: ActionTimingStage): number {
    return (this.elapsed[stage] ?? 0) + (this.active[stage] ? Date.now() - this.active[stage]!.since : 0);
  }
  snapshot(): ActionTimingSnapshot {
    return {
      googleListMs: this.scanPending ? null : this.ms('google_list'),
      googleMessageGetsMs: this.scanPending ? null : this.ms('google_message_gets'),
      googleValidationMs: this.scanPending ? null : this.ms('google_validation'),
      messageCount: this.scanPending ? null : this.messageCount,
      ...(this.failure ? { error: { ...this.failure } } : {}),
    };
  }
  mergeScan(snapshot: ActionTimingSnapshot): void {
    this.scanPending = false;
    this.elapsed.google_list = snapshot.googleListMs ?? 0;
    this.elapsed.google_message_gets = snapshot.googleMessageGetsMs ?? 0;
    this.elapsed.google_validation = snapshot.googleValidationMs ?? 0;
    this.messageCount = snapshot.messageCount ?? 0;
    this.failure ??= snapshot.error;
    this.stage = 'rpc';
  }
  log(status: number): void {
    if (this.logged) return;
    this.logged = true;
    const { error, ...scan } = this.snapshot();
    console.log(JSON.stringify({ route: this.route, totalMs: Date.now() - this.startedAt, ...scan, sttMs: this.ms('stt'), ttsMs: this.ms('tts'), status,
      ...(status >= 400 ? { error: error ?? { name: 'Error', stage: this.stage } } : {}),
    }));
  }
}
