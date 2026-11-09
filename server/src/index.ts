import { z } from 'zod';
import { requestSchemas, responseSchemas, additionalResponseSchemas, connectionDeletedSchema, type ErrorCode, type ResponseStatus } from './schemas';
import type { Env } from './state';
import { handlePairing } from './pairing';
import { AudioInputError } from './audio';
import { withDeadline, assertBeforeDeadline, VOICE_STAGE_ADMISSION, VoiceDeadlineError } from './deadline';
import { handleConfirm, handleTurn, buildBriefing, synthesize, VoiceHttpError } from './voice';
import { selectKnock } from './knock';
import type { TodayCalendar } from './calendar';
import { ActionRequestTiming, actionRouteLabel, AiRequestTiming, type RpcSpan } from './timing';
import { routeCalendarQuestion } from './calendar-router';
import { fingerprintCalendar, type BriefingCacheKey } from './briefing-cache';
import { failureSentences } from './failure-audio';
import { actionRequests } from './action-schemas';
import { ActionError, unwrapAction } from './actions';
import { handleActionHttp, speakProposal, type ActionHttpContext } from './action-http';
import { actionHandoffSentence } from './action-handoff-audio';
export { DeviceAgent, Pairing } from './state';

type Route = {
  method: string;
  path: RegExp;
  public?: boolean;
  ai?: boolean;
  body?: z.ZodType;
  registration?: boolean;
  handler?: 'pairing' | 'today' | 'disconnect' | 'briefings' | 'confirm' | 'turns' | 'actions';
};

const routes: Route[] = [
  { method: 'POST', path: /^\/v1\/devices$/, public: true, body: requestSchemas.devices, registration: true },
  { method: 'POST', path: /^\/v1\/pairing$/, body: requestSchemas.pairing, handler: 'pairing' },
  { method: 'GET', path: /^\/v1\/pairing\/([A-Za-z0-9_-]{6,64})$/, handler: 'pairing' },
  { method: 'GET', path: /^\/pair\/([A-Za-z0-9_-]{6,64})$/, public: true, handler: 'pairing' },
  { method: 'GET', path: /^\/oauth\/(google|slack)\/callback$/, public: true, handler: 'pairing' },
  { method: 'DELETE', path: /^\/v1\/connections\/(google|slack)$/, handler: 'disconnect' },
  { method: 'GET', path: /^\/v1\/today$/, handler: 'today' },
  { method: 'POST', path: /^\/v1\/briefings$/, ai: true, body: requestSchemas.briefings, handler: 'briefings' },
  { method: 'POST', path: /^\/v1\/confirm$/, ai: true, body: requestSchemas.confirm, handler: 'confirm' },
  { method: 'POST', path: /^\/v1\/turns$/, ai: true, body: requestSchemas.turns, handler: 'turns' },
  { method: 'GET', path: /^\/v1\/capabilities$/, handler: 'actions' },
  { method: 'POST', path: /^\/v1\/mail\/scan$/, ai: true, body: actionRequests.scan, handler: 'actions' },
  { method: 'POST', path: /^\/v1\/actions\/proposals$/, ai: true, body: actionRequests.propose, handler: 'actions' },
  { method: 'POST', path: /^\/v1\/actions\/[A-Za-z0-9_-]{1,64}\/readback$/, ai: true, body: requestSchemas.cancel, handler: 'actions' },
  { method: 'POST', path: /^\/v1\/actions\/[A-Za-z0-9_-]{1,64}\/clarify$/, ai: true, body: actionRequests.clarify, handler: 'actions' },
  { method: 'POST', path: /^\/v1\/actions\/[A-Za-z0-9_-]{1,64}\/approve$/, body: actionRequests.approve, handler: 'actions' },
  { method: 'POST', path: /^\/v1\/actions\/[A-Za-z0-9_-]{1,64}\/cancel$/, body: requestSchemas.cancel, handler: 'actions' },
  { method: 'GET', path: /^\/v1\/actions\/[A-Za-z0-9_-]{1,64}$/, handler: 'actions' },
];

