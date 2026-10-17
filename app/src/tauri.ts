// Thin wrappers so the main window also runs in a plain browser (no pet there).
export const isTauri = '__TAURI_INTERNALS__' in window;

export type PetEvent = { type: 'chat' } | { type: 'status'; emoji: string } | { type: 'action'; kind: string };

export async function petEmit(e: PetEvent) {
  if (!isTauri) return;
  const { emitTo } = await import('@tauri-apps/api/event');
  await emitTo('pet', 'pet', e);
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

export async function quitApp() {
  const { getAllWindows } = await import('@tauri-apps/api/window');
  for (const w of await getAllWindows()) await w.destroy();
}
