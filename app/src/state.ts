// DOM helpers and the saved config, shared by every screen.
import type { Mode } from './protocol';

// hidePetText: show only 💬 over the pet instead of the message (set from the settings screen, #4).
export type Config = { server: string; wrapped: string; peppered: boolean; nick: string; mode: Mode; device: string; hidePetText?: boolean };

export const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
export const show = (id: string) => document.querySelectorAll<HTMLElement>('.screen').forEach((s) => (s.hidden = s.id !== id));
export const load = <T>(k: string, d: T): T => JSON.parse(localStorage.getItem(k) ?? 'null') ?? d;
export const save = (k: string, v: unknown) => localStorage.setItem(k, JSON.stringify(v));

export let config = load<Config | null>('ct.config', null);
export function setConfig(c: Config) {
  config = c;
  save('ct.config', c);
}
