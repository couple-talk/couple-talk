import { emit, listen } from '@tauri-apps/api/event';
import { currentMonitor, getCurrentWindow, PhysicalPosition, Window } from '@tauri-apps/api/window';
import type { PetEvent } from './tauri';

const CHARACTER = 'default';
const REACTIONS: Record<string, { emoji: string; anim: string }> = {
  chat: { emoji: '💬', anim: 'jump' },
  poke: { emoji: '👉', anim: 'shake' },
  heart: { emoji: '❤️', anim: 'jump' },
  hug: { emoji: '🤗', anim: 'squish' },
};

const pet = document.getElementById('pet')!;
const bubble = document.getElementById('bubble')!;
const win = getCurrentWindow();

const manifest = await (await fetch(`/characters/${CHARACTER}/manifest.json`)).json();
(document.getElementById('body') as HTMLImageElement).src = `/characters/${CHARACTER}/${manifest.image}`;

// Walk the window itself along the bottom of the work area, so no click-through handling is needed.
const monitor = await currentMonitor();
const area = monitor!.workArea;
const scale = monitor!.scaleFactor;
const winW = 120 * scale;
const y = area.position.y + area.size.height - 130 * scale;
let x = area.position.x + area.size.width - winW - 40 * scale;
let dir = -1;
let pauseUntil = 0;
let busyUntil = 0;

setInterval(() => {
  const now = Date.now();
  const walking = now > pauseUntil && now > busyUntil;
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

let bubbleTimer = 0;
function react(key: string) {
  const r = REACTIONS[key];
  if (!r) return;
  busyUntil = Date.now() + 4000;
  bubble.textContent = r.emoji;
  bubble.classList.add('on');
  pet.classList.remove('jump', 'shake', 'squish');
  void pet.offsetWidth; // restart the CSS animation
  pet.classList.add(r.anim);
  clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(() => { bubble.classList.remove('on'); pet.classList.remove(r.anim); }, 4000);
}

await listen<PetEvent>('pet', ({ payload: e }) => {
  if (e.type === 'status') document.getElementById('status')!.textContent = e.emoji;
  else react(e.type === 'chat' ? 'chat' : e.kind);
});
await emit('pet-hello');

pet.onclick = async () => {
  const main = await Window.getByLabel('main');
  await main?.show();
  await main?.unminimize();
  await main?.setFocus();
};
