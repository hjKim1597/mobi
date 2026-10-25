export type GoogleErrorKind = 'auth' | 'upstream' | 'config';

export class GoogleError extends Error {
  constructor(readonly kind: GoogleErrorKind, message = 'Google request failed') {
    super(message);
    this.name = 'GoogleError';
  }
}

export interface TokenPayload {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scopes: string[];
}

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.calendars.readonly',
] as const;

export const MAX_PROVIDER_RESPONSE_BYTES = 1_048_576;

export class GooglePayloadTooLarge extends GoogleError {
  constructor() { super('upstream', 'Google provider response exceeds byte limit'); this.name = 'GooglePayloadTooLarge'; }
}

async function readJsonBounded(response: Response, signal: AbortSignal, maxBytes = MAX_PROVIDER_RESPONSE_BYTES): Promise<unknown> {
  ensureActive(signal);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new GooglePayloadTooLarge();
  }
  if (!response.body) throw new GoogleError('upstream');
  const reader = response.body.getReader();
  const cancelOnAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancelOnAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      ensureActive(signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new GooglePayloadTooLarge();
      }
      chunks.push(value);
    }
    ensureActive(signal);
  } finally {
    signal.removeEventListener('abort', cancelOnAbort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new GoogleError('upstream'); }
}

export interface GoogleConfig {
  origin: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

type GoogleEnv = {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  PUBLIC_ORIGIN?: string;
};

export function googleConfig(env: GoogleEnv): GoogleConfig {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, PUBLIC_ORIGIN } = env;
  if (!clientId || !clientSecret || !PUBLIC_ORIGIN) throw new GoogleError('config', 'Google OAuth is not configured');
  let origin: URL;
  try {
    origin = new URL(PUBLIC_ORIGIN);
  } catch {
    throw new GoogleError('config', 'Google OAuth is not configured');
  }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new GoogleError('config', 'Google OAuth is not configured');
  }
  return {
    origin: origin.origin,
    clientId,
    clientSecret,
    redirectUri: `${origin.origin}/oauth/google/callback`,
  };
}

export function authorizationUrl(env: GoogleEnv, state: string): string {
  const config = googleConfig(env);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  }).toString();
  return url.toString();
}

export function createDeadline(milliseconds = 6_000): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), milliseconds);
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new GoogleError('upstream');
  return value as Record<string, unknown>;
}

function parseToken(value: unknown, previous?: TokenPayload): TokenPayload {
  const body = asRecord(value);
  const accessToken = body.access_token;
  const expiresIn = body.expires_in;
  const tokenType = body.token_type;
  const rawScopes = body.scope;
  const refreshToken = body.refresh_token ?? previous?.refreshToken;
  const expiresAt = typeof expiresIn === 'number' ? Date.now() + expiresIn * 1000 : NaN;
  if (typeof accessToken !== 'string' || accessToken.length === 0 || tokenType !== 'Bearer'
    || typeof expiresIn !== 'number' || !Number.isSafeInteger(expiresIn) || expiresIn <= 0
    || !Number.isSafeInteger(expiresAt)
    || (typeof rawScopes !== 'string' && !previous) || typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new GoogleError('upstream');
  }
  const scopes = typeof rawScopes === 'string' ? rawScopes.split(/\s+/).filter(Boolean) : previous!.scopes;
  if (GOOGLE_SCOPES.some(scope => !scopes.includes(scope))) throw new GoogleError('upstream');
  return { accessToken, refreshToken, expiresAt, scopes };
}

function ensureActive(signal: AbortSignal): void {
  if (signal.aborted) throw new GoogleError('upstream');
}

async function tokenRequest(env: GoogleEnv, body: URLSearchParams, signal: AbortSignal, previous?: TokenPayload): Promise<TokenPayload> {
  const config = googleConfig(env);
  ensureActive(signal);
  let response: Response;
  try {
    response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...Object.fromEntries(body) }),
      signal,
    });
  } catch {
    throw new GoogleError('upstream');
  }
  let json: unknown;
  try { json = await readJsonBounded(response, signal); } catch { throw new GoogleError('upstream'); }
  ensureActive(signal);
  if (!response.ok) {
    const providerError = typeof json === 'object' && json !== null ? (json as Record<string, unknown>).error : undefined;
    if (providerError === 'invalid_client' || providerError === 'unauthorized_client' || providerError === 'unsupported_grant_type') {
      throw new GoogleError('config');
    }
    throw new GoogleError(providerError === 'invalid_grant' ? 'auth' : 'upstream');
  }
  return parseToken(json, previous);
}

export function exchangeCode(env: GoogleEnv, code: string, signal: AbortSignal): Promise<TokenPayload> {
  const config = googleConfig(env);
  return tokenRequest(env, new URLSearchParams({ code, grant_type: 'authorization_code', redirect_uri: config.redirectUri }), signal);
}

export function refreshTokens(env: GoogleEnv, payload: TokenPayload, signal: AbortSignal): Promise<TokenPayload> {
  if (!payload.refreshToken) throw new GoogleError('auth');
  return tokenRequest(env, new URLSearchParams({ refresh_token: payload.refreshToken, grant_type: 'refresh_token' }), signal, payload);
}

export async function revokeToken(env: GoogleEnv, payload: TokenPayload, signal: AbortSignal): Promise<void> {
  void env;
  const token = payload.refreshToken || payload.accessToken;
  let response: Response;
  try {
    response = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }), signal,
    });
  } catch {
    throw new GoogleError('upstream');
  }
  if (!response.ok) throw new GoogleError('upstream');
}

export async function googleJson(url: URL, accessToken: string, signal: AbortSignal): Promise<unknown> {
  ensureActive(signal);
  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal });
  } catch {
    throw new GoogleError('upstream');
  }
  if (response.status === 401) throw new GoogleError('auth');
  if (!response.ok) throw new GoogleError('upstream');
  try {
    const json = await readJsonBounded(response, signal);
    ensureActive(signal);
    return json;
  } catch (cause) {
    if (cause instanceof GoogleError) throw cause;
    throw new GoogleError('upstream');
  }
}
