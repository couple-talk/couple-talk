import './style.css';
import { b64, deriveRoom, open, randomId, receiptOf, seal, unb64, unwrapSecret, wrapSecret, type Bytes, type Room } from './crypto';
import { connect, type Item } from './net';
import { isTauri, petEmit, petListen, setupMainWindow, quitApp } from './tauri';

type Mode = 'server' | 'local';
type Config = { server: string; wrapped: string; nick: string; mode: Mode; device: string };
// n: per-message nonce (replay detection + delivery receipt), at: sender clock
type Payload = { v: 1; from: string; n: string; at: number } & (
  | { type: 'chat'; text: string }
  | { type: 'status'; emoji: string; text: string }
  | { type: 'action'; kind: keyof typeof ACTIONS });

const DEFAULT_SERVER = import.meta.env.VITE_DEFAULT_SERVER ?? 'ws://localhost:8080';
const STATUSES = [['💻', '일하는 중'], ['🍚', '밥 먹는 중'], ['☕', '쉬는 중'], ['🔥', '바빠요'], ['🏃', '퇴근!']];
const ACTIONS = { poke: ['👉', '콕 찔렀어요'], heart: ['❤️', '하트를 보냈어요'], hug: ['🤗', '안아줬어요'] } as const;
// ponytail: localStorage caps around 5MB; move local history to IndexedDB if couples hit it.
const LOCAL_HISTORY_MAX = 5000;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const show = (id: string) => document.querySelectorAll<HTMLElement>('.screen').forEach((s) => (s.hidden = s.id !== id));
const load = <T>(k: string, d: T): T => JSON.parse(localStorage.getItem(k) ?? 'null') ?? d;
const save = (k: string, v: unknown) => localStorage.setItem(k, JSON.stringify(v));

let config = load<Config | null>('ct.config', null);

// ---------- setup / unlock ----------

function pairingCode(server: string, secret: Bytes, mode: Mode) {
  return `${server}#${b64(secret)}#${mode}`;
}

async function finishSetup(server: string, secret: Bytes, mode: Mode, nick: string, pin: string) {
  // The wrapped secret can be brute-forced offline by anyone who copies app storage, so short PINs are not enough.
  if (pin.length < 8) throw new Error('잠금 비밀번호는 8자 이상이어야 해요');
  let u: URL;
  try { u = new URL(server); } catch { throw new Error('서버 주소 형식이 올바르지 않아요'); }
  if (u.protocol !== 'wss:' && !(u.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
    throw new Error('서버 주소는 wss:// 로 시작해야 해요 (로컬 테스트만 ws:// 허용)');
  if (!nick.trim()) throw new Error('닉네임을 입력해 주세요');
  config = { server, wrapped: await wrapSecret(secret, pin), nick: nick.trim(), mode, device: randomId() };
  save('ct.config', config);
  await start(secret);
}

function bindForm(id: string, fn: (f: FormData) => Promise<void>) {
  const form = $<HTMLFormElement>(id);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = form.querySelector('.error')!;
    err.textContent = '';
    try { await fn(new FormData(form)); } catch (ex) { err.textContent = (ex as Error).message; }
  };
}

bindForm('#create-form', async (f) => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  await finishSetup(String(f.get('server')).trim(), secret, f.get('mode') as Mode, String(f.get('nick')), String(f.get('pin')));
  showCode();
});

bindForm('#join-form', async (f) => {
  const [server, secret, mode] = String(f.get('code')).trim().split('#');
  if (!server || !secret || (mode !== 'server' && mode !== 'local')) throw new Error('코드 형식이 올바르지 않아요');
  await finishSetup(server, unb64(secret), mode, String(f.get('nick')), String(f.get('pin')));
});

bindForm('#unlock-form', async (f) => {
  let secret: Bytes;
  try { secret = await unwrapSecret(config!.wrapped, String(f.get('pin'))); } catch { throw new Error('비밀번호가 틀렸어요'); }
  await start(secret);
});

