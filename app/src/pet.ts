import { invoke } from '@tauri-apps/api/core';
import { emit, emitTo } from '@tauri-apps/api/event';
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { availableMonitors, currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize, primaryMonitor, Window, type Monitor } from '@tauri-apps/api/window';
import { loadPack, type Who } from './pack';
import { ACTIONS, STATUSES } from './protocol';
import type { PetEvent } from './tauri';

// Packs only supply poses (docs/character-pack.md); every motion and effect lives here.
type Reaction = { pose: string; anim: string; emoji?: string; fx?: 'send' | 'hit' };

const REACT_MS = 4000;
const STATUS_POSES: Record<string, string> = Object.fromEntries(STATUSES.map(([emoji, , pose]) => [emoji, pose]));
// The character whose owner acted plays the plain key; the other one plays `:hit`.
const REACTIONS: Record<string, Reaction> = {
  chat: { pose: 'notify', anim: 'jump', emoji: '💬' },
  heart: { pose: 'heart_send', anim: 'jump', fx: 'send' },
  'heart:hit': { pose: 'heart_hit', anim: 'squish', fx: 'hit' },
  poke: { pose: 'poke_send', anim: 'shake', emoji: '👉' },
  'poke:hit': { pose: 'poke_hit', anim: 'shake', emoji: '❗' },
  hug: { pose: 'hug', anim: 'squish', emoji: '🤗' },
  'hug:hit': { pose: 'hug', anim: 'squish', emoji: '🤗' },
  // Played locally when the two pets walk into each other; nothing is sent.
  meet: { pose: 'hug', anim: 'squish', emoji: '💕' },
};

const pet = document.getElementById('pet')!;
const body = document.getElementById('body') as HTMLImageElement;
const bubble = document.getElementById('bubble')!;
const win = getCurrentWindow();
const who: Who = win.label === 'pet-me' ? 'me' : 'partner';

let { manifest, url, builtin } = await loadPack(who);
const preload = () => { for (const f of Object.values(manifest.poses).flat()) new Image().src = url(f); };
preload();

