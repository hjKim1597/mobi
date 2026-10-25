import type { HedgeContext, VoiceStage } from './deadline';
import type { CalendarQuestionAnswer } from './calendar-router';

export type RpcSpan = 'digestMs'|'admissionMs'|'authenticationMs'|'quotaMs'|'reservationMs'|'epochMs'|'bodyMs'|'assemblyMs';
export type CalendarTiming = { cache: 'hit' | 'miss' | 'unused'; tokenRefresh: boolean };

// Only fixed route/model labels, durations, byte counts and status leave this object.
export class AiRequestTiming {
  private readonly startedAt = Date.now();
  private readonly stages: Record<VoiceStage, number> = { stt: 0, llm: 0, tts: 0 };
  private readonly active: Partial<Record<VoiceStage, number>> = {};
  private sttModel: '@cf/openai/whisper-large-v3-turbo' | '@cf/openai/whisper' | 'none' = 'none';
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
      this.sttModel = event.winner === 'primary' ? '@cf/openai/whisper-large-v3-turbo'
        : event.winner === 'hedge' ? '@cf/openai/whisper' : 'none';
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
