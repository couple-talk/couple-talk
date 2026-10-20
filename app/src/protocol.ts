// What travels inside a sealed message. Both partners' clients must agree on it, so changes need care (CONTRIBUTING.md).

export type Mode = 'server' | 'local';
// from: the sender's nickname, for display. p: the sender's person id (#7), shared by all of one person's PCs;
// absent from older apps, whose messages are told apart by nickname only.
// n: per-message nonce (replay detection + delivery receipt), at: sender clock. Both are absent in pre-receipt messages.
export type Payload = { v: 1; from: string; p?: string; n?: string; at?: number } & (
  | { type: 'chat'; text: string }
  | { type: 'status'; emoji: string; text: string }
  | { type: 'action'; kind: keyof typeof ACTIONS }
  // pack: sha256 of the sealed pack on the relay, or null for the built-in character
  | { type: 'character'; pack: string | null; name: string }
  // file: sha256 of the sealed ImageFile on the relay (#10). w/h size the placeholder before the pixels arrive;
  // sticker marks a transparent character-pack image, drawn smaller and without a bubble.
  | { type: 'image'; file: string; w: number; h: number; sticker?: boolean });

const HASH_RE = /^[\w-]{43}$/;
export const PERSON_RE = HASH_RE; // randomId(): 32 bytes base64url
const personOk = (p: unknown) => p === undefined || (typeof p === 'string' && PERSON_RE.test(p));

// The partner's code joins as a new person; the code for my own other PC also carries my person id (#7) and
// every nickname I've used, so that PC still counts my messages without an id (pre-#7, older apps) as mine.
// Older apps read only the first three fields, so they can still join with either.
export type PairingCode = { server: string; secret: string; mode: Mode; person?: string; nicks?: string[] };
const NICK_MAX = 20; // the inputs' maxlength

export const formatPairingCode = (c: PairingCode) =>
  [c.server, c.secret, c.mode, ...(c.person ? [c.person, encodeURIComponent(JSON.stringify(c.nicks ?? []))] : [])].join('#');

function parseNicks(field: string) {
  try {
    const a: unknown = JSON.parse(decodeURIComponent(field));
    return Array.isArray(a) && a.length <= 50 && a.every((n) => typeof n === 'string' && n.trim() && n.length <= NICK_MAX) ? (a as string[]) : null;
  } catch { return null; }
}

export function parsePairingCode(code: string): PairingCode | null {
  const [server, secret, mode, person, names, ...rest] = code.trim().split('#');
  // The secret is always 32 random bytes in base64url, like a person id.
  if (rest.length || !server || !secret || !PERSON_RE.test(secret) || (mode !== 'server' && mode !== 'local')) return null;
  if (person !== undefined && !PERSON_RE.test(person)) return null;
  const nicks = names === undefined ? undefined : parseNicks(names);
  if (nicks === null) return null;
  return { server, secret, mode, ...(person ? { person } : {}), ...(nicks ? { nicks } : {}) };
}

/** Whether a message or signal is from me. The person id decides when the sender's app sent one; otherwise
 *  the nickname does, which can't tell two people with the same name apart (an older app on the other side). */
export const sentBy = (m: { from: string; p?: string }, me: { person: string; nicks: string[] }) =>
  m.p !== undefined ? m.p === me.person : me.nicks.includes(m.from);
export const IMAGE_MAX_SIDE = 4096;
// Length of the sealed file blob; must match FILE_MAX in server.js.
export const IMAGE_FILE_MAX = 3 * 1024 * 1024;

/** What a sealed image file holds: only formats every WebView decodes, base64url pixels. */
export type ImageFile = { mime: 'image/jpeg' | 'image/png'; data: string };

export function isImageFile(f: unknown): f is ImageFile {
  const o = f as Record<string, unknown> | null;
  return !!o && typeof o === 'object' && (o.mime === 'image/jpeg' || o.mime === 'image/png')
    && typeof o.data === 'string' && o.data.length <= IMAGE_FILE_MAX;
}

export const STATUSES = [['💻', '일하는 중'], ['🗓️', '회의 중'], ['🍚', '밥 먹는 중'], ['☕', '쉬는 중'], ['🔥', '바빠요'], ['🏃', '퇴근!']];
export const ACTIONS = { poke: ['👉', '콕 찔렀어요'], heart: ['❤️', '하트를 보냈어요'], hug: ['🤗', '안아줬어요'] } as const;

// A decrypted payload still comes from the partner's client; a bad one must not break rendering forever.
export function isValid(p: unknown): p is Payload {
  const o = p as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || typeof o.from !== 'string' || !personOk(o.p)) return false;
  if ((o.n !== undefined && typeof o.n !== 'string') || (o.at !== undefined && typeof o.at !== 'number')) return false;
  if (o.type === 'chat') return typeof o.text === 'string';
  if (o.type === 'status') return typeof o.emoji === 'string' && typeof o.text === 'string';
  if (o.type === 'character')
    return (o.pack === null || (typeof o.pack === 'string' && HASH_RE.test(o.pack))) && typeof o.name === 'string' && o.name.length <= 20;
  if (o.type === 'image') {
    const side = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= IMAGE_MAX_SIDE;
    return typeof o.file === 'string' && HASH_RE.test(o.file) && side(o.w) && side(o.h) && (o.sticker === undefined || typeof o.sticker === 'boolean');
  }
  return o.type === 'action' && typeof o.kind === 'string' && Object.hasOwn(ACTIONS, o.kind);
}

// Sent sealed over the `signal` op (never stored): a heartbeat that also carries how far I've read.
// read: id of the newest partner message I've seen in a focused window. Server ids are the same on both sides.
export type Signal = { v: 1; type: 'here'; from: string; p?: string; read: number };

export function isSignal(p: unknown): p is Signal {
  const o = p as Record<string, unknown> | null;
  return !!o && typeof o === 'object' && o.type === 'here' && typeof o.from === 'string' && personOk(o.p) && Number.isSafeInteger(o.read) && (o.read as number) >= 0;
}
