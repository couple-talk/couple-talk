// Character packs: applying the ones announced in chat and importing my own.
import { b64, open, receiptOf, seal, unb64 } from './crypto';
import { net, room, sendPayload } from './chat';
import { checkPack, dropPack, keepPack, keptPacks, savePack, storedPack, toStored, type Files, type Manifest, type StoredPack, type Who } from './pack';
import { $ } from './state';
import { petEmit } from './tauri';

// History replays every character change in order; only the newest one per side may land.
const charSeq: Record<Who, number> = { me: 0, partner: 0 };
// Applied after each history replay, which also retries a failed download on reconnect.
// Keyed by message id so a replayed older change can't override a live newer one.
export const wanted: Partial<Record<Who, { id: number; pack: string | null }>> = {};

export async function applyCharacter(who: Who, hash: string | null, id: number) {
  if ((wanted[who]?.id ?? -1) > id) return;
  const seq = ++charSeq[who];
  wanted[who] = { id, pack: hash };
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
      const stored = await toStored(hash, report.manifest, files);
      if (seq !== charSeq[who]) return;
      await savePack(who, stored);
      if (who === 'me') await keepPack(stored); // picked on my other PC: still mine to pick again here
    }
    if (seq !== charSeq[who]) return;
    petEmit({ type: 'reload' });
    await showCharacters();
  } catch (e) {
    if (seq === charSeq[who]) label.textContent = `불러오지 못했어요 (${(e as Error).message})`;
  }
}

async function showCharacters() {
  const mine = await storedPack('me');
  for (const who of ['me', 'partner'] as const)
    $(who === 'me' ? '#char-me' : '#char-partner').textContent = (who === 'me' ? mine : await storedPack(who))?.manifest.name ?? '말랑이 (기본)';
  const list = $('#char-list');
  list.replaceChildren(...(await keptPacks()).map((p) => {
    const li = document.createElement('li');
    const pick = Object.assign(document.createElement('button'), { type: 'button', textContent: p.manifest.name, className: 'chip' });
    pick.classList.toggle('on', p.manifest.id === mine?.manifest.id);
    pick.onclick = () => pickKept(p);
    const drop = Object.assign(document.createElement('button'), { type: 'button', textContent: '지우기', className: 'link' });
    drop.onclick = async () => { await dropPack(p.manifest.id); await showCharacters(); };
    pick.disabled = drop.disabled = busy; // re-rendered mid-send by usePack and the echo
    li.append(pick, drop);
    return li;
  }));
}

const note = (text: string, cls = '') => $('#char-report').append(Object.assign(document.createElement('li'), { textContent: text, className: cls }));

/** Seals the pack, uploads it and announces it as my character. */
async function usePack(manifest: Manifest, files: Files) {
  note('암호화해서 보내는 중…');
  // Older relays reject part uploads without a hash in the error, which would only surface as a timeout.
  const v = net.packs();
  if (v !== 2) {
    note(v === null ? '연결 중이에요. 잠시 후 다시 시도해 주세요.' : '이 서버는 캐릭터 팩 전송을 지원하지 않아요. 서버를 업데이트해 주세요.', 'error');
    return;
  }
  const used = ['manifest.json', ...new Set(Object.values(manifest.poses).flat())];
  const blob = await seal(room.key, { files: Object.fromEntries(used.map((f) => [f, b64(files[f])])) });
  const hash = await receiptOf(blob);
  try { await net.putPack(hash, blob); } catch (e) { note(`보내지 못했어요 (${(e as Error).message})`, 'error'); return; }
  // Saved before announcing so my own echo doesn't download the pack again; undone if the announcement fails.
  const prev = await storedPack('me');
  await savePack('me', await toStored(hash, manifest, files));
  if (await sendPayload({ type: 'character', pack: hash, name: manifest.name })) note(`✅ ${manifest.name}(으)로 바꿨어요. 상대 화면에도 보여요.`);
  else { await savePack('me', prev ?? null); note('연결이 끊겨서 바꾸지 못했어요. 다시 시도해 주세요.', 'error'); }
  await showCharacters();
}

// One upload at a time: picking from the list while an import is still sending would race on 'me'.
let busy = false;
const controls = () => document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('#char-list button, #char-file, #char-default');

async function locked(fn: () => Promise<unknown>) {
  if (busy) return;
  busy = true;
  controls().forEach((c) => (c.disabled = true));
  try { await fn(); } finally { busy = false; controls().forEach((c) => (c.disabled = false)); }
}

const pickKept = (p: StoredPack) => locked(() => sendKept(p));

async function sendKept(p: StoredPack) {
  $('#char-report').replaceChildren();
  // Kept packs were checked on import; the partner checks the rebuilt files again.
  const files: Files = Object.fromEntries(Object.entries(p.files).map(([f, url]) => [f, unb64(url.slice(url.indexOf(',') + 1))]));
  files['manifest.json'] = new TextEncoder().encode(JSON.stringify(p.manifest));
  await usePack(p.manifest, files);
}

async function importPack(list: FileList) {
  $('#char-report').replaceChildren();
  const files: Files = {};
  for (const f of list) files[f.name] = new Uint8Array(await f.arrayBuffer());
  const r = await checkPack(files, { all: true }); // my own files: show every problem at once
  for (const e of r.errors) note(`❌ ${e}`, 'error');
  for (const w of r.warnings) note(`⚠️ ${w}`);
  if (!r.manifest) return;
  // Kept even if sending fails, so it can be retried from the list.
  await keepPack(await toStored('', r.manifest, files));
  await showCharacters();
  note('검사 통과. 목록에 넣었어요.');
  await usePack(r.manifest, files);
}

$('#show-chars').onclick = () => { showCharacters(); $<HTMLDialogElement>('#char-dialog').showModal(); };
$<HTMLInputElement>('#char-file').onchange = async (e) => {
  const input = e.currentTarget as HTMLInputElement;
  if (input.files?.length) await locked(() => importPack(input.files!));
  input.value = '';
};
$('#char-default').onclick = () => locked(() => sendPayload({ type: 'character', pack: null, name: '말랑이' }));
