import { z } from 'zod';
import { requestSchemas, sentenceSchema } from './schemas';

const audio = z.lazy(() => requestSchemas.turns.shape.audio);
const sentences = z.array(z.lazy(() => sentenceSchema)).max(4);
const id = z.string().min(1).max(64);
export const actionKindSchema = z.enum(['mail_reply', 'calendar_insert']);
export const actionStatusSchema = z.enum(['awaiting_approval', 'needs_clarification', 'holding', 'preparing', 'sending', 'succeeded', 'failed', 'unknown', 'cancelled', 'expired', 'rejected']);
export const capabilitiesSchema = z.object({ calendarRead: z.boolean(), mailRead: z.boolean(), mailReply: z.boolean(), calendarInsert: z.boolean(), reconnectRequired: z.boolean() }).strict();
export const actionRequests = {
  scan: z.object({ tripId: id, quiet: z.boolean().optional() }).strict(),
  propose: z.object({ tripId: id, requestId: z.uuid(), kind: actionKindSchema, candidateId: id.optional(), audio: audio.optional() }).strict()
    .refine(v => v.kind === 'mail_reply' ? !!v.candidateId && !!v.audio : (!!v.candidateId !== !!v.audio)),
  clarify: z.object({ version: z.number().int().positive(), audio }).strict(),
  // Legacy {contentHash} remains grammatical, but cannot authorize an action.
  approve: z.object({ contentHash: z.string().regex(/^[0-9a-f]{64}$/), version: z.number().int().positive().optional(), channel: z.enum(['voice', 'parked_button']).optional(), audio: audio.optional() }).strict(),
};
export const actionProposalSchema = z.object({
  actionId: id, version: z.number().int().positive(), status: z.enum(['awaiting_approval', 'needs_clarification', 'rejected']),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/).optional(), sentences,
  display: z.record(z.string(), z.string()), expiresAt: z.string(), reasonCode: z.string().optional(),
}).strict();
export const mailScanSchema = z.object({ candidate: z.object({
  candidateId: id, sensitive: z.boolean(), canReply: z.boolean(), canAddCalendar: z.boolean(), sentences, replyPromptSentences: sentences,
  calendarOfferSentences: sentences.optional(), display: z.object({ sender: z.string(), subject: z.string().optional(), summary: z.string().optional() }).strict(),
}).strict().nullable() }).strict();
export const approvalResponseSchema = z.union([
  z.object({ actionId: id, status: z.literal('holding'), executeAt: z.number(), serverNow: z.number(), holdAudioMs: z.number().int().nonnegative(), holdSentences: sentences }).strict(),
  z.object({ actionId: id, status: z.literal('not_approved'), reasonCode: z.string(), sentences }).strict(),
]);
export const cancelResponseSchema = z.object({ actionId: id, status: actionStatusSchema, cancelled: z.boolean() }).strict();
export const actionResultSchema = z.object({ actionId: id, kind: actionKindSchema, status: actionStatusSchema, executeAt: z.number().optional(), outcomeCode: z.string().optional(), sentences: sentences.optional() }).strict();
export const actionSuccessSchema = z.union([capabilitiesSchema, mailScanSchema, actionProposalSchema, approvalResponseSchema, cancelResponseSchema, actionResultSchema]);
