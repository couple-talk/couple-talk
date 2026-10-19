// The unlocked room: connection, history, rendering and sending.
import { deriveRoom, open, randomId, receiptOf, seal, type Bytes, type Room } from './crypto';
import { applyCharacter, wanted } from './characters';
import { connect, type Item } from './net';
import type { Who } from './pack';
import { connected, looking, receiveSignal, rendered, startPresence } from './presence';
import { ACTIONS, isValid, STATUSES, type Mode, type Payload } from './protocol';
import { $, config, isMe, load, save, show } from './state';
import { notify, petEmit, petListen } from './tauri';

// ponytail: localStorage caps around 5MB; move local history to IndexedDB if couples hit it.
const LOCAL_HISTORY_MAX = 5000;

export let room: Room;
export let secretBytes: Bytes;
let lastId = 0;
const statuses: Record<Who, string> = { me: '', partner: '' };
const seen = new Set<number>();
const seenNonces = new Set<string>();
export let net: ReturnType<typeof connect>;

export async function start(secret: Bytes) {
  secretBytes = secret;
  room = await deriveRoom(secret);
  show('chat');
  $('#me').textContent = config!.nick;
  const local = load<Item[]>('ct.history', []);
  startPresence();
  if (config!.mode === 'local') for (const it of local) await render(it, false);

  net = connect(config!.server, { roomId: room.roomId, token: room.token, device: config!.device, mode: config!.mode }, () => lastId, {
    onState: (online, error) => {
      $('#conn').className = online ? 'on' : 'off';
      $('#conn').title = error === 'unauthorized' ? '인증 실패: 코드를 확인하세요' : online ? '연결됨' : '연결 중…';
    },
    onReady: async (mode, items) => {
      for (const it of items) await receive(it, false, mode);
      for (const who of ['me', 'partner'] as const) { const w = wanted[who]; if (w) applyCharacter(who, w.pack, w.id); }
      connected();
    },
    onMsg: (it) => receive(it, true, config!.mode),
    onSignal: receiveSignal,
  });
}

async function receive(it: Item, live: boolean, mode: Mode) {
  if (seen.has(it.id)) return;
  if (mode === 'local') {
    const hist = load<Item[]>('ct.history', []);
    hist.push(it);
    save('ct.history', hist.slice(-LOCAL_HISTORY_MAX));
  }
  const p = await render(it, live);
  if (mode === 'local' && p?.n && !isMe(p.from)) net.ack(it.id, p.n);
}

/** Returns the payload (even for a replayed copy, so it can still be acked) or null if unreadable. */
async function render(it: Item, live: boolean): Promise<Payload | null> {
  if (seen.has(it.id)) return null;
  seen.add(it.id);
  lastId = Math.max(lastId, it.id);
  let p: Payload;
  try { p = await open<Payload>(room.key, it.blob); } catch { return null; }
  if (!isValid(p)) return null;
  // A relay can re-send an old blob under a new id; the sealed nonce exposes that.
  if (p.n) {
    if (seenNonces.has(p.n)) return p;
    seenNonces.add(p.n);
  }
  const mine = isMe(p.from);
  // The partner's pet appears (with this name) once we've heard from them.
  if (!mine && load<string | null>('ct.partner', null) !== p.from) { save('ct.partner', p.from); petEmit({ type: 'reload' }); }
  const time = new Date(p.at ?? it.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const row = document.createElement('div');

  if (p.type === 'chat') {
    row.className = `msg ${mine ? 'mine' : 'theirs'}`;
    row.innerHTML = '<span class="bubble"></span><span class="time"></span>';
    row.querySelector('.bubble')!.textContent = p.text;
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
    if (p.type === 'status') {
      statuses[mine ? 'me' : 'partner'] = p.emoji;
      if (!mine) $('#partner').textContent = `${p.from} ${p.emoji} ${p.text}`;
      petEmit({ type: 'status', emoji: p.emoji, from: mine ? 'me' : 'partner' });
    }
  }
  row.querySelector('.time')!.textContent = time;
  const list = $('#messages');
  list.append(row);
  list.scrollTop = list.scrollHeight;
  // Chat text only travels to this app's own pet windows (a local Tauri event, never the network).
  if (live && p.type === 'action') petEmit({ type: 'action', kind: p.kind, from: mine ? 'me' : 'partner' });
  else if (live && p.type === 'chat') {
    petEmit({ type: 'chat', from: mine ? 'me' : 'partner', ...(config!.hidePetText ? {} : { text: p.text }) });
    // Text goes into the OS notification only when opted in; it can sit on a screen a neighbour sees.
    if (!mine && !looking()) notify(config!.notifyText ? p.text : undefined);
  }
  return p;
}

export async function sendPayload(p: Record<string, unknown>) {
  const n = randomId();
  const ok = net.send(await seal(room.key, { v: 1, from: config!.nick, n, at: Date.now(), ...p }), await receiptOf(n));
  $('#send-error').textContent = ok ? '' : '연결이 끊겨 있어요. 잠시 후 다시 보내 주세요.';
  return ok;
}

$<HTMLFormElement>('#send-form').onsubmit = async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('#text');
  if (!input.value.trim()) return;
  if (await sendPayload({ type: 'chat', text: input.value })) input.value = '';
};

$('#statuses').append(...STATUSES.map(([emoji, text]) => {
  const b = document.createElement('button');
  b.textContent = `${emoji} ${text}`;
  b.onclick = () => sendPayload({ type: 'status', emoji, text });
  return b;
}));
$('#actions').append(...Object.entries(ACTIONS).map(([kind, [emoji, label]]) => {
  const b = document.createElement('button');
  b.textContent = emoji;
  b.title = label;
  b.onclick = () => sendPayload({ type: 'action', kind });
  return b;
}));

petListen(() => {
  for (const from of ['me', 'partner'] as const) if (statuses[from]) petEmit({ type: 'status', emoji: statuses[from], from });
});
