// Partner presence and read receipts, carried by sealed signals the relay passes on but never stores.
import { open, seal } from './crypto';
import { net, petAway, room } from './chat';
import { isSignal, type Signal } from './protocol';
import type { Who } from './pack';
import { $, config, isMe, load, save } from './state';
import { idleSecs, setUnread } from './tauri';

const BEAT_MS = 10_000;
// A beat or two can go missing on a slow network; past this the partner counts as gone (#3: offline within 30s).
const GONE_MS = 25_000;
// Issue #12: five minutes without input shows me as away. Judged by the OS, not this window, which is mostly hidden.
const AWAY_MS = 5 * 60_000;

// seen: when the partner's last signal arrived. read: newest of my messages they've read. Kept so the marks survive a restart.
// away is not saved: a restart must treat the first `away` signal as a change so the pet gets its 💤 again.
let partner: { seen: number; read: number; away?: boolean } = load('ct.presence', { seen: 0, read: 0 });
let myAway = false;
export const awayOf = (who: Who) => (who === 'me' ? myAway : !!partner.away);
let newest = 0; // newest message id rendered, so a partner can't mark messages that don't exist yet as read
let newestTheirs = 0;
let myRead = 0; // what I last reported
let unread = 0; // live partner messages that arrived while I wasn't looking (badge, #5)

export const looking = () => document.visibilityState === 'visible' && document.hasFocus();

/** Sends my heartbeat. Does nothing until connected to a relay that relays signals. */
async function beat() {
  if (!net) return;
  // Judged on every beat, not only on focus events: a WebView restored from the tray may send none,
  // so what I'm looking at counts as read within one beat at the latest.
  if (looking()) myRead = Math.max(myRead, newestTheirs);
  const idle = await idleSecs();
  const away = idle !== null && idle * 1000 >= AWAY_MS;
  if (away !== myAway) petAway('me', (myAway = away));
  const s: Signal = { v: 1, type: 'here', from: config!.nick, p: config!.person, read: myRead, ...(away && { away }) };
  net.signal(await seal(room.key, s));
}

/** Signals right away when something new became read instead of waiting for the next beat, and clears the badge. */
function markRead() {
  if (!looking()) return;
  if (unread) { unread = 0; setUnread(0); }
  if (newestTheirs > myRead) beat();
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
  if (!mine) {
    newestTheirs = Math.max(newestTheirs, id);
    if (live && looking()) markRead();
    else if (live) setUnread(++unread);
  }
  if (!row) return;
  row.dataset.id = String(id);
  row.append(Object.assign(document.createElement('span'), { className: 'read' }));
  paint(row);
}

export async function receiveSignal(blob: string) {
  let s: unknown;
  try { s = await open(room.key, blob); } catch { return; }
  if (!isSignal(s) || isMe(s)) return;
  const before = partner;
  partner = { seen: Date.now(), read: Math.max(partner.read, Math.min(s.read, newest)), away: !!s.away };
  save('ct.presence', { seen: partner.seen, read: partner.read });
  if (partner.away !== !!before.away) petAway('partner', !!s.away);
  // Marks only change when they read further or on their first signal, so don't repaint thousands of rows per beat.
  if (partner.read !== before.read || !before.seen) document.querySelectorAll<HTMLElement>('#messages .msg.mine[data-id]').forEach(paint);
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
  const here = gone < GONE_MS;
  el.className = !here ? '' : partner.away ? 'away' : 'on';
  el.textContent = !here ? (partner.seen ? `마지막 접속 ${ago(gone)}` : '') : partner.away ? '자리 비움' : '접속 중';
}

/** After each history replay: announce myself right away instead of on the next beat. */
export function connected() {
  beat();
}

export function startPresence() {
  showPresence();
  setInterval(beat, BEAT_MS);
  setInterval(showPresence, 5_000);
  addEventListener('focus', markRead);
  document.addEventListener('visibilitychange', markRead);
}
