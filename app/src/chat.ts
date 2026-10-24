// The unlocked room: connection, history, rendering and sending.
import { deriveRoom, legacyPerson, open, randomId, receiptOf, seal, type Bytes, type Room } from './crypto';
import { applyCharacter, wanted } from './characters';
import { itemsBefore, keepItem } from './history';
import { imageElement, keepFile } from './images';
import { connect, type Item } from './net';
import type { Who } from './pack';
import { awayOf, connected, looking, receiveSignal, rendered, startPresence } from './presence';
import { ACTIONS, isValid, type Mode, type Payload } from './protocol';
import { $, config, isMe, load, save, setConfig, show } from './state';
import { notify, onPetSend, petEmit, petListen, type PetEvent } from './tauri';

// Rendered at start and per scroll-up page; matches the relay's HISTORY_LIMIT so both modes page alike.
const PAGE = 500;

export let room: Room;
export let secretBytes: Bytes;
let lastId = 0;
let firstId = Infinity; // the oldest id on screen, where the next scroll-up page ends
const statuses: Partial<Record<Who, PetEvent>> = {}; // the latest status per side, replayed to a pet window that starts later
const seen = new Set<number>();
const seenNonces = new Set<string>();
export let net: ReturnType<typeof connect>;

export async function start(secret: Bytes) {
  secretBytes = secret;
  room = await deriveRoom(secret);
  // The first nickname, not the current one: a rename on one of my PCs doesn't reach the others.
  if (!config!.person) setConfig({ ...config!, person: await legacyPerson(secret, config!.pastNicks?.[0] ?? config!.nick) });
  show('chat');
  $('#me').textContent = config!.nick;
  startPresence();
  if (config!.mode === 'local') for (const it of await itemsBefore(Infinity, PAGE)) await render(it, false);

  net = connect(config!.server, { roomId: room.roomId, token: room.token, device: config!.device, mode: config!.mode }, () => lastId, {
    onState: (online, error) => {
      $('#conn').className = online ? 'on' : 'off';
      $('#conn').title = error === 'unauthorized' ? '인증 실패: 코드를 확인하세요' : online ? '연결됨' : '연결 중…';
    },
    onReady: async (mode, items) => {
      for (const it of items) await receive(it, false, mode);
      for (const who of ['me', 'partner'] as const) { const w = wanted[who]; if (w) applyCharacter(who, w.pack, w.id); }
      connected();
      loadOlder(); // already at the top while offline: no scroll event will come to retry
    },
    onMsg: (it) => receive(it, true, config!.mode),
    onSignal: receiveSignal,
  });
}

async function receive(it: Item, live: boolean, mode: Mode) {
  if (seen.has(it.id)) return;
  if (mode === 'local') await keepItem(it);
  const p = await render(it, live);
  if (mode === 'local' && p?.n && !isMe(p)) net.ack(it.id, p.n);
}

/**
 * Returns the payload (even for a replayed copy, so it can still be acked) or null if unreadable.
 * `older` rows (scrolling up, #8) go above the rest and leave the current name, status and pet alone.
 */
