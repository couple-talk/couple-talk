// DOM helpers and the saved config, shared by every screen.
import { sentBy, type Mode } from './protocol';

// hidePetText: show only 💬 over the pet instead of the message (set from the settings screen, #4).
// person: who I am in the room (#7), the same on each of my PCs. Configs from before it get one on their first unlock.
// pastNicks: names I used before a rename, so my messages from before person ids (or from an older app) still count as mine.
// notifyText: put the message text in OS notifications; off by default since they may show on a shared screen (#5).
// tapToView: photos stay a placeholder until clicked, for screens others can see (#10).
// offAt: 'HH:MM' at which 🏃 퇴근! is sent once a day while the app runs (#12); absent, never.
export type Config = {
  server: string; wrapped: string; peppered: boolean; nick: string; mode: Mode; device: string; person: string;
  hidePetText?: boolean; pastNicks?: string[]; notifyText?: boolean; tapToView?: boolean; offAt?: string;
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
export const isMe = (m: { from: string; p?: string }) => sentBy(m, { person: config!.person, nicks: [config!.nick, ...(config!.pastNicks ?? [])] });
