// Settings dialog: nickname, pet bubble privacy, pairing code, password change, lock and reset.
import { unwrapSecret, wrapSecret } from './crypto';
import { secretBytes } from './chat';
import { bindForm, bindReset, loadDeviceKey } from './setup';
import { $, config, load, setConfig } from './state';
import { isTauri, petEmit } from './tauri';

const dialog = $<HTMLDialogElement>('#settings-dialog');

$('#show-settings').onclick = () => {
  $<HTMLInputElement>('#nick-form [name=nick]').value = config!.nick;
  $<HTMLInputElement>('#hide-pet-text').checked = !!config!.hidePetText;
  $<HTMLInputElement>('#notify-text').checked = !!config!.notifyText;
  $<HTMLInputElement>('#tap-to-view').checked = !!config!.tapToView;
  $<HTMLInputElement>('#off-at').value = config!.offAt ?? '';
  $('#set-server').textContent = config!.server;
  $('#set-mode').textContent = config!.mode === 'server' ? '서버 (암호문 보관)' : '각자 PC에만';
  dialog.querySelectorAll('.error').forEach((e) => (e.textContent = ''));
  dialog.showModal();
};

// The old name is kept as still mine for messages without a person id (from before #7 or from an older app),
// and the partner's name is refused because an older app on their side still tells us apart by name.
// Past messages keep showing the old name on both screens.
bindForm('#nick-form', async (f) => {
  const nick = String(f.get('nick')).trim();
  if (!nick) throw new Error('닉네임을 입력해 주세요');
  if (nick === config!.nick) return '지금 닉네임과 같아요';
  if (nick === load<string | null>('ct.partner', null)) throw new Error('상대와 같은 닉네임은 쓸 수 없어요');
  const pastNicks = [...new Set([...(config!.pastNicks ?? []), config!.nick])].filter((n) => n !== nick);
  setConfig({ ...config!, nick, pastNicks });
  $('#me').textContent = nick;
  petEmit({ type: 'reload' }); // the pet's name tag
  return '바꿨어요';
});

$<HTMLInputElement>('#hide-pet-text').onchange = (e) => setConfig({ ...config!, hidePetText: (e.currentTarget as HTMLInputElement).checked });
$<HTMLInputElement>('#notify-text').onchange = (e) => setConfig({ ...config!, notifyText: (e.currentTarget as HTMLInputElement).checked });
$<HTMLInputElement>('#tap-to-view').onchange = (e) => setConfig({ ...config!, tapToView: (e.currentTarget as HTMLInputElement).checked });
$<HTMLInputElement>('#off-at').onchange = (e) => setConfig({ ...config!, offAt: (e.currentTarget as HTMLInputElement).value || undefined });
// Notifications, the tray and the shortcut only exist in the desktop app.
$('#notify-text').closest('label')!.hidden = $('#shortcut-hint').hidden = !isTauri;

bindForm('#pin-form', async (f) => {
  const pin = String(f.get('pin'));
  if (pin.length < 8) throw new Error('잠금 비밀번호는 8자 이상이어야 해요');
  const pepper = config!.peppered ? await loadDeviceKey(false) : undefined;
  try { await unwrapSecret(config!.wrapped, String(f.get('old')), pepper); } catch { throw new Error('현재 비밀번호가 틀렸어요'); }
  // The secret and the keychain pepper stay; only the password layer is replaced.
  setConfig({ ...config!, wrapped: await wrapSecret(secretBytes, pin, pepper) });
  $<HTMLFormElement>('#pin-form').reset();
  return '바꿨어요. 다음부터 새 비밀번호로 열려요';
});

// Reloading drops the secret and every decrypted message from memory; the saved config brings up the unlock screen.
$('#lock').onclick = () => location.reload();
// Closing the dialog between the two clicks cancels the reset instead of leaving it one click away.
const disarmReset = bindReset('#settings-reset');
dialog.addEventListener('close', disarmReset);
