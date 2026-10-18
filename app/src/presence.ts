// Partner presence and read receipts, carried by sealed signals the relay passes on but never stores.
import { open, seal } from './crypto';
import { net, room } from './chat';
import { isSignal, type Signal } from './protocol';
import { $, config, load, save } from './state';

const BEAT_MS = 10_000;
// A beat or two can go missing on a slow network; past this the partner counts as gone (#3: offline within 30s).
const GONE_MS = 25_000;

// seen: when the partner's last signal arrived. read: newest of my messages they've read. Kept so the marks survive a restart.
let partner = load<{ seen: number; read: number }>('ct.presence', { seen: 0, read: 0 });
let newest = 0; // newest message id rendered, so a partner can't mark messages that don't exist yet as read
let newestTheirs = 0;
let myRead = 0; // what I last reported

const looking = () => document.visibilityState === 'visible' && document.hasFocus();

/** Sends my heartbeat. Does nothing until connected to a relay that relays signals. */
async function beat() {
  if (!net) return;
  const s: Signal = { v: 1, type: 'here', from: config!.nick, read: myRead };
  net.signal(await seal(room.key, s));
}

function markRead() {
  if (!looking() || newestTheirs <= myRead) return;
  myRead = newestTheirs;
  beat();
}

function paint(row: HTMLElement) {
  const read = Number(row.dataset.id) <= partner.read;
  const mark = row.querySelector('.read')!;
  // A partner on an older app never signals, so "1" would sit on every message forever.
  mark.textContent = !partner.seen ? '' : read ? '읽음' : '1';
  mark.classList.toggle('unread', !read);
}

/** Called for every rendered message; `row` only for my own chat bubbles, which get a read mark. */
export function rendered(id: number, mine: boolean, live: boolean, row?: HTMLElement) {
  newest = Math.max(newest, id);
  // History is marked once in connected(), not with a signal per replayed message.
  if (!mine) { newestTheirs = Math.max(newestTheirs, id); if (live) markRead(); }
  if (!row) return;
  row.dataset.id = String(id);
  row.append(Object.assign(document.createElement('span'), { className: 'read' }));
  paint(row);
}

export async function receiveSignal(blob: string) {
  let s: unknown;
  try { s = await open(room.key, blob); } catch { return; }
  if (!isSignal(s) || s.from === config!.nick) return;
  partner = { seen: Date.now(), read: Math.max(partner.read, Math.min(s.read, newest)) };
  save('ct.presence', partner);
  document.querySelectorAll<HTMLElement>('#messages .msg.mine[data-id]').forEach(paint);
  showPresence();
}

function ago(ms: number) {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '방금 전';
  if (min < 60) return `${min}분 전`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}시간 전`;
  return `${Math.floor(min / (24 * 60))}일 전`;
}

function showPresence() {
  const el = $('#presence');
  const gone = Date.now() - partner.seen;
  el.className = gone < GONE_MS ? 'on' : '';
  el.textContent = gone < GONE_MS ? '접속 중' : partner.seen ? `마지막 접속 ${ago(gone)}` : '';
}

/** After each history replay: announce myself right away instead of on the next beat. */
export function connected() {
  if (looking()) myRead = Math.max(myRead, newestTheirs);
  beat();
}

export function startPresence() {
  showPresence();
  setInterval(beat, BEAT_MS);
  setInterval(showPresence, 5_000);
  addEventListener('focus', markRead);
  document.addEventListener('visibilitychange', markRead);
}
