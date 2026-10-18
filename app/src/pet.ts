import { emit, listen } from '@tauri-apps/api/event';
import { currentMonitor, getCurrentWindow, LogicalSize, PhysicalPosition, Window } from '@tauri-apps/api/window';
import { loadPack, type Who } from './pack';
import type { PetEvent } from './tauri';

// Packs only supply poses (docs/character-pack.md); every motion and effect lives here.
type Reaction = { pose: string; anim: string; emoji?: string; fx?: 'send' | 'hit' };

const REACT_MS = 4000;
const STATUS_POSES: Record<string, string> = {
  '💻': 'status_work', '🗓️': 'status_meeting', '🍚': 'status_eat', '☕': 'status_rest', '🔥': 'status_busy', '🏃': 'status_off',
};
// The character whose owner acted plays the plain key; the other one plays `:hit`.
const REACTIONS: Record<string, Reaction> = {
  chat: { pose: 'notify', anim: 'jump', emoji: '💬' },
  heart: { pose: 'heart_send', anim: 'jump', fx: 'send' },
  'heart:hit': { pose: 'heart_hit', anim: 'squish', fx: 'hit' },
  poke: { pose: 'poke_send', anim: 'shake', emoji: '👉' },
  'poke:hit': { pose: 'poke_hit', anim: 'shake', emoji: '❗' },
  hug: { pose: 'hug', anim: 'squish', emoji: '🤗' },
  'hug:hit': { pose: 'hug', anim: 'squish', emoji: '🤗' },
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
async function showIdentity() {
  const name: string | null = who === 'me' ? stored('ct.config')?.nick ?? null : stored('ct.partner');
  document.getElementById('tag')!.textContent = name ?? (who === 'me' ? '나' : '');
  body.style.filter = who === 'partner' && builtin ? 'hue-rotate(190deg)' : '';
  // show() can take focus on macOS, so only toggle on an actual change.
  if (who === 'partner' && shown !== !!name) { shown = !!name; await (shown ? win.show() : win.hide()); }
}
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
const monitor = await currentMonitor();
const area = monitor!.workArea;
const scale = monitor!.scaleFactor;
const bottom = area.position.y + area.size.height;
// The line the pet walks on (window bottom edge). Dragging moves it; it starts on the taskbar edge.
let floor = bottom;
// Highest floor that still leaves room for the grown window, so a bubble is never cut off at the top.
const topFloor = () => area.position.y + BIG.h * scale;
let size = SMALL;
// The two windows can't see each other's position, so each walks its own half and they never overlap.
const mid = area.position.x + area.size.width / 2;
const gap = 20 * scale;
// x is the character's center, so resizing the window around it doesn't move the character.
const half = () => (size.w * scale) / 2;
const minX = () => (who === 'me' ? area.position.x : mid + gap) + half();
const maxX = () => (who === 'me' ? mid - gap : area.position.x + area.size.width) - half();
let x = maxX() - 40 * scale;
let dir = -1;
const place = () => win.setPosition(new PhysicalPosition(Math.round(x - half()), Math.round(floor - size.h * scale)));
async function resize(next: typeof SMALL) {
  if (next === size) return;
  size = next;
  // Keep a grown window inside its half so the bubble isn't cut and the pets don't overlap.
  x = Math.min(Math.max(x, minX()), maxX());
  await win.setSize(new LogicalSize(size.w, size.h));
  await place();
}
let pauseUntil = 0;
let reactPose = '';
let reactUntil = 0;
let statusPose = '';
let statusUntil = 0;

setInterval(() => {
  if (!shown) return; // hidden partner window: x stays frozen with it, so show() does not jump
  const now = Date.now();
  const walking = now > pauseUntil && now > reactUntil && now > statusUntil;
  const next = now < reactUntil ? reactPose : now < statusUntil ? statusPose : walking ? 'walk' : 'idle';
  if (next !== pose) { pose = next; frame = 0; draw(); }
  pet.classList.toggle('walking', walking);
  if (!walking) return;
  if (Math.random() < 0.005) { pauseUntil = now + 2000 + Math.random() * 6000; return; }
  if (Math.random() < 0.003) dir = -dir;
  x += dir * manifest.speed * scale;
  const min = minX(), max = maxX();
  if (x <= min || x >= max) { dir = -dir; x = Math.min(Math.max(x, min), max); }
  pet.classList.toggle('left', dir < 0);
  place();
}, 50);
place();

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

await listen<PetEvent>('pet', async ({ payload: e }) => {
  if (e.type === 'reload') {
    ({ manifest, url, builtin } = await loadPack(who));
    preload();
    animate();
    draw();
    await showIdentity();
    return;
  }
  if (e.from !== who && e.type !== 'action') return;
  if (e.type === 'status') {
    document.getElementById('status')!.textContent = e.emoji;
    if (STATUS_POSES[e.emoji]) { statusPose = STATUS_POSES[e.emoji]; statusUntil = Date.now() + REACT_MS; }
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

// Drag the window by hand rather than with startDragging(): the walk loop needs the drop point as its new x/floor,
// and a short press must still open the chat. Pointer capture keeps events coming when the cursor outruns the window.
const DRAG_PX = 4;
let drag: { sx: number; sy: number; x: number; floor: number; moved: boolean } | null = null;
let dragged = false;
let placing = false;
pet.onpointerdown = (e) => {
  if (e.button !== 0) return;
  pet.setPointerCapture(e.pointerId);
  drag = { sx: e.screenX, sy: e.screenY, x, floor, moved: false };
};
pet.onpointermove = (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.sx, dy = e.screenY - drag.sy;
  if (!drag.moved && Math.hypot(dx, dy) < DRAG_PX) return;
  drag.moved = true;
  pet.classList.add('dragging');
  pauseUntil = Infinity;
  // screenX/Y are logical pixels; the window works in physical ones. Stay in this pet's half (see minX/maxX).
  x = Math.min(Math.max(drag.x + dx * scale, minX()), maxX());
  floor = Math.min(Math.max(drag.floor + dy * scale, topFloor()), bottom);
  if (!placing) { placing = true; requestAnimationFrame(() => { placing = false; place(); }); }
};
pet.onpointerup = pet.onpointercancel = () => {
  if (!drag) return;
  dragged = drag.moved;
  drag = null;
  pet.classList.remove('dragging');
  // Stand still for a moment where it was dropped before walking on from there.
  if (dragged) pauseUntil = Date.now() + 1500;
};

pet.onclick = async () => {
  if (dragged) { dragged = false; return; }
  const main = await Window.getByLabel('main');
  await main?.show();
  await main?.unminimize();
  await main?.setFocus();
};
