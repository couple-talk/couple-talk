import './style.css';
import { b64, deriveRoom, open, randomId, receiptOf, seal, unb64, unwrapSecret, wrapSecret, type Bytes, type Room } from './crypto';
import { connect, type Item } from './net';
import { checkPack, savePack, storedPack, toStored, type Files, type Who } from './pack';
import { deviceKey, isTauri, petEmit, petListen, setupMainWindow, quitApp } from './tauri';

type Mode = 'server' | 'local';
type Config = { server: string; wrapped: string; peppered: boolean; nick: string; mode: Mode; device: string };
// n: per-message nonce (replay detection + delivery receipt), at: sender clock. Both are absent in pre-receipt messages.
type Payload = { v: 1; from: string; n?: string; at?: number } & (
  | { type: 'chat'; text: string }
  | { type: 'status'; emoji: string; text: string }
  | { type: 'action'; kind: keyof typeof ACTIONS }
  // pack: sha256 of the sealed pack on the relay, or null for the built-in character
  | { type: 'character'; pack: string | null; name: string });

const DEFAULT_SERVER = import.meta.env.VITE_DEFAULT_SERVER ?? 'ws://localhost:8080';
const STATUSES = [['💻', '일하는 중'], ['🗓️', '회의 중'], ['🍚', '밥 먹는 중'], ['☕', '쉬는 중'], ['🔥', '바빠요'], ['🏃', '퇴근!']];
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
  const pepper = await loadDeviceKey(true);
  config = { server, wrapped: await wrapSecret(secret, pin, pepper), peppered: !!pepper, nick: nick.trim(), mode, device: randomId() };
  save('ct.config', config);
  await start(secret);
}

async function loadDeviceKey(create: boolean) {
  try { return (await deviceKey(create)) ?? undefined; } catch (e) {
    throw new Error(e === 'missing'
      ? '이 PC의 키체인에서 기기 키를 찾을 수 없어요. 아래 "초기화" 후 페어링 코드로 다시 연결해 주세요.'
      : `OS 키체인을 쓸 수 없어요 (${e}). 이 PC를 초기화하고 페어링 코드로 다시 연결해 주세요.`);
  }
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
  const pin = String(f.get('pin'));
  const pepper = config!.peppered ? await loadDeviceKey(false) : undefined;
  try { secret = await unwrapSecret(config!.wrapped, pin, pepper); } catch { throw new Error('비밀번호가 틀렸어요'); }
  if (!config!.peppered) {
    // Configs from before the keychain pepper get upgraded on their first unlock.
    const fresh = await loadDeviceKey(true);
    if (fresh) save('ct.config', (config = { ...config!, wrapped: await wrapSecret(secret, pin, fresh), peppered: true }));
  }
  await start(secret);
});

// Native confirm()/alert() aren't reliable in Tauri webviews, so confirm by clicking twice.
$('#reset').onclick = (e) => {
  const b = e.currentTarget as HTMLButtonElement;
  if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = '정말 지울까요? 한 번 더 누르세요'; return; }
  localStorage.removeItem('ct.config');
  localStorage.removeItem('ct.history');
  indexedDB.deleteDatabase('ct-packs');
  location.reload();
};

// ---------- chat ----------

let room: Room;
let secretBytes: Bytes;
let lastId = 0;
const statuses: Record<Who, string> = { me: '', partner: '' };
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
      for (const who of ['me', 'partner'] as const) if (wanted[who] !== undefined) applyCharacter(who, wanted[who]!);
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
  if (mode === 'local' && p?.n && p.from !== config!.nick) net.ack(it.id, p.n);
}

// A decrypted payload still comes from the partner's client; a bad one must not break rendering forever.
function isValid(p: unknown): p is Payload {
  const o = p as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || typeof o.from !== 'string') return false;
  if ((o.n !== undefined && typeof o.n !== 'string') || (o.at !== undefined && typeof o.at !== 'number')) return false;
  if (o.type === 'chat') return typeof o.text === 'string';
  if (o.type === 'status') return typeof o.emoji === 'string' && typeof o.text === 'string';
  if (o.type === 'character') return (o.pack === null || (typeof o.pack === 'string' && /^[\w-]{43}$/.test(o.pack))) && typeof o.name === 'string';
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
  if (p.n) {
    if (seenNonces.has(p.n)) return p;
    seenNonces.add(p.n);
  }
  const mine = p.from === config!.nick;
  const time = new Date(p.at ?? it.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
      : p.type === 'character'
        ? `${p.from}님이 캐릭터를 바꿨어요: ${p.name}`
        : `${p.from}님이 ${ACTIONS[p.kind].join(' ')}`;
    if (p.type === 'character') applyCharacter(mine ? 'me' : 'partner', p.pack);
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
  // Only content-free signals go to the desktop pet so coworkers can't read over a shoulder.
  if (live && p.type === 'action') petEmit({ type: 'action', kind: p.kind, from: mine ? 'me' : 'partner' });
  else if (live && !mine && p.type === 'chat') petEmit({ type: 'chat', from: 'partner' });
  return p;
}

