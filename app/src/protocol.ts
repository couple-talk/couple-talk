// What travels inside a sealed message. Both partners' clients must agree on it, so changes need care (CONTRIBUTING.md).

export type Mode = 'server' | 'local';
// from: the sender's nickname, for display. p: the sender's person id (#7), shared by all of one person's PCs;
// absent from older apps, whose messages are told apart by nickname only.
// n: per-message nonce (replay detection + delivery receipt), at: sender clock. Both are absent in pre-receipt messages.
export type Payload = { v: 1; from: string; p?: string; n?: string; at?: number } & (
  | { type: 'chat'; text: string }
  // pose: one of the pack's status poses (#12) for a made-up status; absent, the pet picks by emoji.
  | { type: 'status'; emoji: string; text: string; pose?: string }
  | { type: 'action'; kind: keyof typeof ACTIONS }
  // pack: sha256 of the sealed pack on the relay, or null for the built-in character
  | { type: 'character'; pack: string | null; name: string }
  // file: sha256 of the sealed ImageFile on the relay (#10). w/h size the placeholder before the pixels arrive;
  // sticker marks a transparent character-pack image, drawn smaller and without a bubble.
  | { type: 'image'; file: string; w: number; h: number; sticker?: boolean });

const HASH_RE = /^[\w-]{43}$/;
export const PERSON_RE = HASH_RE; // randomId(): 32 bytes base64url
const personOk = (p: unknown) => p === undefined || (typeof p === 'string' && PERSON_RE.test(p));

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

// [emoji, text, pose]: the pose names are the status poses every pack must have (pack.ts REQUIRED_POSES).
export const STATUSES = [
  ['💻', '일하는 중', 'status_work'], ['🗓️', '회의 중', 'status_meeting'], ['🍚', '밥 먹는 중', 'status_eat'],
  ['☕', '쉬는 중', 'status_rest'], ['🔥', '바빠요', 'status_busy'], ['🏃', '퇴근!', 'status_off'],
] as const;
export const STATUS_POSES: readonly string[] = STATUSES.map((s) => s[2]);
// Long enough for any emoji sequence and a short phrase; the header shows both on one line.
export const STATUS_EMOJI_MAX = 16;
export const STATUS_TEXT_MAX = 20;
export const ACTIONS = { poke: ['👉', '콕 찔렀어요'], heart: ['❤️', '하트를 보냈어요'], hug: ['🤗', '안아줬어요'] } as const;

// A decrypted payload still comes from the partner's client; a bad one must not break rendering forever.
export function isValid(p: unknown): p is Payload {
  const o = p as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || typeof o.from !== 'string' || !personOk(o.p)) return false;
  if ((o.n !== undefined && typeof o.n !== 'string') || (o.at !== undefined && typeof o.at !== 'number')) return false;
  if (o.type === 'chat') return typeof o.text === 'string';
  if (o.type === 'status')
    return typeof o.emoji === 'string' && o.emoji.length <= STATUS_EMOJI_MAX && typeof o.text === 'string' && o.text.length <= STATUS_TEXT_MAX
      && (o.pose === undefined || STATUS_POSES.includes(o.pose as string));
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
