// DOM helpers and the saved config, shared by every screen.
import type { Mode } from './protocol';

// hidePetText: show only 💬 over the pet instead of the message (set from the settings screen, #4).
// pastNicks: names I used before a rename, so my old messages still count as mine until #7 keys people by id.
// notifyText: put the message text in OS notifications; off by default since they may show on a shared screen (#5).
export type Config = {
  server: string; wrapped: string; peppered: boolean; nick: string; mode: Mode; device: string;
  hidePetText?: boolean; pastNicks?: string[]; notifyText?: boolean;
};

export const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
export const show = (id: string) => document.querySelectorAll<HTMLElement>('.screen').forEach((s) => (s.hidden = s.id !== id));
export const load = <T>(k: string, d: T): T => JSON.parse(localStorage.getItem(k) ?? 'null') ?? d;
export const save = (k: string, v: unknown) => localStorage.setItem(k, JSON.stringify(v));

export let config = load<Config | null>('ct.config', null);
export function setConfig(c: Config) {
  config = c;
  save('ct.config', c);
}
/** Whether a message's `from` is me: the current nickname or one I renamed away from. */
export const isMe = (from: string) => from === config!.nick || !!config!.pastNicks?.includes(from);
