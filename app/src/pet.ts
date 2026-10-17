import { emit, listen } from '@tauri-apps/api/event';
import { currentMonitor, getCurrentWindow, PhysicalPosition, Window } from '@tauri-apps/api/window';
import type { PetEvent } from './tauri';

// Pack format: docs/character-pack.md. Packs only supply poses; every motion and effect lives here.
type Manifest = { v: 2; name: string; speed: number; fps?: number; hand: [number, number]; poses: Record<string, string[]> };
type Reaction = { pose: string; anim: string; emoji?: string; fx?: 'send' | 'hit' };

const CHARACTER = 'default';
const REACT_MS = 4000;
const STATUS_POSES: Record<string, string> = {
  '💻': 'status_work', '🗓️': 'status_meeting', '🍚': 'status_eat', '☕': 'status_rest', '🔥': 'status_busy', '🏃': 'status_off',
};
// The pet is the partner's character: the partner's actions are its "send" poses, mine land on it.
const REACTIONS: Record<string, Reaction> = {
  chat: { pose: 'notify', anim: 'jump', emoji: '💬' },
  heart: { pose: 'heart_send', anim: 'jump', fx: 'send' },
  'heart:mine': { pose: 'heart_hit', anim: 'squish', fx: 'hit' },
  poke: { pose: 'poke_send', anim: 'shake', emoji: '👉' },
  'poke:mine': { pose: 'poke_hit', anim: 'shake', emoji: '❗' },
  hug: { pose: 'hug', anim: 'squish', emoji: '🤗' },
  'hug:mine': { pose: 'hug', anim: 'squish', emoji: '🤗' },
};

const pet = document.getElementById('pet')!;
const body = document.getElementById('body') as HTMLImageElement;
const bubble = document.getElementById('bubble')!;
const win = getCurrentWindow();

const base = `/characters/${CHARACTER}/`;
const manifest: Manifest = await (await fetch(base + 'manifest.json')).json();
for (const f of Object.values(manifest.poses).flat()) new Image().src = base + f;

let pose = '';
let frame = 0;
const frames = (p: string) => (manifest.poses[p]?.length ? manifest.poses[p] : manifest.poses.idle);
function draw() {
  const f = frames(pose);
  const src = base + f[frame % f.length];
  if (body.getAttribute('src') !== src) body.src = src;
}
setInterval(() => {
  // idle's second frame is a blink, so flash it now and then instead of cycling.
  frame = pose === 'idle' ? +(Math.random() < 0.06) : frame + 1;
  draw();
}, 1000 / (manifest.fps ?? 4));

// Walk the window itself along the bottom of the work area, so no click-through handling is needed.
const monitor = await currentMonitor();
const area = monitor!.workArea;
const scale = monitor!.scaleFactor;
const winW = 120 * scale;
const y = area.position.y + area.size.height - 130 * scale;
let x = area.position.x + area.size.width - winW - 40 * scale;
let dir = -1;
let pauseUntil = 0;
let reactPose = '';
let reactUntil = 0;
let statusPose = '';
let statusUntil = 0;

setInterval(() => {
  const now = Date.now();
  const walking = now > pauseUntil && now > reactUntil && now > statusUntil;
  const next = now < reactUntil ? reactPose : now < statusUntil ? statusPose : walking ? 'walk' : 'idle';
  if (next !== pose) { pose = next; frame = 0; draw(); }
  pet.classList.toggle('walking', walking);
  if (!walking) return;
  if (Math.random() < 0.005) { pauseUntil = now + 2000 + Math.random() * 6000; return; }
  if (Math.random() < 0.003) dir = -dir;
  x += dir * manifest.speed * scale;
  const min = area.position.x, max = area.position.x + area.size.width - winW;
  if (x <= min || x >= max) { dir = -dir; x = Math.min(Math.max(x, min), max); }
  pet.classList.toggle('left', dir < 0);
  win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
}, 50);
win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));

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

let bubbleTimer = 0;
function react(r: Reaction) {
  reactPose = r.pose;
  reactUntil = Date.now() + REACT_MS;
  bubble.textContent = r.emoji ?? '';
  bubble.classList.toggle('on', !!r.emoji);
  pet.classList.remove('jump', 'shake', 'squish');
  void pet.offsetWidth; // restart the CSS animation
  pet.classList.add(r.anim);
  if (r.fx === 'send') {
    const left = pet.classList.contains('left');
    const hx = (left ? 1 - manifest.hand[0] : manifest.hand[0]) * 100;
    for (let i = 0; i < 3; i++) heart('fly', hx, manifest.hand[1] * 100, 200 + i * 250, (left ? -1 : 1) * (20 + i * 8));
  }
  clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(() => { bubble.classList.remove('on'); pet.classList.remove(r.anim); }, REACT_MS);
}

await listen<PetEvent>('pet', ({ payload: e }) => {
  if (e.type === 'status') {
    document.getElementById('status')!.textContent = e.emoji;
    if (STATUS_POSES[e.emoji]) { statusPose = STATUS_POSES[e.emoji]; statusUntil = Date.now() + REACT_MS; }
    return;
  }
  const r = REACTIONS[e.type === 'chat' ? 'chat' : e.kind + (e.mine ? ':mine' : '')];
  if (!r) return;
  if (r.fx !== 'hit') return react(r);
  heart('incoming', -10, 50, 0);
  setTimeout(() => react(r), 450);
});
await emit('pet-hello');

pet.onclick = async () => {
  const main = await Window.getByLabel('main');
  await main?.show();
  await main?.unminimize();
  await main?.setFocus();
};
