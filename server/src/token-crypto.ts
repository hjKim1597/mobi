import type { TokenPayload } from './google';

export interface TokenEnvelope {
  v: 1;
  iv: string;
  ciphertext: string;
}

function decodeBase64(value: string): Uint8Array | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  try {
    const decoded = Uint8Array.from(atob(value), character => character.charCodeAt(0));
    return btoa(String.fromCharCode(...decoded)) === value ? decoded : null;
  } catch {
    return null;
  }
}

export function validateEncryptionKey(key: string): Uint8Array {
  const decoded = decodeBase64(key);
  if (!decoded || decoded.byteLength !== 32) throw new Error('Invalid token encryption configuration');
  return decoded;
}

function aad(deviceId: string): Uint8Array {
  return new TextEncoder().encode(`mobi:google:${deviceId}:v1`);
}

function encodeBase64(value: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < value.length; index += 0x8000) {
    binary += String.fromCharCode(...value.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

async function importKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', validateEncryptionKey(key), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptTokens(key: string, deviceId: string, payload: TokenPayload): Promise<TokenEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(deviceId), tagLength: 128 }, await importKey(key), plaintext);
  return { v: 1, iv: encodeBase64(iv), ciphertext: encodeBase64(new Uint8Array(ciphertext)) };
}

export async function decryptTokens(key: string, deviceId: string, envelope: TokenEnvelope): Promise<TokenPayload> {
  if (!envelope || envelope.v !== 1 || typeof envelope.iv !== 'string' || typeof envelope.ciphertext !== 'string') {
    throw new Error('Invalid encrypted token data');
  }
  const iv = decodeBase64(envelope.iv);
  const ciphertext = decodeBase64(envelope.ciphertext);
  if (!iv || iv.byteLength !== 12 || !ciphertext || ciphertext.byteLength < 16) throw new Error('Invalid encrypted token data');
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(deviceId), tagLength: 128 }, await importKey(key), ciphertext);
  } catch {
    throw new Error('Unable to decrypt token data');
  }
  try {
    const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plaintext));
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error();
    const value = payload as Record<string, unknown>;
    if (typeof value.accessToken !== 'string' || (typeof value.refreshToken !== 'string' && value.refreshToken !== null)
      || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)
      || !Array.isArray(value.scopes) || value.scopes.some(scope => typeof scope !== 'string')) throw new Error();
    return value as unknown as TokenPayload;
  } catch {
    throw new Error('Invalid encrypted token data');
  }
}
