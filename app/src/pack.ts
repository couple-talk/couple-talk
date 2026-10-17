// Character packs: validation, storage and loading. Format: docs/character-pack.md.
// Packs can come from the partner, so everything here treats them as untrusted input.

export const REQUIRED_POSES = [
  'idle', 'walk', 'notify',
  'heart_send', 'heart_hit', 'poke_hit', 'hug',
  'status_work', 'status_meeting', 'status_eat', 'status_rest', 'status_busy', 'status_off',
] as const;
export const PACK_MAX_BYTES = 4 * 1024 * 1024;
const MAX_SIDE = 1024;
const FILE_RE = /^[\w-][\w.-]{0,63}\.(png|svg)$/;

export type Manifest = {
  v: 2; id: string; name: string; author?: string; speed: number; fps: number; hand: [number, number]; poses: Record<string, string[]>;
};
export type Files = Record<string, Uint8Array>;
export type Report = { errors: string[]; warnings: string[]; manifest?: Manifest };

const inflate = async (data: Uint8Array) =>
  new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());

// Only 8-bit RGBA PNGs are decoded; that is what image generators export with a transparent background.
async function readPng(buf: Uint8Array) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 33 || v.getUint32(0) !== 0x89504e47) throw new Error('PNG 파일이 아니에요');
  const w = v.getUint32(16), h = v.getUint32(20), depth = buf[24], color = buf[25];
  if (w > MAX_SIDE || h > MAX_SIDE) throw new Error(`${MAX_SIDE}px보다 커요 (${w}×${h})`);
  if (depth !== 8 || color !== 6) return { w, h };
  const idat: Uint8Array[] = [];
  for (let p = 8; p + 8 <= buf.length; ) {
    const len = v.getUint32(p), type = String.fromCharCode(...buf.subarray(p + 4, p + 8));
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = await inflate(new Uint8Array(await new Blob(idat as BlobPart[]).arrayBuffer()));
  const stride = w * 4, out = new Uint8Array(stride * h);
  if (raw.length < (stride + 1) * h) throw new Error('PNG 데이터가 잘려 있어요');
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[row + x - 4] : 0, b = y ? out[row - stride + x] : 0, c = x >= 4 && y ? out[row - stride + x - 4] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f] ?? 0;
      out[row + x] = (raw[src + x] + pred) & 0xff;
    }
  }
  return { w, h, rgba: out };
}

const num = (n: unknown, min: number, max: number, d: number) => (n === undefined ? d : typeof n === 'number' && n >= min && n <= max ? n : NaN);