type JsonStatus = ResponseStatus | keyof typeof additionalResponseSchemas;
function json(status: JsonStatus, body: unknown, extraHeaders?: Record<string, string>): Response {
  const checked = ({ ...responseSchemas, ...additionalResponseSchemas })[status].parse(body);
  return Response.json(checked, {
    status,
    headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...extraHeaders },
  });
}

function error(status: Exclude<JsonStatus, 200 | 201 | 429>, code: ErrorCode, message: string, headers?: Record<string, string>): Response {
  return json(status, { error: { code, message }, fallback: 'cached_knock_or_silence' }, headers);
}

export function limited(code: 'REGISTRATION_LIMIT' | 'DEVICE_DAILY_LIMIT' | 'GLOBAL_DAILY_LIMIT', now: number): Response {
  const retryAfterSeconds = Math.max(1, Math.ceil((86_400_000 - now % 86_400_000) / 1000));
  return json(429, {
    error: { code, message: 'Daily limit reached. Use cached knock audio or stay silent; never speak this error.' },
    fallback: 'cached_knock_or_silence',
    retryAfterSeconds,
  }, { 'Retry-After': String(retryAfterSeconds) });
}

export async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function cap(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid daily cap');
  return Number(value);
}

const maxBodyBytes = 512 * 1024;
async function readBody(request: Request, signal?: AbortSignal, timing?: AiRequestTiming): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new Error('Expected application/json');
  }
  if (Number(request.headers.get('content-length')) > maxBodyBytes) throw new RangeError('Body too large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Expected JSON body');
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes: Uint8Array | undefined;
  try {
    if (signal?.aborted) throw new VoiceDeadlineError();
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Own each emitted chunk before any branch can throw or cancel the reader.
      chunks.push(value);
      if (signal?.aborted) throw new VoiceDeadlineError();
      size += value.byteLength;
      if (timing) timing.uploadBytes = size;
      if (size > maxBodyBytes) {
        await reader.cancel();
        throw new RangeError('Body too large');
      }
    }
    bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } finally {
    bytes?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
  }
}

