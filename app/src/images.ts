// Photos and stickers (#10). A picture is shrunk and sealed on this PC, stored on the relay as a content-addressed
// blob like a character pack, and announced in chat by hash only. The relay never sees pixels, and this PC keeps
// only the ciphertext (IndexedDB `ct-files`); it is decrypted in memory each time it is shown.
import { b64, open, receiptOf, seal } from './crypto';
import { net, room, sendPayload } from './chat';
import { loadPack } from './pack';
import { IMAGE_FILE_MAX, isImageFile, type ImageFile, type Payload } from './protocol';
import { $, config } from './state';

const PHOTO_SIDE = 1280;
const STICKER_SIDE = 512;
const PICK_MAX = 25 * 1024 * 1024; // decoding a bigger file than this can stall the WebView
const THUMB = 240;
const STICKER_THUMB = 120;

type ImageMsg = Extract<Payload, { type: 'image' }>;

// ---------- ciphertext cache (shared origin with the pet windows; connections close per request, see app/AGENTS.md) ----------

function store<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest) {
  return new Promise<T>((ok, fail) => {
    const req = indexedDB.open('ct-files', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onerror = () => fail(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const r = fn(db.transaction('files', mode).objectStore('files'));
      db.close();
      r.onsuccess = () => ok(r.result);
      r.onerror = () => fail(r.error);
    };
  });
}
const cached = (hash: string) => store<string | undefined>('readonly', (s) => s.get(hash)).catch(() => undefined);
const cache = (hash: string, blob: string) => store<void>('readwrite', (s) => s.put(blob, hash)).catch(() => {});

/** The sealed blob for `hash`, from this PC or else the relay (then kept here). */
async function fetchSealed(hash: string) {
  const kept = await cached(hash);
  if (kept) return kept;
  if (!net) throw new Error('offline'); // local-mode history renders before connecting
  const blob = await net.getFile(hash);
  // The relay checks this too, but it must not be able to swap in another file from this room.
  if (!blob || (await receiptOf(blob)) !== hash) throw new Error('서버에 사진이 없어요');
  await cache(hash, blob);
  return blob;
}

/**
 * In "each PC only" rooms the relay deletes a photo once we fetched it and the message once we acked it,
 * so the ciphertext is fetched right away even when it won't be shown yet.
 */
export function keepFile(hash: string) {
  fetchSealed(hash).catch(() => {});
}

async function fetchImage(hash: string): Promise<ImageFile> {
  const f = await open<unknown>(room.key, await fetchSealed(hash));
  if (!isImageFile(f)) throw new Error('사진 형식이 잘못됐어요');
  return f;
}

const dataUrl = (f: ImageFile) => `data:${f.mime};base64,${f.data.replace(/-/g, '+').replace(/_/g, '/')}`;

// ---------- showing ----------

const loaders = new WeakMap<Element, () => void>();
// Pixels are fetched only for bubbles on screen: a long history must not pull every photo at once.
const onScreen = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { onScreen.unobserve(e.target); loaders.get(e.target)?.(); }
});

/** The bubble for an image message. With "눌러서 보기" it stays a placeholder until clicked. */
export function imageElement(p: ImageMsg): HTMLElement {
  const fig = document.createElement('figure');
  fig.className = p.sticker ? 'photo sticker' : 'photo';
  const w = Math.min(p.sticker ? STICKER_THUMB : THUMB, p.w);
  fig.style.width = `${w}px`;
  fig.style.aspectRatio = `${p.w} / ${p.h}`;
  const cap = document.createElement('figcaption');
  fig.append(cap);
  let loading = false;
  const load = async () => {
    if (loading) return;
    loading = true;
    cap.textContent = '불러오는 중…';
    try {
      const url = dataUrl(await fetchImage(p.file));
      const img = new Image();
      img.src = url;
      img.alt = p.sticker ? '스티커' : '사진';
      img.onclick = () => { $<HTMLImageElement>('#image-full').src = url; $<HTMLDialogElement>('#image-dialog').showModal(); };
      fig.replaceChildren(img);
      fig.onclick = null;
    } catch (e) {
      cap.textContent = `${p.sticker ? '🎭' : '📷'} 불러오지 못했어요 (${(e as Error).message}). 눌러서 다시 시도`;
      fig.onclick = load;
      loading = false;
    }
  };
  if (config!.tapToView) {
    cap.textContent = `${p.sticker ? '🎭 스티커' : '📷 사진'} · 눌러서 보기`;
    fig.onclick = load;
  } else {
    cap.textContent = p.sticker ? '🎭' : '📷';
    loaders.set(fig, load);
    onScreen.observe(fig);
  }
  return fig;
}

