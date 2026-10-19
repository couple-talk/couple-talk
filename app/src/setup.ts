// First-run pairing, unlock and reset. settings.ts reuses the helpers exported here.
import { b64, randomId, unb64, unwrapSecret, wrapSecret, type Bytes } from './crypto';
import { secretBytes, start } from './chat';
import type { Mode } from './protocol';
import { $, config, setConfig } from './state';
import { deviceKey, petEmit } from './tauri';

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
  setConfig({ server, wrapped: await wrapSecret(secret, pin, pepper), peppered: !!pepper, nick: nick.trim(), mode, device: randomId() });
  petEmit({ type: 'reload' }); // the pet shows my nickname
  await start(secret);
}

export async function loadDeviceKey(create: boolean) {
  try { return (await deviceKey(create)) ?? undefined; } catch (e) {
    throw new Error(e === 'missing'
      ? '이 PC의 키체인에서 기기 키를 찾을 수 없어요. 아래 "초기화" 후 페어링 코드로 다시 연결해 주세요.'
      : `OS 키체인을 쓸 수 없어요 (${e}). 이 PC를 초기화하고 페어링 코드로 다시 연결해 주세요.`);
  }
}

/** Runs `fn` on submit; a thrown message shows in the form's `.error`, a returned string shows there as a success note. */
export function bindForm(id: string, fn: (f: FormData) => Promise<void | string>) {
  const form = $<HTMLFormElement>(id);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = form.querySelector('.error')!;
    err.textContent = '';
    err.classList.remove('ok');
    try {
      const note = await fn(new FormData(form));
      if (note) { err.textContent = note; err.classList.add('ok'); }
    } catch (ex) { err.textContent = (ex as Error).message; }
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
    if (fresh) setConfig({ ...config!, wrapped: await wrapSecret(secret, pin, fresh), peppered: true });
  }
  await start(secret);
});

/**
 * Wipes this PC. Native confirm()/alert() aren't reliable in Tauri webviews, so confirm by clicking twice.
 * Returns a disarm function for callers whose button can be hidden (a dialog) between the two clicks.
 */
export function bindReset(id: string) {
  const b = $<HTMLButtonElement>(id);
  const label = b.textContent;
  b.onclick = async () => {
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = '정말 지울까요? 한 번 더 누르세요'; return; }
    localStorage.removeItem('ct.config');
    localStorage.removeItem('ct.history');
    localStorage.removeItem('ct.partner');
    localStorage.removeItem('ct.presence');
    for (const db of ['ct-packs', 'ct-files'])
      await new Promise((done) => { const r = indexedDB.deleteDatabase(db); r.onsuccess = r.onerror = r.onblocked = done; });
    // Awaited so the pets drop the old name tags and characters before this page navigates away.
    await petEmit({ type: 'reload' }).catch(() => {});
    location.reload();
  };
  return () => { delete b.dataset.armed; b.textContent = label; };
}
bindReset('#reset');

function showCode() {
  $('#code').textContent = pairingCode(config!.server, secretBytes, config!.mode);
  $<HTMLDialogElement>('#code-dialog').showModal();
}

$('#show-code').onclick = showCode;
$('#copy-code').onclick = () => navigator.clipboard.writeText($('#code').textContent!);