async function render(it: Item, live: boolean, older = false): Promise<Payload | null> {
  if (seen.has(it.id)) return null;
  seen.add(it.id);
  lastId = Math.max(lastId, it.id);
  // Only the first load moves it here (scroll-up pages move it in loadOlder): a local relay resending an old
  // unacked row must not skip a range.
  if (firstId === Infinity) firstId = it.id;
  let p: Payload;
  try { p = await open<Payload>(room.key, it.blob); } catch { return null; }
  if (!isValid(p)) return null;
  // A relay can re-send an old blob under a new id; the sealed nonce exposes that.
  if (p.n) {
    if (seenNonces.has(p.n)) return p;
    seenNonces.add(p.n);
  }
  const mine = isMe(p);
  // The partner's pet appears (with this name) once we've heard from them.
  if (!older && !mine && load<string | null>('ct.partner', null) !== p.from) { save('ct.partner', p.from); petEmit({ type: 'reload' }); }
  const time = new Date(p.at ?? it.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const row = document.createElement('div');

  if (p.type === 'chat' || p.type === 'image') {
    row.className = `msg ${mine ? 'mine' : 'theirs'}`;
    const body = p.type === 'chat' ? Object.assign(document.createElement('span'), { className: 'bubble', textContent: p.text }) : imageElement(p);
    row.append(body, Object.assign(document.createElement('span'), { className: 'time' }));
    // A local-room photo lives on the relay only until this PC has stored it, so take it now even if it isn't shown yet.
    if (p.type === 'image' && !mine && config!.mode === 'local') keepFile(p.file);
    rendered(it.id, mine, live, mine ? row : undefined);
  } else {
    rendered(it.id, mine, live);
    row.className = 'event';
    row.innerHTML = '<span class="text"></span> <span class="time"></span>';
    row.querySelector('.text')!.textContent = p.type === 'status'
      ? `${p.from} · ${p.emoji} ${p.text}`
      : p.type === 'character'
        ? `${p.from}님이 캐릭터를 바꿨어요: ${p.name}`
        : `${p.from}님이 ${ACTIONS[p.kind].join(' ')}`;
    // Replayed history only records the latest choice; it is applied once the replay is done (onReady).
    if (p.type === 'character') {
      const who = mine ? 'me' : 'partner';
      if (live) applyCharacter(who, p.pack, it.id);
      else if ((wanted[who]?.id ?? -1) < it.id) wanted[who] = { id: it.id, pack: p.pack };
    }
    if (p.type === 'status' && !older) {
      const who = mine ? 'me' : 'partner';
      if (!mine) $('#partner').textContent = `${p.from} ${p.emoji} ${p.text}`;
      petEmit((statuses[who] = { type: 'status', emoji: p.emoji, pose: p.pose, from: who }));
    }
  }
  row.querySelector('.time')!.textContent = time;
  const list = $('#messages');
  if (older) { list.prepend(row); return p; }
  list.append(row);
  list.scrollTop = list.scrollHeight;
  // Chat text only travels to this app's own pet windows (a local Tauri event, never the network).
  if (live && p.type === 'action') petEmit({ type: 'action', kind: p.kind, from: mine ? 'me' : 'partner' });
  else if (live && (p.type === 'chat' || p.type === 'image')) {
    // A photo only reaches the pet and the notification as a word; the pixels stay in this window.
    const text = p.type === 'chat' ? p.text : p.sticker ? '🎭 스티커' : '📷 사진';
    petEmit({ type: 'chat', from: mine ? 'me' : 'partner', ...(config!.hidePetText ? {} : { text }) });
    // Text goes into the OS notification only when opted in; it can sit on a screen a neighbour sees.
    if (!mine && !looking()) notify(config!.notifyText ? text : undefined);
  }
  return p;
}

/** While a side is away (#12) their pet shows 💤 and stands as usual; back, it shows their status again. */
export function petAway(who: Who, away: boolean) {
  petEmit(away ? { type: 'status', emoji: '💤', from: who } : statuses[who] ?? { type: 'status', emoji: '', from: who });
}

// Scrolling near the top loads the page before the oldest row, keeping the rows in view where they were.
let paging = false;
let atStart = false;
async function loadOlder() {
  const list = $('#messages');
  if (paging || atStart || list.scrollTop > 80 || firstId === Infinity) return;
  paging = true;
  try {
    const items = config!.mode === 'local' ? await itemsBefore(firstId, PAGE) : await net.older(firstId).catch(() => undefined);
    if (items === undefined) return; // offline or rate limited: the next scroll tries again
    if (!items?.length) { atStart = true; return; }
    const height = list.scrollHeight;
    for (const it of items.reverse()) await render(it, false, true);
    // From the page, not render(): a row already drawn (a resent local one) is skipped there and would stall the cursor.
    firstId = Math.min(firstId, items[items.length - 1].id);
    list.scrollTop += list.scrollHeight - height;
  } finally { paging = false; }
}
$('#messages').addEventListener('scroll', loadOlder);

export async function sendPayload(p: Record<string, unknown>) {
  const n = randomId();
  const ok = net.send(await seal(room.key, { v: 1, from: config!.nick, p: config!.person, n, at: Date.now(), ...p }), await receiptOf(n));
  $('#send-error').textContent = ok ? '' : '연결이 끊겨 있어요. 잠시 후 다시 보내 주세요.';
  return ok;
}

$<HTMLFormElement>('#send-form').onsubmit = async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('#text');
  if (!input.value.trim()) return;
  if (await sendPayload({ type: 'chat', text: input.value })) input.value = '';
};

$('#actions').append(...Object.entries(ACTIONS).map(([kind, [emoji, label]]) => {
  const b = document.createElement('button');
  b.textContent = emoji;
  b.title = label;
  b.onclick = () => sendPayload({ type: 'action', kind });
  return b;
}));

// Locked or offline, nothing goes out: bring the window up so the unlock screen or the send error is what the user sees.
onPetSend(async (kind) => {
  if (!Object.hasOwn(ACTIONS, kind)) return;
  if (net && (await sendPayload({ type: 'action', kind }))) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  await win.show(); await win.unminimize(); await win.setFocus();
});

petListen(() => {
  // The status, or 💤 over it while that side is away: a pet window can (re)start mid-absence.
  for (const who of ['me', 'partner'] as const) petAway(who, awayOf(who));
});