// Both sides start as the built-in character, so the partner's copy is tinted and each pet wears a name tag.
// The partner's window stays hidden until we know there is a partner (their first message).
const stored = (k: string) => { try { return JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { return null; } };
let shown = true; // windows start visible (tauri.conf.json)
// The tray menu and the hide-all shortcut (#5) can hide both pets; the main process says so.
let allowed = true;
async function showIdentity() {
  const name: string | null = who === 'me' ? stored('ct.config')?.nick ?? null : stored('ct.partner');
  document.getElementById('tag')!.textContent = name ?? (who === 'me' ? '나' : '');
  body.style.filter = who === 'partner' && builtin ? 'hue-rotate(190deg)' : '';
  const want = allowed && (who === 'me' || !!name);
  // show() can take focus on macOS, so only toggle on an actual change.
  if (shown !== want) { shown = want; await (shown ? win.show() : win.hide()); }
}
// Listen first, then ask for the current state, so a change in between isn't missed.
await win.listen<boolean>('pets-visible', async ({ payload }) => { allowed = payload; await showIdentity(); });
allowed = await invoke('pets_visible');
await showIdentity();

let pose = '';
let frame = 0;
const frames = (p: string) => (manifest.poses[p]?.length ? manifest.poses[p] : manifest.poses.idle);
function draw() {
  const f = frames(pose);
  const src = url(f[frame % f.length]);
  if (body.getAttribute('src') !== src) body.src = src;
}
let frameTimer = 0;
const animate = () => {
  clearInterval(frameTimer);
  frameTimer = window.setInterval(() => {
    // idle's second frame is a blink, so flash it now and then instead of cycling.
    frame = pose === 'idle' ? +(Math.random() < 0.06) : frame + 1;
    draw();
  }, 1000 / manifest.fps);
};
animate();

// Walk the window itself along the bottom of the work area, so no click-through handling is needed.
// The window stays small and only grows while a speech bubble or hearts are up, so it rarely blocks clicks.
// SMALL leaves 50px above the 100px character for emoji bubbles; keep it in sync with tauri.conf.json.
const SMALL = { w: 120, h: 150 };
const BIG = { w: 220, h: 220 };
// The work area the pet walks on, in logical pixels. Dropping it on another monitor switches to that monitor's floor.
// Everything here is logical: Tauri turns a physical window position into logical with the *window's* scale factor,
// which can still be the old monitor's right after a drop, and that put pets off screen between 1x and 2x monitors.
type Area = { x: number; y: number; w: number; h: number };
const toArea = ({ workArea: { position: p, size: s }, scaleFactor: f }: Monitor): Area => ({ x: p.x / f, y: p.y / f, w: s.width / f, h: s.height / f });
// Where each pet last stood (#6): its monitor's position and the offset from the work area. Monitors are matched by
// position, not name (two identical monitors share a name) nor work area (it moves with the Dock or taskbar).
// A missing monitor falls back to the primary one.
type Spot = { mx: number; my: number; dx: number };
const SPOT_KEY = `ct.petSpot.${who}`;
const spot: Spot | null = stored(SPOT_KEY);
let monitor = (await availableMonitors()).find((m) => m.position.x === spot?.mx && m.position.y === spot?.my)
  ?? (await primaryMonitor()) ?? (await currentMonitor())!;
const restored = !!spot && monitor.position.x === spot.mx && monitor.position.y === spot.my;
let area = toArea(monitor);
let size = SMALL;
// x is the character's center, so resizing the window around it doesn't move the character.
const half = () => size.w / 2;
const minX = () => area.x + half();
const maxX = () => area.x + area.w - half();
// Start apart: mine left of center, the partner's near the right edge.
let x = restored ? Math.min(Math.max(area.x + spot!.dx, minX()), maxX()) : who === 'me' ? area.x + area.w / 2 - 80 : maxX() - 40;
const saveSpot = () => localStorage.setItem(SPOT_KEY, JSON.stringify({ mx: monitor.position.x, my: monitor.position.y, dx: x - area.x } satisfies Spot));
// Shared by both pets through localStorage, so turning it off on one stops both.
const STILL_KEY = 'ct.petStill';
const still = () => localStorage.getItem(STILL_KEY) === '1';
let dir = -1;
// While dragging, the pointer owns the window position.
let drag: { sx: number; sy: number; cx: number; cy: number; moved: boolean; win: { x: number; y: number } | null } | null = null;
const place = async () => {
  if (drag?.moved) return;
  await win.setPosition(new LogicalPosition(Math.round(x - half()), Math.round(area.y + area.h - size.h)));
};
async function resize(next: typeof SMALL) {
  if (next === size) return;
  size = next;
  // Keep a grown window inside the work area so the bubble isn't cut off at the edge.
  x = Math.min(Math.max(x, minX()), maxX());
  await win.setSize(new LogicalSize(size.w, size.h));
  await place();
}

// The pets can be anywhere on the same floor, so each tells the other where it is and they turn back before touching.
const otherPet = who === 'me' ? 'pet' : 'pet-me';
const floorKey = () => `${area.x},${area.y}`;
type PetPos = { x: number; half: number; floor: string; shown: boolean };
let peer: (PetPos & { at: number }) | null = null;
// win.listen, not listen: a global listener is target Any and also gets every emitTo meant for the other pet.
await win.listen<PetPos>('pet-pos', ({ payload }) => { peer = payload.shown ? { ...payload, at: Date.now() } : null; });
let ticks = 0;
let pauseUntil = 0;
let reactPose = '';
let reactUntil = 0;
let statusPose = '';
let statusUntil = 0;
let metAt = 0;

setInterval(() => {
  if (++ticks % 5 === 0) emitTo(otherPet, 'pet-pos', { x, half: half(), floor: floorKey(), shown } satisfies PetPos).catch(() => {});
  if (ticks % 100 === 0 && !drag) checkFloor();
  if (!shown) return; // hidden partner window: x stays frozen with it, so show() does not jump
  const now = Date.now();
  const walking = now > pauseUntil && now > reactUntil && now > statusUntil && !still();
  // Standing still shows the owner's status pose (#12), so a glance at the pet tells what they're up to.
  const next = now < reactUntil ? reactPose : now < statusUntil ? statusPose : walking ? 'walk' : statusPose || 'idle';
  if (next !== pose) { pose = next; frame = 0; draw(); }
  pet.classList.toggle('walking', walking);
  if (!walking) return;
  if (Math.random() < 0.005) { pauseUntil = now + 2000 + Math.random() * 6000; return; }
  if (Math.random() < 0.003) dir = -dir;
  const p = peer && Date.now() - peer.at < 1000 && peer.floor === floorKey() ? peer : null;
  if (p && Math.abs(p.x - x) < p.half + half() + 20 && Math.sign(p.x - x) === dir) {
    // Now and then they greet each other, still facing, before turning back.
    if (now - metAt > 60_000 && Math.random() < 0.3) { metAt = now; react(REACTIONS.meet); }
    dir = -dir;
    return;
  }
  x += dir * manifest.speed;
  const min = minX(), max = maxX();
  if (x <= min || x >= max) { dir = -dir; x = Math.min(Math.max(x, min), max); }
  pet.classList.toggle('left', dir < 0);
  place();
}, 50);
place();

// Every few seconds: remember where we stand, and walk back onto a real monitor if ours was unplugged.
async function checkFloor() {
  const same = (await availableMonitors()).find((m) => m.position.x === monitor.position.x && m.position.y === monitor.position.y);
  const next = same ?? (await primaryMonitor());
  if (!next) return;
  monitor = next;
  // Also picks up a moved Dock or taskbar on the same monitor.
  area = toArea(next);
  x = Math.min(Math.max(x, minX()), maxX());
  await place(); // a standing-still pet has no walk tick to follow a moved Dock or taskbar
  saveSpot();
}

function heart(cls: string, left: number, top: number, delay: number, dx = 0) {
  const h = document.createElement('span');
  h.className = `heart ${cls}`;
  h.textContent = '❤️';
  h.style.left = `${left}%`;
  h.style.top = `${top}%`;
  h.style.animationDelay = `${delay}ms`;
  h.style.setProperty('--dx', `${dx}px`);
  h.onanimationend = () => h.remove();
  pet.append(h);
}

const SAY_CHARS = 40;
const segmenter = new Intl.Segmenter();
/** Collapses whitespace and cuts at SAY_CHARS graphemes so emoji and Hangul never split. */
function clip(text: string) {
  const g = Array.from(segmenter.segment(text.replace(/\s+/g, ' ').trim()), (s) => s.segment);
  return g.length > SAY_CHARS ? `${g.slice(0, SAY_CHARS).join('')}…` : g.join('');
}

let bubbleTimer = 0;
/** With `say`, the bubble shows that message instead of the reaction emoji, longer for longer text. */
function react(r: Reaction, say?: string) {
  reactPose = r.pose;
  reactUntil = Date.now() + REACT_MS;
  const text = say ? clip(say) : '';
  // Flying hearts need the side room as much as a bubble does.
  const big = !!(text || r.fx);
  resize(big ? BIG : SMALL);
  bubble.textContent = text || r.emoji || '';
  bubble.classList.toggle('on', !!(text || r.emoji));
  bubble.classList.toggle('say', !!text);
  pet.classList.remove('jump', 'shake', 'squish');
  void pet.offsetWidth; // restart the CSS animation
  pet.classList.add(r.anim);
  if (r.fx === 'send') {
    const left = pet.classList.contains('left');
    const hx = (left ? 1 - manifest.hand[0] : manifest.hand[0]) * 100;
    for (let i = 0; i < 3; i++) heart('fly', hx, manifest.hand[1] * 100, 200 + i * 250, (left ? -1 : 1) * (20 + i * 8));
  }
  clearTimeout(bubbleTimer);
  const ms = text ? Math.min(8000, 3000 + 100 * text.length) : REACT_MS;
  bubbleTimer = window.setTimeout(() => {
    bubble.classList.remove('on');
    pet.classList.remove(r.anim);
    // Shrink only after the fade-out so the bubble isn't cut mid-transition.
    if (big) setTimeout(() => !bubble.classList.contains('on') && resize(SMALL), 250);
  }, ms);
}

await win.listen<PetEvent>('pet', async ({ payload: e }) => {
  if (e.type === 'reload') {
    ({ manifest, url, builtin } = await loadPack(who));
    preload();
    animate();
    draw();
    await showIdentity();
    return;
  }
  // Partner messages I haven't looked at (#26): the badge outlives the bubble and clears when the chat gets focus.
  if (e.type === 'unread') {
    document.getElementById('badge')!.textContent = who === 'partner' && e.n ? `💬 ${e.n}` : '';
    return;
  }
  if (e.from !== who && e.type !== 'action') return;
  if (e.type === 'status') {
    document.getElementById('status')!.textContent = e.emoji;
    statusPose = e.pose ?? STATUS_POSES[e.emoji] ?? '';
    statusUntil = Date.now() + REACT_MS;
    return;
  }
  const r = REACTIONS[e.type === 'chat' ? 'chat' : e.kind + (e.from === who ? '' : ':hit')];
  if (!r) return;
  if (r.fx !== 'hit') return react(r, e.type === 'chat' ? e.text : undefined);
  await resize(BIG); // the incoming heart starts left of the character
  heart('incoming', -10, 50, 0);
  setTimeout(() => react(r), 450);
});
await emit('pet-hello');

// Drag the window by hand rather than with startDragging(): the drop point decides which monitor's floor the pet walks
// on next, and a short press must still open the chat. Pointer capture keeps events coming when the cursor outruns
// the window. Positions are logical while dragging: screenX/Y are global points, which on macOS stay continuous across
// monitors with different scale factors. (Tauri's cursorPosition() mixes pixels and points on Retina macOS, so it isn't used.)
const DRAG_PX = 4;
let dragged = false;
let following = false;
pet.onpointerdown = async (e) => {
  // Ctrl-click on macOS is a right-click; its menu swallows the pointerup and would leave the drag stuck.
  if (e.button !== 0 || e.ctrlKey) return;
  pet.setPointerCapture(e.pointerId);
  const d: NonNullable<typeof drag> = { sx: e.screenX, sy: e.screenY, cx: e.screenX, cy: e.screenY, moved: false, win: null };
  drag = d;
  const [w, f] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
  d.win = w.toLogical(f);
};
pet.onpointermove = (e) => {
  if (!drag) return;
  drag.cx = e.screenX;
  drag.cy = e.screenY;
  if (!drag.moved && Math.hypot(drag.cx - drag.sx, drag.cy - drag.sy) < DRAG_PX) return;
  drag.moved = true;
  pet.classList.add('dragging');
  pauseUntil = Infinity;
  if (following || !drag.win) return;
  following = true;
  requestAnimationFrame(async () => {
    const d = drag;
    if (d?.win) await win.setPosition(new LogicalPosition(d.win.x + d.cx - d.sx, d.win.y + d.cy - d.sy));
    following = false;
  });
};
pet.onpointerup = pet.onpointercancel = async () => {
  const d = drag;
  if (!d) return;
  dragged = d.moved; // read by the click that follows this pointerup
  drag = null;
  pet.classList.remove('dragging');
  if (!dragged) return;
  pauseUntil = Date.now() + 1500; // also undoes the Infinity from a flick released before outerPosition() resolved
  if (!d.win) return;
  // Land on the floor of whichever monitor the OS says the window ended up on, and stand there a moment.
  while (following) await new Promise((r) => requestAnimationFrame(r));
  const m = await currentMonitor();
  if (m) { monitor = m; area = toArea(m); }
  x = Math.min(Math.max(d.win.x + d.cx - d.sx + half(), minX()), maxX());
  saveSpot();
  await place();
};

async function openChat() {
  const main = await Window.getByLabel('main');
  await main?.show();
  await main?.unminimize();
  await main?.setFocus();
}
pet.onclick = () => {
  if (dragged) { dragged = false; return; }
  openChat();
};

// Right-click (#6): send an action without opening the chat. The main window holds the connection and sends it.
// A native menu, since the pet window is too small to hold one.
// Built once: each Menu.new holds native resources until closed.
const MENU_LABELS: Record<keyof typeof ACTIONS, string> = { poke: '콕 찌르기', heart: '하트 보내기', hug: '안아주기' };
const stillItem = await CheckMenuItem.new({ text: '한자리에 가만히 있기', checked: still(),
  action: () => localStorage.setItem(STILL_KEY, still() ? '0' : '1') });
const menu = await Menu.new({ items: [
  ...await Promise.all(Object.entries(ACTIONS).map(([kind, [emoji]]) =>
    MenuItem.new({ text: `${emoji} ${MENU_LABELS[kind as keyof typeof ACTIONS]}`, action: () => emitTo('main', 'pet-send', kind) }))),
  await PredefinedMenuItem.new({ item: 'Separator' }),
  await MenuItem.new({ text: '💬 채팅 열기', action: openChat }),
  stillItem,
] });
pet.oncontextmenu = async (e) => {
  e.preventDefault();
  await stillItem.setChecked(still()); // the other pet's menu may have changed it
  await menu.popup();
};