export async function checkPack(files: Files): Promise<Report> {
  const errors: string[] = [], warnings: string[] = [];
  let m;
  try { m = JSON.parse(new TextDecoder().decode(files['manifest.json'])); } catch { return { errors: ['manifest.json이 없거나 JSON 형식이 아니에요'], warnings }; }
  const total = Object.values(files).reduce((n, f) => n + f.length, 0);
  if (total > PACK_MAX_BYTES) errors.push(`팩이 너무 커요 (${(total / 1048576).toFixed(1)}MB, 최대 4MB). 이미지를 512px로 줄여 주세요`);
  if (m?.v !== 2) errors.push('manifest.v는 2여야 해요');
  if (!/^[a-z0-9-]{1,32}$/.test(m?.id ?? '')) errors.push('id는 영문 소문자·숫자·하이픈 32자 이내');
  if (typeof m?.name !== 'string' || !m.name || m.name.length > 20) errors.push('name은 1~20자여야 해요');
  if (!Array.isArray(m?.hand) || m.hand.length !== 2 || m.hand.some((n: unknown) => typeof n !== 'number' || n < 0 || n > 1))
    errors.push('hand는 [x, y] (0~1 비율)이어야 해요');
  const speed = num(m?.speed, 0.5, 8, 2), fps = num(m?.fps, 1, 12, 4);
  if (Number.isNaN(speed)) errors.push('speed는 0.5~8 사이 숫자여야 해요');
  if (Number.isNaN(fps)) errors.push('fps는 1~12 사이 숫자여야 해요');
  const poses = m?.poses;
  if (!poses || typeof poses !== 'object' || Object.values(poses).some((f) => !Array.isArray(f) || f.some((x) => typeof x !== 'string')))
    return { errors: [...errors, 'poses는 포즈 이름 → 파일 이름 목록이어야 해요'], warnings };
  for (const p of REQUIRED_POSES) if (!poses[p]?.length) errors.push(`필수 포즈 없음: ${p}`);
  if ((poses.walk?.length ?? 0) < 2) errors.push('walk는 프레임이 2장 이상이어야 해요');

  let size = 0;
  for (const [pose, frames] of Object.entries(poses as Record<string, string[]>)) for (const file of frames) {
    const where = `${pose}/${file}`;
    if (!FILE_RE.test(file)) { errors.push(`${where}: 파일 이름은 영문·숫자·-_. 이고 .png나 .svg로 끝나야 해요`); continue; }
    if (!files[file]) { errors.push(`${where}: 파일이 없어요`); continue; }
    if (file.endsWith('.svg')) continue;
    let img: Awaited<ReturnType<typeof readPng>>;
    try { img = await readPng(files[file]); } catch (e) { errors.push(`${where}: ${(e as Error).message}`); continue; }
    if (img.w !== img.h) errors.push(`${where}: 정사각형이 아니에요 (${img.w}×${img.h})`);
    size ||= img.w;
    if (img.w !== size) errors.push(`${where}: 다른 포즈와 크기가 달라요 (${img.w}, 기준 ${size})`);
    if (!img.rgba) { errors.push(`${where}: 8bit RGBA(투명 배경) PNG로 저장해 주세요`); continue; }

    const { w, rgba } = img;
    const A = (x: number, y: number) => rgba[(y * w + x) * 4 + 3];
    const s = w - 1;
    if (A(0, 0) || A(s, 0) || A(0, s) || A(s, s)) { errors.push(`${where}: 배경이 투명하지 않아요 (모서리가 칠해져 있음)`); continue; }
    let top = w, bottom = -1, left = w, right = -1;
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) if (A(x, y) > 16) {
      top = Math.min(top, y); bottom = Math.max(bottom, y); left = Math.min(left, x); right = Math.max(right, x);
    }
    if (bottom < 0) { errors.push(`${where}: 완전히 투명한 이미지예요`); continue; }
    const pct = (n: number) => Math.round((n / w) * 100);
    if (pct(bottom) < 88 || pct(bottom) > 97) warnings.push(`${where}: 발끝이 ${pct(bottom)}% 높이에 있어요 (권장 92% 근처)`);
    if (pct(top) < 3) warnings.push(`${where}: 위쪽 여백이 거의 없어요 (점프할 때 잘려요)`);
    if (Math.abs(pct((left + right) / 2) - 50) > 12) warnings.push(`${where}: 몸 중심이 가운데에서 많이 벗어나 있어요`);
  }
  if (errors.length) return { errors, warnings };
  const manifest: Manifest = { v: 2, id: m.id, name: m.name, speed, fps, hand: m.hand, poses };
  if (typeof m.author === 'string') manifest.author = m.author.slice(0, 40);
  return { errors, warnings, manifest };
}

// ---------- storage (IndexedDB, shared by the main and pet windows) ----------

export type Who = 'me' | 'partner';
/** `hash` identifies the sealed pack on the relay; files are data: URLs so the CSP needs no blob: source. */
export type StoredPack = { hash: string; manifest: Manifest; files: Record<string, string> };

function store<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest) {
  return new Promise<T>((ok, fail) => {
    const req = indexedDB.open('ct-packs', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('packs');
    req.onerror = () => fail(req.error);
    req.onsuccess = () => {
      const r = fn(req.result.transaction('packs', mode).objectStore('packs'));
      r.onsuccess = () => ok(r.result);
      r.onerror = () => fail(r.error);
    };
  });
}
export const savePack = (who: Who, p: StoredPack | null) => store<void>('readwrite', (s) => (p ? s.put(p, who) : s.delete(who)));
export const storedPack = (who: Who) => store<StoredPack | undefined>('readonly', (s) => s.get(who));

const dataUrl = (bytes: Uint8Array, name: string) => new Promise<string>((ok) => {
  const r = new FileReader();
  r.onload = () => ok(r.result as string);
  r.readAsDataURL(new Blob([bytes as BlobPart], { type: name.endsWith('.svg') ? 'image/svg+xml' : 'image/png' }));
});

/** Keeps only the files the manifest uses, as data: URLs. */
export async function toStored(hash: string, manifest: Manifest, files: Files): Promise<StoredPack> {
  const used = [...new Set(Object.values(manifest.poses).flat())];
  return { hash, manifest, files: Object.fromEntries(await Promise.all(used.map(async (f) => [f, await dataUrl(files[f], f)]))) };
}

export const BUILTIN = 'default';

/** What a pet window draws: the stored pack for `who`, or the built-in character. */
export async function loadPack(who: Who): Promise<{ manifest: Manifest; url: (file: string) => string }> {
  const p = await storedPack(who).catch(() => undefined);
  if (p) return { manifest: p.manifest, url: (f) => p.files[f] };
  const base = `/characters/${BUILTIN}/`;
  const manifest: Manifest = await (await fetch(base + 'manifest.json')).json();
  return { manifest, url: (f) => base + f };
}
