// Settings dialog: nickname, pet bubble privacy, pairing code, password change, lock and reset.
import { unwrapSecret, wrapSecret } from './crypto';
import { secretBytes } from './chat';
import { bindForm, bindReset, loadDeviceKey } from './setup';
import { $, config, setConfig } from './state';
import { petEmit } from './tauri';

$('#show-settings').onclick = () => {
  $<HTMLInputElement>('#nick-form [name=nick]').value = config!.nick;
  $<HTMLInputElement>('#hide-pet-text').checked = !!config!.hidePetText;
  $('#set-server').textContent = config!.server;
  $('#set-mode').textContent = config!.mode === 'server' ? '서버 (암호문 보관)' : '각자 PC에만';
  $<HTMLDialogElement>('#settings-dialog').showModal();
};

// Past messages keep the old name on both screens; telling people apart by id is #7.
bindForm('#nick-form', async (f) => {
  const nick = String(f.get('nick')).trim();
  if (!nick) throw new Error('닉네임을 입력해 주세요');
  setConfig({ ...config!, nick });
  $('#me').textContent = nick;
  petEmit({ type: 'reload' }); // the pet's name tag
  $('#nick-form .error').textContent = '바꿨어요';
});

$<HTMLInputElement>('#hide-pet-text').onchange = (e) => setConfig({ ...config!, hidePetText: (e.currentTarget as HTMLInputElement).checked });

bindForm('#pin-form', async (f) => {
  const pin = String(f.get('pin'));
  if (pin.length < 8) throw new Error('잠금 비밀번호는 8자 이상이어야 해요');
  const pepper = config!.peppered ? await loadDeviceKey(false) : undefined;
  try { await unwrapSecret(config!.wrapped, String(f.get('old')), pepper); } catch { throw new Error('현재 비밀번호가 틀렸어요'); }
  // The secret and the keychain pepper stay; only the password layer is replaced.
  setConfig({ ...config!, wrapped: await wrapSecret(secretBytes, pin, pepper) });
  $<HTMLFormElement>('#pin-form').reset();
  $('#pin-form .error').textContent = '바꿨어요. 다음부터 새 비밀번호로 열려요';
});

// Reloading drops the secret and every decrypted message from memory; the saved config brings up the unlock screen.
$('#lock').onclick = () => location.reload();
bindReset('#settings-reset');
