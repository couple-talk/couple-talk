// Character packs: applying the ones announced in chat and importing my own.
import { b64, open, receiptOf, seal, unb64 } from './crypto';
import { net, room, sendPayload } from './chat';
import { checkPack, savePack, storedPack, toStored, type Files, type Who } from './pack';
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
  const r = await checkPack(files, { all: true }); // my own files: show every problem at once
  for (const e of r.errors) note(`❌ ${e}`, 'error');
  for (const w of r.warnings) note(`⚠️ ${w}`);
  if (!r.manifest) return;
  note('검사 통과. 암호화해서 보내는 중…');
  // Older relays reject part uploads without a hash in the error, which would only surface as a timeout.
  const v = net.packs();
  if (v !== 2) {
    note(v === null ? '연결 중이에요. 잠시 후 다시 시도해 주세요.' : '이 서버는 캐릭터 팩 전송을 지원하지 않아요. 서버를 업데이트해 주세요.', 'error');
    return;
  }
  const used = ['manifest.json', ...new Set(Object.values(r.manifest.poses).flat())];
  const blob = await seal(room.key, { files: Object.fromEntries(used.map((f) => [f, b64(files[f])])) });
  const hash = await receiptOf(blob);
  try { await net.putPack(hash, blob); } catch (e) { note(`보내지 못했어요 (${(e as Error).message})`, 'error'); return; }
  // Saved before announcing so my own echo doesn't download the pack again; undone if the announcement fails.
  const prev = await storedPack('me');
  await savePack('me', await toStored(hash, r.manifest, files));
  if (await sendPayload({ type: 'character', pack: hash, name: r.manifest.name })) note(`✅ ${r.manifest.name}(으)로 바꿨어요. 상대 화면에도 보여요.`);
  else { await savePack('me', prev ?? null); note('연결이 끊겨서 바꾸지 못했어요. 다시 시도해 주세요.', 'error'); }
}

$('#show-chars').onclick = () => { showCharacters(); $<HTMLDialogElement>('#char-dialog').showModal(); };
$<HTMLInputElement>('#char-file').onchange = async (e) => {
  const input = e.currentTarget as HTMLInputElement;
  if (!input.files?.length) return;
  input.disabled = true;
  try { await importPack(input.files); } finally { input.disabled = false; input.value = ''; }
};
$('#char-default').onclick = () => sendPayload({ type: 'character', pack: null, name: '말랑이' });