// Native confirm()/alert() aren't reliable in Tauri webviews, so confirm by clicking twice.
$('#reset').onclick = (e) => {
  const b = e.currentTarget as HTMLButtonElement;
  if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = '정말 지울까요? 한 번 더 누르세요'; return; }
  localStorage.removeItem('ct.config');
  localStorage.removeItem('ct.history');
  location.reload();
};

// ---------- chat ----------

let room: Room;
let secretBytes: Bytes;
let lastId = 0;
let partnerStatus = '';
const seen = new Set<number>();
const seenNonces = new Set<string>();
let net: ReturnType<typeof connect>;

function showCode() {
  $('#code').textContent = pairingCode(config!.server, secretBytes, config!.mode);
  $<HTMLDialogElement>('#code-dialog').showModal();
}

async function start(secret: Bytes) {
  secretBytes = secret;
  room = await deriveRoom(secret);
  show('chat');
  $('#me').textContent = config!.nick;
  const local = load<Item[]>('ct.history', []);
  if (config!.mode === 'local') for (const it of local) await render(it, false);

  net = connect(config!.server, { roomId: room.roomId, token: room.token, device: config!.device, mode: config!.mode }, () => lastId, {
    onState: (online, error) => {
      $('#conn').className = online ? 'on' : 'off';
      $('#conn').title = error === 'unauthorized' ? '인증 실패: 코드를 확인하세요' : online ? '연결됨' : '연결 중…';
    },
    onReady: async (mode, items) => {
      for (const it of items) await receive(it, false, mode);
    },
    onMsg: (it) => receive(it, true, config!.mode),
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
  if (mode === 'local' && p && p.from !== config!.nick) net.ack(it.id, p.n);
}

// A decrypted payload still comes from the partner's client; a bad one must not break rendering forever.
function isValid(p: unknown): p is Payload {
  const o = p as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || typeof o.from !== 'string' || typeof o.n !== 'string' || typeof o.at !== 'number') return false;
  if (o.type === 'chat') return typeof o.text === 'string';
  if (o.type === 'status') return typeof o.emoji === 'string' && typeof o.text === 'string';
  return o.type === 'action' && typeof o.kind === 'string' && Object.hasOwn(ACTIONS, o.kind);
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
  if (seenNonces.has(p.n)) return p;
  seenNonces.add(p.n);
  const mine = p.from === config!.nick;
  const time = new Date(p.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const row = document.createElement('div');

  if (p.type === 'chat') {
    row.className = `msg ${mine ? 'mine' : 'theirs'}`;
    row.innerHTML = '<span class="bubble"></span><span class="time"></span>';
    row.querySelector('.bubble')!.textContent = p.text;
  } else {
    row.className = 'event';
    row.innerHTML = '<span class="text"></span> <span class="time"></span>';
    row.querySelector('.text')!.textContent = p.type === 'status'
      ? `${p.from} · ${p.emoji} ${p.text}`
      : `${p.from}님이 ${ACTIONS[p.kind].join(' ')}`;
    if (p.type === 'status' && !mine) {
      partnerStatus = p.emoji;
      $('#partner').textContent = `${p.from} ${p.emoji} ${p.text}`;
      petEmit({ type: 'status', emoji: p.emoji });
    }
  }
  row.querySelector('.time')!.textContent = time;
  const list = $('#messages');
  list.append(row);
  list.scrollTop = list.scrollHeight;
  // Only content-free signals go to the desktop pet so coworkers can't read over a shoulder.
  if (live && !mine && p.type !== 'status') petEmit(p.type === 'action' ? { type: 'action', kind: p.kind } : { type: 'chat' });
  return p;
}

async function sendPayload(p: Record<string, unknown>) {
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

$('#show-code').onclick = showCode;
$('#copy-code').onclick = () => navigator.clipboard.writeText($('#code').textContent!);
$('#quit').hidden = !isTauri;
$('#quit').onclick = quitApp;

petListen(() => partnerStatus && petEmit({ type: 'status', emoji: partnerStatus }));
setupMainWindow();

if (config) show('unlock');
else {
  $<HTMLInputElement>('#create-form [name=server]').value = DEFAULT_SERVER;
  show('setup');
}
