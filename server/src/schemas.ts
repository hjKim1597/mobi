import { z } from 'zod';

export const deviceResponseSchema = z.object({
  deviceId: z.uuid(),
  deviceToken: z.string().regex(/^[0-9a-f-]{36}\.[0-9a-f]{64}$/),
}).strict();

export const errorCodes = [
  'BAD_REQUEST', 'UNAUTHORIZED', 'PAIRING_REQUIRED', 'REGISTRATION_LIMIT',
  'DEVICE_DAILY_LIMIT', 'GLOBAL_DAILY_LIMIT', 'NOT_FOUND', 'METHOD_NOT_ALLOWED',
  'NOT_IMPLEMENTED', 'PAYLOAD_TOO_LARGE', 'INTERNAL_ERROR',
] as const;

const errorFields = {
  error: z.object({ code: z.enum(errorCodes), message: z.string().min(1) }).strict(),
  fallback: z.literal('cached_knock_or_silence'),
};
export const errorResponseSchema = z.object(errorFields).strict();
export const rateLimitResponseSchema = z.object({
  ...errorFields,
  error: z.object({
    code: z.enum(['REGISTRATION_LIMIT', 'DEVICE_DAILY_LIMIT', 'GLOBAL_DAILY_LIMIT']),
    message: z.string().min(1),
  }).strict(),
  retryAfterSeconds: z.number().int().positive(),
}).strict();

// All implemented HTTP response bodies are defined here, including failures.
export const responseSchemas = {
  201: deviceResponseSchema,
  400: errorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  404: errorResponseSchema,
  405: errorResponseSchema,
  413: errorResponseSchema,
  429: rateLimitResponseSchema,
  500: errorResponseSchema,
  501: errorResponseSchema,
} as const;
export type ResponseStatus = keyof typeof responseSchemas;
export type ErrorCode = typeof errorCodes[number];

const tripId = z.string().min(1).max(64);
export function isBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}
const audio = z.object({
  // At most eight seconds of PCM16 wrapped in a supported audio container.
  data: z.string().min(4).max(360_000).refine(isBase64, 'Invalid base64'),
  mimeType: z.enum(['audio/wav', 'audio/webm', 'audio/mp4']),
}).strict();
export const requestSchemas = {
  devices: z.object({}).strict(),
  pairing: z.object({}).strict(),
  briefings: z.object({
    tripId,
    remainingSeconds: z.number().int().nonnegative().nullable(),
  }).strict(),
  confirm: z.object({ audio }).strict(),
  turns: z.object({ tripId, audio }).strict(),
  approve: z.object({ contentHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  cancel: z.object({}).strict(),
};

// Additions for A4/A5. The frozen A1/A2 schemas above remain unchanged.
export const pairingCreatedSchema = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  pairingUrl: z.url(),
  expiresAt: z.iso.datetime(),
}).strict();
export const pairingStatusSchema = z.object({
  status: z.enum(['pending', 'processing', 'paired', 'failed']),
  expiresAt: z.iso.datetime(),
}).strict();
export const connectionDeletedSchema = z.object({
  provider: z.literal('google'),
  connected: z.literal(false),
  revocation: z.enum(['revoked', 'failed', 'not_needed']),
}).strict();
const eventDate = z.object({ date: z.iso.date() }).strict();
const eventDateTime = z.object({ dateTime: z.iso.datetime({ offset: true }) }).strict();
const eventFields = { id: z.string().min(1), title: z.string(), location: z.string().optional() };
export const todayResponseSchema = z.object({
  date: z.iso.date(),
  timeZone: z.string().refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
    catch { return false; }
  }),
  events: z.array(z.union([
    z.object({ ...eventFields, start: eventDate, end: eventDate }).strict(),
    z.object({ ...eventFields, start: eventDateTime, end: eventDateTime }).strict(),
  ])),
}).strict();
// Additive voice success contracts; frozen request/base Calendar schemas above are unchanged.
type ValidAudio = { data: string; mimeType: 'audio/wav' };
// Only schema-created immutable objects enter this weak registry. It does not
// retain audio strings or extend a request's lifetime. Revalidating a response
// can then check provenance without rescanning megabytes of unchanged audio.
const validatedAudio = new WeakSet<object>();
const freshOutputAudioSchema = z.object({
  data: z.string().min(4).max(2_796_204).refine(isBase64, 'Invalid base64'),
  mimeType: z.literal('audio/wav'),
}).strict().transform(value => {
  Object.freeze(value);
  validatedAudio.add(value);
  return value;
});
export const outputAudioSchema = z.union([
  z.custom<ValidAudio>(value => typeof value === 'object' && value !== null && validatedAudio.has(value)),
  freshOutputAudioSchema,
]);

export const sentenceSchema = z.object({ text: z.string().min(1), audio: outputAudioSchema }).strict();
export const confirmResponseSchema = z.object({ transcript: z.string(), match: z.object({
  label: z.enum(['응', '네', '됐어', '보내', '취소', '하지 마', '아니', '그래', '들려줘', '나중에', '조용히', '그만', '괜찮아', '보내줘', '바꿔', '바꿔줘', '보내지 마', '바꾸지 마', '말해줘', '안내해줘', 'NONE']),
  action: z.enum(['LISTEN', 'NOT_NOW', 'SEND', 'CHANGE', 'CANCEL']), mode: z.enum(['exact', 'fuzzy-safe', 'none']),
}).strict() }).strict();
export const briefingResponseSchema = z.object({ briefingId: z.uuid(), tripId,
  bucket: z.enum(['short', 'summary', 'full']), text: z.string().min(1), audio: outputAudioSchema }).strict();
export const turnResponseSchema = z.object({ turnId: z.uuid(), transcript: z.string(), sentences: z.array(sentenceSchema).max(1) }).strict();
const knockEntrySchema = sentenceSchema.extend({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export const knockSchema = z.object({ version: z.literal('knock-v1'), date: z.iso.date(),
  timeZone: todayResponseSchema.shape.timeZone, eventCount: z.number().int().nonnegative(),
  online: knockEntrySchema, offline: knockEntrySchema }).strict();
export const todayWithKnockResponseSchema = todayResponseSchema.extend({ knock: knockSchema }).strict();
export const additionalResponseSchemas = {
  200: z.union([pairingCreatedSchema, pairingStatusSchema, connectionDeletedSchema, todayResponseSchema, todayWithKnockResponseSchema, confirmResponseSchema, briefingResponseSchema, turnResponseSchema]),
  410: errorResponseSchema,
  502: errorResponseSchema,
} as const;
