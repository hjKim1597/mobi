export class VoiceDeadlineError extends Error {
  constructor() { super('Voice request deadline exceeded'); }
}

export type VoiceStage = 'stt' | 'llm' | 'tts';
export const VOICE_STAGE_ADMISSION = { llm: 2300, tts: 1200 } as const;
export interface HedgeContext {
  minimumRemaining?: Partial<Record<VoiceStage, number>>;
  reserve?(stage: VoiceStage, call: 'primary' | 'hedge', neurons: number): void | Promise<void>;
  observe?(stage: VoiceStage, event: { hedged: boolean; winner: 'primary' | 'hedge' | 'none' }): void;
  measure?(stage: VoiceStage, ms: number): void;
  defer?(work: Promise<unknown>): void;
}
// Task03 p50s: STT 2074ms, LLM 616ms, full turn TTS residual 781ms
// (binding alone was 580ms, which excludes WAV body reading/validation).
export const HEDGE_TIMING = { stt: { after: 2000, p50: 2100 }, llm: { after: 650, p50: 650 }, tts: { after: 600, p50: 800 } };

export async function reserveInference(context: HedgeContext, stage: VoiceStage, call: 'primary' | 'hedge', neurons: number,
  deadlineAt: number, signal: AbortSignal): Promise<void> {
  const minimum = context.minimumRemaining?.[stage] ?? 0;
  if (minimum && deadlineAt - Date.now() < minimum) throw new VoiceDeadlineError();
  await context.reserve?.(stage, call, neurons);
  assertBeforeDeadline(deadlineAt);
  if (minimum && deadlineAt - Date.now() < minimum) throw new VoiceDeadlineError();
  if (signal.aborted || (call === 'hedge' && deadlineAt - Date.now() < HEDGE_TIMING[stage].p50)) throw new VoiceDeadlineError();
}

// AiOptions has no AbortSignal. Keep the binding promise in the host lifetime;
// cancel a late response body and consume every rejection even after a winner.
export function trackInference<T>(value: T | Promise<T>, signal: AbortSignal, context: HedgeContext): Promise<T> {
  const pending = Promise.resolve(value);
  const settled = pending.then(value => {
    if (signal.aborted && value instanceof Response) return value.body?.cancel().catch(() => {});
  }, () => undefined);
  context.defer?.(settled);
  return pending;
}

export async function runHedged<T>(stage: VoiceStage, deadlineAt: number,
  operation: (call: 'primary' | 'hedge', signal: AbortSignal) => Promise<T>, context: HedgeContext = {},
  hedgeAfterMs = HEDGE_TIMING[stage].after): Promise<T> {
  const startedAt = Date.now();
  let hedged = false, winner: 'primary' | 'hedge' | 'none' = 'none';
  const controllers: AbortController[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  context.observe?.(stage, { hedged, winner });
  try {
    return await withDeadline(deadlineAt, signal => new Promise<T>((resolve, reject) => {
      let finished = false, failures = 0, expected = 1;
      let firstNonDeadline: { cause: unknown } | undefined;
      let lastCause: unknown = new VoiceDeadlineError();
      const rejectFailures = () => {
        finished = true;
        reject(firstNonDeadline ? firstNonDeadline.cause : lastCause);
      };
      const timing = HEDGE_TIMING[stage];
      const hedgeMinimum = Math.max(timing.p50, context.minimumRemaining?.[stage] ?? 0);
      const canHedge = deadlineAt - Date.now() >= hedgeAfterMs + hedgeMinimum;
      if (canHedge) expected = 2;
      const start = (call: 'primary' | 'hedge') => {
        const controller = new AbortController(); controllers.push(controller);
        const abort = () => controller.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => {
          assertBeforeDeadline(deadlineAt);
          if (signal.aborted || controller.signal.aborted) throw new VoiceDeadlineError();
          return operation(call, controller.signal);
        }).then(value => {
          if (finished || signal.aborted) return;
          if (Date.now() >= deadlineAt) { finished = true; reject(new VoiceDeadlineError()); return; }
          finished = true; winner = call; resolve(value);
        }, cause => {
          failures++;
          lastCause = cause;
          if (!(cause instanceof VoiceDeadlineError)) firstNonDeadline ??= { cause };
          if (!finished && failures === expected) rejectFailures();
        }).finally(() => signal.removeEventListener('abort', abort));
      };
      start('primary');
      if (canHedge) timer = setTimeout(() => {
        if (finished || signal.aborted) return;
        if (deadlineAt - Date.now() < hedgeMinimum) {
          expected = 1;
          if (failures) rejectFailures();
          return;
        }
        hedged = true; context.observe?.(stage, { hedged, winner }); start('hedge');
      }, hedgeAfterMs);
    }));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    for (const controller of controllers) controller.abort();
    context.observe?.(stage, { hedged, winner });
    context.measure?.(stage, Date.now() - startedAt);
  }
}

export interface Deadline {
  deadlineAt: number;
  signal: AbortSignal;
  remainingMs(): number;
  dispose(): void;
}

export function assertBeforeDeadline(deadlineAt: number): void {
  if (Date.now() >= deadlineAt) throw new VoiceDeadlineError();
}

export function createVoiceDeadline(startedAt: number): Deadline {
  const deadlineAt = startedAt + 4_800;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new VoiceDeadlineError()), Math.max(0, deadlineAt - Date.now()));
  return { deadlineAt, signal: controller.signal, remainingMs: () => Math.max(0, deadlineAt - Date.now()), dispose: () => clearTimeout(timer) };
}

export async function withDeadline<T>(deadlineAt: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  assertBeforeDeadline(deadlineAt);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(new VoiceDeadlineError()); reject(new VoiceDeadlineError()); }, deadlineAt - Date.now());
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout]);
    assertBeforeDeadline(deadlineAt);
    return result;
  } catch (cause) {
    // A nested timeout can reject before this timer fires: propagate cancellation.
    controller.abort(cause);
    throw cause;
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
