// All crypto is WebCrypto. The server only ever sees roomId, token and blobs.
const enc = new TextEncoder();
const dec = new TextDecoder();
export type Bytes = Uint8Array<ArrayBuffer>;
const BLOB_PREFIX = '1.';

export const b64 = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64 = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
export const randomId = () => b64(crypto.getRandomValues(new Uint8Array(32)));

const concat = (a: Uint8Array, b: ArrayBuffer) => {
  const out = new Uint8Array(a.length + b.byteLength);
  out.set(a);
  out.set(new Uint8Array(b), a.length);
  return out;
};

/** Must match the relay's sha256(base64url) check in server.js. */
export const receiptOf = async (nonce: string) =>
  b64(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(nonce))));

export type Room = { roomId: string; token: string; key: CryptoKey };

export async function deriveRoom(secret: Bytes): Promise<Room> {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const hkdf = (label: string) => ({
    name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(`couple-talk/v1/${label}`),
  });
  const bits = async (label: string) => b64(new Uint8Array(await crypto.subtle.deriveBits(hkdf(label), base, 256)));
  return {
    roomId: await bits('room-id'),
    token: await bits('auth'),
    key: await crypto.subtle.deriveKey(hkdf('enc'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
  };
}

export async function seal(key: CryptoKey, payload: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload)));
  return BLOB_PREFIX + b64(concat(iv, ct));
}

export async function open<T>(key: CryptoKey, blob: string): Promise<T> {
  if (!blob.startsWith(BLOB_PREFIX)) throw new Error('unknown blob version');
  const raw = unb64(blob.slice(BLOB_PREFIX.length));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
  return JSON.parse(dec.decode(pt));
}

/** `pepper` is the OS-keychain device key; without it the wrap is only as strong as the password. */
async function pinKey(pin: string, salt: Bytes, pepper?: Bytes) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: pepper ? concat(salt, pepper.buffer) : salt, iterations: 600_000 },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

export async function wrapSecret(secret: Bytes, pin: string, pepper?: Bytes): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await pinKey(pin, salt, pepper), secret);
  return b64(concat(concat(salt, iv.buffer), ct));
}

/** Throws on a wrong PIN (AES-GCM auth failure). */
export async function unwrapSecret(wrapped: string, pin: string, pepper?: Bytes): Promise<Bytes> {
  const raw = unb64(wrapped);
  const key = await pinKey(pin, raw.slice(0, 16), pepper);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(16, 28) }, key, raw.slice(28)));
}