async function handle(request: Request, env: Env, receivedAt: number, deadlineAt?: number, signal?: AbortSignal, execution?: ExecutionContext, timing?: AiRequestTiming, actionTiming?: ActionRequestTiming): Promise<Response> {
  const step = async <T>(work: () => Promise<T>, span?: RpcSpan): Promise<T> => {
    const startedAt = Date.now();
    try { return await (deadlineAt === undefined ? work() : withDeadline(deadlineAt, async () => work())); }
    finally { if (span) timing?.recordRpc(span, Date.now() - startedAt); }
  };
  const path = new URL(request.url).pathname;
  const matches = routes.filter(route => route.path.test(path));
  if (!matches.length) return error(404, 'NOT_FOUND', 'Route not found.');
  const route = matches.find(route => route.method === request.method);
  if (!route) return error(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.', { Allow: matches.map(item => item.method).join(', ') });

  let device: DurableObjectStub<import('./state').DeviceAgent> | undefined;
  let deviceId: string | undefined;
  let paired = false;
  let epoch: number | undefined;
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  if (!route.public) {
    const token = request.headers.get('authorization')?.match(/^Bearer ([0-9a-f-]{36}\.[0-9a-f]{64})$/)?.[1];
    deviceId = token?.split('.')[0];
    if (!token || !z.uuid().safeParse(deviceId).success) return error(401, 'UNAUTHORIZED', 'Valid device credentials required.');
    const tokenHash = await step(() => digest(token), 'digestMs');
    // ponytail: one global admission object serializes every request; shard by a fixed deviceId prefix (bounded object count) if throughput matters.
    const admission = env.PAIRING.getByName('admission');
    if (!await step(() => admission.knowsDevice(deviceId!, tokenHash), 'admissionMs')) return error(401, 'UNAUTHORIZED', 'Valid device credentials required.');
    // Quotas run before even the authentication RPC on the device object.
    if (route.handler === 'today') {
      const limit = await step(() => admission.admitCalendar(deviceId!, day));
      if (limit) return limited(limit, now);
    }
    device = env.DEVICE_AGENTS.getByName(deviceId!);
    const auth = await step(() => device!.authenticate(tokenHash), 'authenticationMs');
    if (!auth) return error(401, 'UNAUTHORIZED', 'Valid device credentials required.');
    paired = auth.paired;
    epoch = route.ai || route.handler === 'actions' ? auth.epoch : undefined;
    if (route.ai && !paired) return error(403, 'PAIRING_REQUIRED', 'Pair this device before using AI.');
  }

  const checkEpoch = async () => {
    if (deadlineAt !== undefined) assertBeforeDeadline(deadlineAt);
    if (epoch !== undefined && device && (await step(() => device!.getConnectionState(), 'epochMs')).epoch !== epoch) throw new VoiceHttpError(403);
  };
  let body: unknown;
  if (route.body) {
    try {
      const parsed = route.body.safeParse(await step(() => readBody(request, signal, timing), 'bodyMs'));
      if (!parsed.success) throw new Error('Invalid fields');
      body = parsed.data;
    } catch (cause) {
      if (cause instanceof VoiceDeadlineError || signal?.aborted) throw new VoiceDeadlineError();
      if (cause instanceof RangeError) return error(413, 'PAYLOAD_TOO_LARGE', 'JSON body exceeds 512 KiB.');
      return error(400, 'BAD_REQUEST', 'Invalid JSON request body or fields.');
    }
  }

  if (route.registration) {
    // Only Cloudflare's trusted header is used. Local requests without it share
    // one bucket; X-Forwarded-For and client body values never select the bucket.
    const ip = request.headers.get('CF-Connecting-IP') ?? 'local-unknown';
    const admission = env.PAIRING.getByName('admission');
    if (!await admission.admitRegistration(await digest(ip), day)) return limited('REGISTRATION_LIMIT', now);
    const deviceId = crypto.randomUUID();
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
    const deviceToken = `${deviceId}.${secret}`;
    const tokenHash = await digest(deviceToken);
    await env.DEVICE_AGENTS.getByName(deviceId).register(tokenHash);
    await admission.admitDevice(deviceId, tokenHash);
    return json(201, { deviceId, deviceToken });
  }

  if (route.ai && device && paired) {
    const deviceCap = cap(env.DEVICE_DAILY_CAP);
    const globalCap = cap(env.GLOBAL_DAILY_CAP);
    if (!await step(() => device!.consumeDaily(day, deviceCap), 'quotaMs')) return limited('DEVICE_DAILY_LIMIT', now);
    if (!await step(() => env.PAIRING.getByName('quota:global').consumeDaily(day, globalCap), 'quotaMs')) return limited('GLOBAL_DAILY_LIMIT', now);
  }
  if (route.handler === 'pairing') {
    const response = await handlePairing(request, env, deviceId);
    if (response) return response;
  }
  if (route.handler === 'disconnect' && route.path.exec(path)?.[1] === 'google' && device) {
    const revocation = await device.disconnectGoogle();
    return json(200, connectionDeletedSchema.parse({ provider: 'google', connected: false, revocation }));
  }
  if (route.handler === 'today' && device) {
    const result = await step(async () => await device!.today(now, deadlineAt));
    if (result.status === 200) return json(200, { ...result.data, knock: selectKnock(result.data.events.length, result.data.date, result.data.timeZone) });
    if (result.status === 403) return error(403, 'PAIRING_REQUIRED', 'Pair this device before reading the calendar.');
    return error(result.status, 'INTERNAL_ERROR', 'Calendar could not be retrieved.');
  }
  let actionAdmitted = !!route.ai;
  const actionContext = (until: number): ActionHttpContext => ({
    env, device: device!, epoch: epoch!, receivedAt, deadlineAt: until, timing: actionTiming,
    check: () => actionTiming ? actionTiming.measure('rpc', checkEpoch) : checkEpoch(),
    admit: async () => {
      if (actionAdmitted) return;
      actionAdmitted = true;
      if (!paired || !await device!.consumeDaily(day, cap(env.DEVICE_DAILY_CAP)) || !await env.PAIRING.getByName('quota:global').consumeDaily(day, cap(env.GLOBAL_DAILY_CAP))) throw new ActionError(429);
    },
    hedge: {
      defer: execution ? p => execution.waitUntil(p) : undefined,
      reserve: async (_stage, _call, neurons) => {
        if (!paired || !await env.PAIRING.getByName('quota:neurons').reserveNeurons(day, neurons)) throw new VoiceHttpError(502);
      },
    },
  });
  if (route.handler === 'actions' && device) {
    actionTiming?.setStage('rpc');
    try {
      const result = await handleActionHttp(path, body, actionContext(deadlineAt ?? Date.now() + 8500));
      actionTiming?.setStage('rpc');
      await checkEpoch();
      return json(200, result);
    }
    catch (cause) {
      actionTiming?.fail(cause);
      const remoteStatus = cause instanceof Error ? Number(cause.message.match(/ACTION_HTTP_(\d+)/)?.[1]) : 0;
      const status = cause instanceof ActionError ? cause.status : remoteStatus || 502;
      if (status === 429) return limited('DEVICE_DAILY_LIMIT', now);
      if (status === 400 || status === 403 || status === 404 || status === 409 || status === 410) return error(status, status === 404 ? 'NOT_FOUND' : status === 403 ? 'PAIRING_REQUIRED' : 'BAD_REQUEST', 'Action request could not be completed.');
      return error(502, 'INTERNAL_ERROR', 'Action request could not be completed.');
    }
  }
  if (route.ai && device && deadlineAt !== undefined) {
    const responseReadyAt = deadlineAt - 900;
    const cacheKey = async (calendar: TodayCalendar, text: string, tripId: string): Promise<BriefingCacheKey> => ({
      epoch: epoch!, tripId, calendarDate: calendar.date, timeZone: calendar.timeZone,
      calendarFingerprint: await fingerprintCalendar(calendar), canonicalText: text,
      voice: 'kr', modelVersion: '@cf/myshell-ai/melotts:briefing-v1',
    });
    const readCalendar = async (): Promise<TodayCalendar> => {
      timing?.startCalendar();
      const pending = (async () => {
        // Keep the public today RPC/HTTP shapes unchanged.
        const measured = await device!.todayWithTiming(now, deadlineAt);
        timing?.finishCalendar(measured.timing);
        return measured.result;
      })().finally(() => timing?.finishCalendar());
      // Keep the underlying RPC alive even when its caller loses a deadline race.
      execution?.waitUntil(pending.then(() => undefined, () => undefined));
      const result = await step(() => pending);
      await checkEpoch();
      if (result.status !== 200) throw new VoiceHttpError(result.status);
      return result.data;
    };
    try {
      await checkEpoch();
      const hedge = {
        minimumRemaining: VOICE_STAGE_ADMISSION,
        observe: timing?.observe,
        measure: timing?.measure,
        reserve: async (_stage: string, _call: string, neurons: number) => {
          if (!await step(() => env.PAIRING.getByName('quota:neurons').reserveNeurons(day, neurons), 'reservationMs')) throw new VoiceHttpError(502);
        },
        defer: execution ? (work: Promise<unknown>) => execution.waitUntil(work) : undefined,
      };
      let result: unknown;
      let turn: Awaited<ReturnType<typeof handleTurn>> | undefined;
      let answerExpiresAt: number | undefined;
      if (route.handler === 'confirm') {
        const input = body as z.infer<typeof requestSchemas.confirm>;
        result = await handleConfirm(env.AI, input.audio, deadlineAt, hedge);
      } else if (route.handler === 'turns') {
        turn = await handleTurn(body as z.infer<typeof requestSchemas.turns>, {
          ai: env.AI, deadlineAt, responseReadyAt, readCalendar, check: checkEpoch, defer: hedge.defer, hedge,
          observeAnswer: timing?.observeAnswer,
          proposeCalendar: async (text, requestId) => {
            const action = unwrapAction(await device!.actionPropose({ tripId: (body as z.infer<typeof requestSchemas.turns>).tripId, requestId, kind: 'calendar_insert', text }, epoch!, await digest(JSON.stringify({ requestId, text })), responseReadyAt));
            const c = actionContext(responseReadyAt);
            if (action.status === 'awaiting_approval') return {
              actionProposalPending: { actionId: action.actionId, version: action.version },
              sentences: [actionHandoffSentence],
            };
            const actionProposal = await speakProposal(action, c);
            return { actionProposal, sentences: actionProposal.sentences.slice(0, 1) };
          },
          onAnswerValidity: expiresAt => { answerExpiresAt = expiresAt; },
          readCached: async (calendar, answer, tripId) => {
            const key = await cacheKey(calendar, answer.text, tripId);
            const pending = (async () => device!.getBriefingCache({ key, now: Date.now() }))();
            execution?.waitUntil(pending.then(() => undefined, () => undefined));
            const entry = await step(() => pending);
            return entry ? { audio: entry.audio, expiresAt: entry.expiresAt } : null;
          },
        });
        result = turn;
      } else {
        const input = body as z.infer<typeof requestSchemas.briefings>;
        const calendar = await readCalendar(), briefing = buildBriefing(calendar, input.remainingSeconds);
        if (responseReadyAt - Date.now() < VOICE_STAGE_ADMISSION.tts) throw new VoiceDeadlineError();
        const sentence = await synthesize(env.AI, briefing.text, responseReadyAt, hedge);
        if (execution) {
          // Publish only matching complete audio; cache failure never delays the reply.
          const compatible = routeCalendarQuestion('오늘 일정 몇 개야', calendar, new Date());
          if (compatible?.text === sentence.text) execution.waitUntil((async () => {
            const key = await cacheKey(calendar, sentence.text, input.tripId);
            await device!.publishBriefingCache({ key, audio: sentence.audio, now: Date.now(), nextStartAt: compatible.expiresAt });
          })().catch(() => {}));
        }
        result = { briefingId: crypto.randomUUID(), tripId: input.tripId, bucket: briefing.bucket, ...sentence };
      }
      await checkEpoch();
      const assemblyAt = Date.now();
      // No further awaits: facts and reused audio must still be valid at emission.
      if (turn && answerExpiresAt !== undefined && assemblyAt >= answerExpiresAt) {
        result = { ...turn, sentences: [failureSentences.question] };
        timing?.observeAnswer('abstain', 'unused', true);
      }
      const response = json(200, result);
      timing?.recordRpc('assemblyMs', Date.now() - assemblyAt);
      return response;
    } catch (cause) {
      if (cause instanceof AudioInputError) return error(400, 'BAD_REQUEST', 'Invalid WAV audio.');
      if (cause instanceof VoiceHttpError && cause.status === 403) return error(403, 'PAIRING_REQUIRED', 'Pair this device before using AI.');
      if (cause instanceof VoiceHttpError && cause.status === 500) return error(500, 'INTERNAL_ERROR', 'Voice request could not be completed.');
      return error(502, 'INTERNAL_ERROR', 'Voice request could not be completed.');
    }
  }
  return error(501, 'NOT_IMPLEMENTED', 'This endpoint is reserved for a later implementation stage.');
}

export default {
  async fetch(request: Request, env: Env, execution?: ExecutionContext): Promise<Response> {
    const receivedAt = Date.now();
    const path = new URL(request.url).pathname;
    const timing = request.method === 'POST' && (path === '/v1/turns' || path === '/v1/confirm' || path === '/v1/briefings')
      ? new AiRequestTiming(path) : undefined;
    const actionRoute = actionRouteLabel(path);
    const actionTiming = actionRoute ? new ActionRequestTiming(actionRoute) : undefined;
    let response: Response;
    try {
      if (/^\/v1\/(today|briefings|confirm|turns|capabilities)$/.test(path) || path.startsWith('/v1/mail/') || path.startsWith('/v1/actions/')) {
        const deadlineAt = Date.now() + (actionRoute ? 8_500 : path === '/v1/turns' ? 6_000 : 4_800);
        response = await withDeadline(deadlineAt, signal => handle(request, env, receivedAt, deadlineAt, signal, execution, timing, actionTiming));
      } else response = await handle(request, env, receivedAt, undefined, undefined, execution, timing, actionTiming);
    } catch (cause) {
      actionTiming?.fail(cause);
      response = cause instanceof VoiceDeadlineError ? error(502, 'INTERNAL_ERROR', 'Voice request could not be completed.') : error(500, 'INTERNAL_ERROR', 'Request could not be completed.');
    }
    timing?.log(response.status);
    actionTiming?.log(response.status);
    return response;
  },
} satisfies ExportedHandler<Env>;