// ---------- sending ----------

const toDataUrl = (blob: Blob) => new Promise<string>((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok(r.result as string);
  r.onerror = () => fail(new Error('파일을 읽지 못했어요'));
  r.readAsDataURL(blob);
});

/** Decodes through an <img> (the CSP allows self and data: sources), draws it down to `side`, re-encodes. */
async function shrink(src: string, side: number, mime: ImageFile['mime']) {
  const img = new Image();
  await new Promise<void>((ok, fail) => { img.onload = () => ok(); img.onerror = () => fail(new Error('이미지 파일이 아니에요')); img.src = src; });
  const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight, 1));
  const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
  canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
  const out = await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('이미지를 변환하지 못했어요'))), mime, 0.82));
  return { bytes: new Uint8Array(await out.arrayBuffer()), w, h };
}

let sending = false;
/** `src` is a data: or same-origin URL. Stickers keep transparency (PNG) and stay small. */
async function sendImage(src: string, sticker: boolean) {
  const status = $('#send-error');
  if (sending) { status.textContent = '앞의 사진을 보내는 중이에요'; return; }
  const ok = net?.files();
  if (!ok) {
    status.textContent = ok === null || !net ? '연결 중이에요. 잠시 후 다시 시도해 주세요.' : '이 서버는 사진 전송을 지원하지 않아요. 서버를 업데이트해 주세요.';
    return;
  }
  sending = true;
  try {
    status.textContent = '사진 준비 중…';
    const { bytes, w, h } = await shrink(src, sticker ? STICKER_SIDE : PHOTO_SIDE, sticker ? 'image/png' : 'image/jpeg');
    const blob = await seal(room.key, { mime: sticker ? 'image/png' : 'image/jpeg', data: b64(bytes) } satisfies ImageFile);
    if (blob.length > IMAGE_FILE_MAX) throw new Error('사진이 너무 커요');
    const hash = await receiptOf(blob);
    status.textContent = `보내는 중… (${Math.round(bytes.length / 1024)}KB)`;
    await net.putFile(hash, blob);
    await cache(hash, blob); // my own echo shows from here, and in local mode the relay may already forget it
    if (await sendPayload({ type: 'image', file: hash, w, h, ...(sticker ? { sticker: true } : {}) })) status.textContent = '';
  } catch (e) {
    status.textContent = `보내지 못했어요 (${(e as Error).message})`;
  } finally {
    sending = false;
  }
}

async function sendPicked(file: File) {
  if (!file.type.startsWith('image/')) { $('#send-error').textContent = '이미지 파일만 보낼 수 있어요'; return; }
  if (file.size > PICK_MAX) { $('#send-error').textContent = '25MB보다 큰 파일은 보낼 수 없어요'; return; }
  await sendImage(await toDataUrl(file), false);
}

$('#pick-photo').onclick = () => $<HTMLInputElement>('#photo-file').click();
$<HTMLInputElement>('#photo-file').onchange = async (e) => {
  const input = e.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) await sendPicked(file);
};
// A screenshot in the clipboard pastes as a photo.
$('#text').addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  const file = item?.getAsFile();
  if (!file) return;
  e.preventDefault();
  sendPicked(file);
});

/** My character's poses as stickers, one per pose. */
$('#pick-sticker').onclick = async () => {
  const { manifest, url } = await loadPack('me');
  const list = $('#stickers');
  list.replaceChildren(...Object.entries(manifest.poses).filter(([, frames]) => frames.length).map(([pose, frames]) => {
    const b = document.createElement('button');
    b.type = 'button';
    const img = new Image();
    img.src = url(frames[0]);
    img.alt = pose;
    b.append(img, Object.assign(document.createElement('span'), { textContent: pose }));
    b.onclick = () => { $<HTMLDialogElement>('#sticker-dialog').close(); sendImage(img.src, true); };
    return b;
  }));
  $<HTMLDialogElement>('#sticker-dialog').showModal();
};