// ---------- characters ----------

// History replays every character change in order; only the newest one per side may land.
const charSeq: Record<Who, number> = { me: 0, partner: 0 };
// Retried on reconnect so one failed download doesn't stick until the partner changes again.
const wanted: Partial<Record<Who, string | null>> = {};

async function applyCharacter(who: Who, hash: string | null) {
  const seq = ++charSeq[who];
  wanted[who] = hash;
  const label = $(who === 'me' ? '#char-me' : '#char-partner');
  try {
    if (!hash) await savePack(who, null);
    else if ((await storedPack(who))?.hash !== hash) {
      label.textContent = '불러오는 중…';
      if (!net) throw new Error('offline'); // local-mode history renders before connecting
      const blob = await net.getPack(hash);
      if (seq !== charSeq[who]) return;
      // The relay checks this too, but it must not be able to swap in another pack from this room.
      if (!blob || (await receiptOf(blob)) !== hash) throw new Error('서버에서 팩을 찾을 수 없어요');
      const sealed = await open<{ files: Record<string, string> }>(room.key, blob);
      const files: Files = Object.fromEntries(Object.entries(sealed.files).map(([k, v]) => [k, unb64(v)]));
      const report = await checkPack(files);
      if (!report.manifest) throw new Error(report.errors[0]);
      if (seq !== charSeq[who]) return;
      await savePack(who, await toStored(hash, report.manifest, files));
    }
    if (seq !== charSeq[who]) return;
    petEmit({ type: 'reload' });
    await showCharacters();
  } catch (e) {
    if (seq === charSeq[who]) label.textContent = `불러오지 못했어요 (${(e as Error).message})`;
  }
}

async function showCharacters() {
  for (const who of ['me', 'partner'] as const)
    $(who === 'me' ? '#char-me' : '#char-partner').textContent = (await storedPack(who))?.manifest.name ?? '말랑이 (기본)';
}

async function importPack(list: FileList) {
  const report = $('#char-report');
  report.replaceChildren();
  const note = (text: string, cls = '') => report.append(Object.assign(document.createElement('li'), { textContent: text, className: cls }));
  const files: Files = {};
  for (const f of list) files[f.name] = new Uint8Array(await f.arrayBuffer());
  const r = await checkPack(files);
  for (const e of r.errors) note(`❌ ${e}`, 'error');
  for (const w of r.warnings) note(`⚠️ ${w}`);
  if (!r.manifest) return;
  note('검사 통과. 암호화해서 보내는 중…');
  const used = ['manifest.json', ...new Set(Object.values(r.manifest.poses).flat())];
  const blob = await seal(room.key, { files: Object.fromEntries(used.map((f) => [f, b64(files[f])])) });
  const hash = await receiptOf(blob);
  try { await net.putPack(hash, blob); } catch (e) {
    const msg = (e as Error).message;
    note(msg === 'unknown op' ? '이 서버는 캐릭터 팩 전송을 지원하지 않아요. 서버를 업데이트해 주세요.' : `보내지 못했어요 (${msg})`, 'error');
    return;
  }
  await savePack('me', await toStored(hash, r.manifest, files));
  if (await sendPayload({ type: 'character', pack: hash, name: r.manifest.name })) note(`✅ ${r.manifest.name}(으)로 바꿨어요. 상대 화면에도 보여요.`);
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
$('#show-chars').onclick = () => { showCharacters(); $<HTMLDialogElement>('#char-dialog').showModal(); };
$<HTMLInputElement>('#char-file').onchange = async (e) => {
  const input = e.currentTarget as HTMLInputElement;
  if (!input.files?.length) return;
  input.disabled = true;
  try { await importPack(input.files); } finally { input.disabled = false; input.value = ''; }
};
$('#char-default').onclick = () => sendPayload({ type: 'character', pack: null, name: '말랑이' });
$('#copy-code').onclick = () => navigator.clipboard.writeText($('#code').textContent!);
$('#quit').hidden = !isTauri;
$('#quit').onclick = quitApp;

petListen(() => {
  for (const from of ['me', 'partner'] as const) if (statuses[from]) petEmit({ type: 'status', emoji: statuses[from], from });
});
setupMainWindow();

if (config) show('unlock');
else {
  $<HTMLInputElement>('#create-form [name=server]').value = DEFAULT_SERVER;
  show('setup');
}
