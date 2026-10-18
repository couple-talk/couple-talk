// What travels inside a sealed message. Both partners' clients must agree on it, so changes need care (CONTRIBUTING.md).

export type Mode = 'server' | 'local';
// n: per-message nonce (replay detection + delivery receipt), at: sender clock. Both are absent in pre-receipt messages.
export type Payload = { v: 1; from: string; n?: string; at?: number } & (
  | { type: 'chat'; text: string }
  | { type: 'status'; emoji: string; text: string }
  | { type: 'action'; kind: keyof typeof ACTIONS }
  // pack: sha256 of the sealed pack on the relay, or null for the built-in character
  | { type: 'character'; pack: string | null; name: string });

export const STATUSES = [['💻', '일하는 중'], ['🗓️', '회의 중'], ['🍚', '밥 먹는 중'], ['☕', '쉬는 중'], ['🔥', '바빠요'], ['🏃', '퇴근!']];
export const ACTIONS = { poke: ['👉', '콕 찔렀어요'], heart: ['❤️', '하트를 보냈어요'], hug: ['🤗', '안아줬어요'] } as const;

// A decrypted payload still comes from the partner's client; a bad one must not break rendering forever.
export function isValid(p: unknown): p is Payload {
  const o = p as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || typeof o.from !== 'string') return false;
  if ((o.n !== undefined && typeof o.n !== 'string') || (o.at !== undefined && typeof o.at !== 'number')) return false;
  if (o.type === 'chat') return typeof o.text === 'string';
  if (o.type === 'status') return typeof o.emoji === 'string' && typeof o.text === 'string';
  if (o.type === 'character')
    return (o.pack === null || (typeof o.pack === 'string' && /^[\w-]{43}$/.test(o.pack))) && typeof o.name === 'string' && o.name.length <= 20;
  return o.type === 'action' && typeof o.kind === 'string' && Object.hasOwn(ACTIONS, o.kind);
}
