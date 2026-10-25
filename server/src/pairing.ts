import { authorizationUrl } from './google';
import { errorResponseSchema, pairingCreatedSchema, pairingStatusSchema } from './schemas';
import type { Env, PairingRecord } from './state';
import { limited } from './index';

const codePattern = /^[A-Za-z0-9_-]{43}$/;
// Google appends RFC 9207 `iss`, and `hd` for Workspace accounts.
const callbackFields = new Set(['state', 'code', 'error', 'error_description', 'error_uri', 'scope', 'authuser', 'prompt', 'iss', 'hd']);
const baseHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
const htmlSecurityHeaders = {
  ...baseHeaders,
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function origin(env: Env): string | null {
  if (!env.PUBLIC_ORIGIN || /[?#]/.test(env.PUBLIC_ORIGIN)) return null;
  try {
    const parsed = new URL(env.PUBLIC_ORIGIN);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function apiJson(status: number, body: unknown): Response {
  const checked = errorResponseSchema.parse(body);
  return Response.json(checked, { status, headers: baseHeaders });
}

function apiError(status: number, code: 'UNAUTHORIZED' | 'NOT_FOUND' | 'INTERNAL_ERROR', message: string): Response {
  return apiJson(status, { error: { code, message }, fallback: 'cached_knock_or_silence' });
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function html(status: number, title: string, message: string, extra = '', cookie?: string): Response {
  const headers = new Headers({ ...htmlSecurityHeaders, 'Content-Type': 'text/html; charset=utf-8' });
  if (cookie) headers.set('Set-Cookie', cookie);
  return new Response(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)}</title><main><h1>${htmlEscape(title)}</h1><p>${htmlEscape(message)}</p>${extra}</main></html>`, { status, headers });
}

function safeErrorPage(status: number, cookie?: string): Response {
  return html(status, '연결을 완료할 수 없습니다', '요청을 처리하지 못했습니다. 기기에서 새 연결 코드를 발급해 주세요.', '', cookie);
}

function cookieValue(request: Request): { value: string | null; present: boolean; duplicate: boolean } {
  const raw = request.headers.get('cookie') ?? '';
  const matches = raw.split(';').map(part => part.trim()).filter(part => part.startsWith('__Host-mobi-oauth='));
  return {
    present: matches.length > 0,
    duplicate: matches.length !== 1,
    value: matches.length === 1 ? matches[0].slice('__Host-mobi-oauth='.length) : null,
  };
}

function clearedCookie(): string {
  return '__Host-mobi-oauth=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax';
}

function embeddedBrowser(userAgent: string): boolean {
  return /;\s*wv\b|\bwebview\b|KAKAOTALK|Line\/|Instagram|FBAN|FBAV|Twitter|Snapchat/i.test(userAgent);
}

function pairObject(env: Env, code: string): DurableObjectStub<import('./state').Pairing> {
  return env.PAIRING.getByName(`pairing:${code}`);
}

async function issuePairing(env: Env, deviceId: string): Promise<Response> {
  const base = origin(env);
  if (!base) return apiError(500, 'INTERNAL_ERROR', 'Request could not be completed.');
  const now = Date.now();
  const admission = env.PAIRING.getByName('admission');
  if (!await admission.admitPairing(deviceId, new Date(now).toISOString().slice(0, 10))) return limited('DEVICE_DAILY_LIMIT', now);
  const device = env.DEVICE_AGENTS.getByName(deviceId);
  const state = await device.getConnectionState();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomToken();
    const now = Date.now();
    const expiresAt = now + 300_000;
    if (!await pairObject(env, code).create(deviceId, state.epoch, now)) continue;
    await admission.rememberPairing(await hash(code), expiresAt);
    const result = pairingCreatedSchema.parse({ code, pairingUrl: `${base}/pair/${code}`, expiresAt: new Date(expiresAt).toISOString() });
    return Response.json(result, { status: 200, headers: baseHeaders });
  }
  return apiError(500, 'INTERNAL_ERROR', 'Request could not be completed.');
}

async function pairingStatus(env: Env, code: string, deviceId: string): Promise<Response> {
  const pair = pairObject(env, code);
  let row = await pair.read() as PairingRecord | null;
  if (!row || row.device_id !== deviceId) return apiError(404, 'NOT_FOUND', 'Pairing code not found.');
  const device = env.DEVICE_AGENTS.getByName(deviceId);
  const connection = await device.getConnectionState();
  if (row.status === 'processing' && connection.attemptId === code) {
    try { await pair.finish('paired'); } catch { /* polling is the repair path after the connection commit */ }
    const result = pairingStatusSchema.parse({ status: 'paired', expiresAt: new Date(row.expires_at).toISOString() });
    return Response.json(result, { status: 200, headers: baseHeaders });
  }
  if ((row.status === 'pending' || row.status === 'processing') && connection.epoch !== row.expected_epoch) {
    return apiError(410, 'NOT_FOUND', 'Pairing code is no longer active.');
  }
  if ((row.status === 'pending' || row.status === 'processing') && Date.now() >= row.expires_at) {
    return apiError(410, 'NOT_FOUND', 'Pairing code has expired.');
  }
  const result = pairingStatusSchema.parse({ status: row.status, expiresAt: new Date(row.expires_at).toISOString() });
  return Response.json(result, { status: 200, headers: baseHeaders });
}

async function pairingPage(request: Request, env: Env, code: string): Promise<Response> {
  if (!codePattern.test(code)) return html(404, '연결 코드를 찾을 수 없습니다', '기기에서 새 연결 코드를 발급해 주세요.');
  const pair = pairObject(env, code);
  const row = await pair.read() as PairingRecord | null;
  if (!row) return html(404, '연결 코드를 찾을 수 없습니다', '기기에서 새 연결 코드를 발급해 주세요.');
  if (Date.now() >= row.expires_at || row.status !== 'pending') return html(410, '연결 코드가 만료되었습니다', '기기에서 새 연결 코드를 발급해 주세요.');
  const device = env.DEVICE_AGENTS.getByName(row.device_id);
  const connection = await device.getConnectionState();
  if (connection.epoch !== row.expected_epoch) return html(410, '연결 코드가 만료되었습니다', '기기에서 새 연결 코드를 발급해 주세요.');
  const ua = request.headers.get('user-agent') ?? '';
  const publicOrigin = origin(env);
  if (!publicOrigin) return safeErrorPage(500);
  const pairingUrl = `${publicOrigin}/pair/${code}`;
  if (embeddedBrowser(ua)) {
    return html(200, '기본 브라우저에서 열어 주세요', `이 앱 안에서는 Google 로그인을 진행할 수 없습니다. Chrome 또는 Safari에서 아래 주소를 열어 주세요. 연결 코드는 ${code}입니다.`, `<p><code>${htmlEscape(pairingUrl)}</code></p>`);
  }
  let state: string;
  let authorization: string;
  try {
    const nonce = randomToken();
    state = `${code}.${nonce}`;
    const browserCookie = randomToken();
    authorization = authorizationUrl(env, state);
    const now = Date.now();
    if (now >= row.expires_at || !await pair.setBrowser(await hash(state), await hash(browserCookie), now)) {
      return html(410, '연결 코드가 만료되었습니다', '기기에서 새 연결 코드를 발급해 주세요.');
    }
    const remainingSeconds = Math.max(0, Math.floor((row.expires_at - now) / 1000));
    const setCookie = `__Host-mobi-oauth=${browserCookie}; Max-Age=${remainingSeconds}; Path=/; Secure; HttpOnly; SameSite=Lax`;
    return html(200, 'Google 계정 연결', '계속하려면 Google 계정에 로그인해 필요한 권한을 승인해 주세요. 기본 브라우저에서 Google 로그인 창을 열어 주세요.', `<p><a href="${htmlEscape(authorization)}" rel="noopener">Google 계정 연결</a></p><p>연결 코드: <code>${code}</code></p>`, setCookie);
  } catch {
    return safeErrorPage(500);
  }
}

async function callback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.search.length > 8192) return safeErrorPage(400, cookieValue(request).present ? clearedCookie() : undefined);
  const cookie = cookieValue(request);
  const clear = cookie.present ? clearedCookie() : undefined;
  const entries = Array.from(url.searchParams.entries());
  const keys = entries.map(([key]) => key);
  if (entries.some(([key]) => !callbackFields.has(key)) || new Set(keys).size !== keys.length) return safeErrorPage(400, clear);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const providerError = url.searchParams.get('error');
  if (!state || state.length > 100 || !cookie.value || cookie.duplicate
    || (url.searchParams.get('error')?.length ?? 0) > 256
    || (url.searchParams.get('error_description')?.length ?? 0) > 1024
    || (url.searchParams.get('error_uri')?.length ?? 0) > 2048
    || (url.searchParams.get('scope')?.length ?? 0) > 1024
    || (url.searchParams.get('authuser')?.length ?? 0) > 64
    || (url.searchParams.get('prompt')?.length ?? 0) > 64
    || (url.searchParams.get('hd')?.length ?? 0) > 255
    || (url.searchParams.has('iss') && url.searchParams.get('iss') !== 'https://accounts.google.com')) return safeErrorPage(400, clear);
  const match = state.match(/^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/);
  if (!match || (code === null) === (providerError === null) || (code !== null && (code.length === 0 || code.length > 4096))) return safeErrorPage(400, clear);
  const pair = pairObject(env, match[1]);
  const result = await pair.claim(await hash(state), await hash(cookie.value), Date.now());
  if (result === 'invalid') return safeErrorPage(400, clear);
  if (result === 'gone') return safeErrorPage(410, clear);
  const row = await pair.read() as PairingRecord | null;
  if (!row) return safeErrorPage(410, clear);
  if (providerError !== null) {
    await pair.finish('failed');
    return html(400, 'Google 연결이 취소되었습니다', '다시 연결하려면 기기에서 새 연결 코드를 발급해 주세요.', '', clear);
  }
  try {
    const device = env.DEVICE_AGENTS.getByName(row.device_id);
    const connected = await device.connectGoogle(row.device_id, code!, row.expected_epoch, match[1], row.expires_at);
    if (connected === 'gone') {
      await pair.finish('failed');
      return safeErrorPage(410, clear);
    }
    if (connected === 'config') {
      await pair.finish('failed');
      return safeErrorPage(500, clear);
    }
    if (connected === 'upstream') {
      await pair.finish('failed');
      return safeErrorPage(502, clear);
    }
    try { await pair.finish('paired'); } catch { /* owner polling reconciles the committed attempt id */ }
    return html(200, 'Google 계정이 연결되었습니다', '이 창을 닫고 기기로 돌아가세요.', '', clear);
  } catch {
    try { await pair.finish('failed'); } catch { /* the callback remains terminal even if its tombstone write fails */ }
    return safeErrorPage(502, clear);
  }
}

/** Handles the Google pairing endpoints after the router has performed auth and body checks. */
export async function handlePairing(request: Request, env: Env, deviceId?: string): Promise<Response | undefined> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  try {
    // Only issued code hashes may select a pairing object, including callbacks
    // and authenticated status polling. Random codes use one fixed registry.
    const code = pathname.match(/^\/(?:v1\/pairing|pair)\/([A-Za-z0-9_-]+)$/)?.[1]
      ?? (pathname === '/oauth/google/callback' ? url.searchParams.get('state')?.split('.')[0] : undefined);
    if (code && codePattern.test(code)) {
      const expiresAt = await env.PAIRING.getByName('admission').pairingExpiry(await hash(code));
      if (expiresAt === null || expiresAt <= Date.now()) {
        const status = expiresAt === null ? 404 : 410;
        return pathname.startsWith('/v1/') ? apiError(status, 'NOT_FOUND', 'Pairing code not found or expired.')
          : safeErrorPage(status, pathname === '/oauth/google/callback' && cookieValue(request).present ? clearedCookie() : undefined);
      }
    } else if (code && pathname.startsWith('/v1/')) {
      return apiError(404, 'NOT_FOUND', 'Pairing code not found.');
    }
    if (request.method === 'POST' && pathname === '/v1/pairing') {
      return deviceId ? await issuePairing(env, deviceId) : apiError(401, 'UNAUTHORIZED', 'Valid device credentials required.');
    }
    const statusMatch = pathname.match(/^\/v1\/pairing\/([A-Za-z0-9_-]{6,64})$/);
    if (request.method === 'GET' && statusMatch) {
      return deviceId ? await pairingStatus(env, statusMatch[1], deviceId) : apiError(401, 'UNAUTHORIZED', 'Valid device credentials required.');
    }
    const pageMatch = pathname.match(/^\/pair\/([A-Za-z0-9_-]{6,64})$/);
    if (request.method === 'GET' && pageMatch) return await pairingPage(request, env, pageMatch[1]);
    if (request.method === 'GET' && pathname === '/oauth/google/callback') return await callback(request, env);
    return undefined;
  } catch {
    if (pathname === '/pair' || pathname.startsWith('/pair/') || pathname === '/oauth/google/callback') return safeErrorPage(500);
    return apiError(500, 'INTERNAL_ERROR', 'Request could not be completed.');
  }
}
