import type { Who } from './pack';

// Thin wrappers so the main window also runs in a plain browser (no pet there).
export const isTauri = '__TAURI_INTERNALS__' in window;

/**
 * OS-keychain device key, or null in a plain browser. `create` mints one if absent;
 * otherwise a missing key rejects with "missing". Rejects if the keychain is unavailable.
 */
export async function deviceKey(create: boolean): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!isTauri) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  const fresh = create ? Array.from(crypto.getRandomValues(new Uint8Array(32))) : null;
  return new Uint8Array(await invoke<number[]>('device_key', { fresh }));
}

/**
 * `from` says whose character acts; each pet window draws one side. `reload` means a pack changed.
 * `text` is absent when the user hides message text on the pet.
 */
export type PetEvent =
  | { type: 'reload' }
  | { type: 'chat'; from: Who; text?: string }
  | { type: 'status'; emoji: string; pose?: string; from: Who }
  | { type: 'action'; kind: string; from: Who };

export async function petEmit(e: PetEvent) {
  if (!isTauri) return;
  const { emitTo } = await import('@tauri-apps/api/event');
  await Promise.all(['pet', 'pet-me'].map((w) => emitTo(w, 'pet', e)));
}

/** Unread partner messages, shown as a badge on the dock/taskbar and a dot on the tray icon (#5). */
export async function setUnread(n: number) {
  if (!isTauri) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_unread', { n });
}

/** Seconds since the last input on this PC, or null in a plain browser, which can't tell and so is never away. */
export async function idleSecs(): Promise<number | null> {
  if (!isTauri) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<number>('idle_secs').catch(() => null);
}

/** OS notification for a new message. Without `text` it only says that one arrived. */
export async function notify(text?: string) {
  if (!isTauri) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('notify', { body: text ?? null }).catch(() => {});
}

/** Called when the pet window starts and asks for the current partner status. */
export async function petListen(onHello: () => void) {
  if (!isTauri) return;
  const { listen } = await import('@tauri-apps/api/event');
  await listen('pet-hello', onHello);
}

/** Closing the main window only hides it so the connection and pet keep running. */
export async function setupMainWindow() {
  if (!isTauri) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  await win.onCloseRequested((e) => { e.preventDefault(); win.hide(); });
}
