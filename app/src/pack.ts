// Character packs: validation, storage and loading. Format: docs/character-pack.md.
// Packs can come from the partner, so everything here treats them as untrusted input.

export const REQUIRED_POSES = [
  'idle', 'walk', 'notify',
  'heart_send', 'heart_hit', 'poke_hit', 'hug',
  'status_work', 'status_meeting', 'status_eat', 'status_rest', 'status_busy', 'status_off',
] as const;
export const PACK_MAX_BYTES = 4 * 1024 * 1024;
const MAX_SIDE = 1024;
const MAX_POSES = 32;
const MAX_FRAMES = 8;
const FILE_RE = /^[\w-][\w.-]{0,63}\.(png|svg)$/;

export type Manifest = {
  v: 2; id: string; name: string; author?: string; speed: number; fps: number; hand: [number, number]; poses: Record<string, string[]>;
};
export type Files = Record<string, Uint8Array>;
export type Report = { errors: string[]; warnings: string[]; manifest?: Manifest };

// Stops at `max` bytes: a tiny IDAT can otherwise inflate to gigabytes (decompression bomb).
async function inflate(parts: Uint8Array[], max: number) {
  const reader = new Blob(parts as BlobPart[]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const out = new Uint8Array(max);
  for (let n = 0; ; ) {
    const { done, value } = await reader.read().catch(() => { throw new Error('PNG 압축 데이터가 잘못됐어요'); });
    if (done) return out.subarray(0, n);
    if (n + value.length > max) { await reader.cancel(); throw new Error('PNG 데이터가 이미지 크기보다 커요'); }
    out.set(value, n);
    n += value.length;
  }
}

// Only 8-bit RGBA PNGs are decoded; that is what image generators export with a transparent background.
async function readPng(buf: Uint8Array) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 33 || v.getUint32(0) !== 0x89504e47 || String.fromCharCode(...buf.subarray(12, 16)) !== 'IHDR')
    throw new Error('PNG 파일이 아니에요');
  const w = v.getUint32(16), h = v.getUint32(20), depth = buf[24], color = buf[25];
  if (!w || !h || w > MAX_SIDE || h > MAX_SIDE) throw new Error(`크기가 잘못됐거나 ${MAX_SIDE}px보다 커요 (${w}×${h})`);
  if (buf[28] !== 0) throw new Error('인터레이스 PNG는 안 돼요. 일반 PNG로 다시 저장해 주세요');
  if (depth !== 8 || color !== 6) return { w, h };
  const idat: Uint8Array[] = [];
  for (let p = 8; p + 8 <= buf.length; ) {
    const len = v.getUint32(p), type = String.fromCharCode(...buf.subarray(p + 4, p + 8));
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const stride = w * 4, out = new Uint8Array(stride * h);
  const raw = await inflate(idat, (stride + 1) * h);
  if (raw.length < (stride + 1) * h) throw new Error('PNG 데이터가 잘려 있어요');
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[row + x - 4] : 0, b = y ? out[row - stride + x] : 0, c = x >= 4 && y ? out[row - stride + x - 4] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
      out[row + x] = (raw[src + x] + pred) & 0xff;
    }
  }
  return { w, h, rgba: out };
}

const num = (n: unknown, min: number, max: number, d: number) => (n === undefined ? d : typeof n === 'number' && n >= min && n <= max ? n : NaN);

/**
 * `svg` is only for the built-in pack: packs from users and partners must be PNG.
 * `all` keeps checking after the first error, for the author's own pack; a partner's pack stops early.
 */
export async function checkPack(files: Files, { svg = false, all = false } = {}): Promise<Report> {
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
  if (Object.keys(poses).length > MAX_POSES) return { errors: [...errors, `포즈는 ${MAX_POSES}개까지예요`], warnings };
  if (Object.values(poses as Record<string, string[]>).some((f) => f.length > MAX_FRAMES))
    return { errors: [...errors, `한 포즈의 프레임은 ${MAX_FRAMES}장까지예요`], warnings };
  for (const p of REQUIRED_POSES) if (!poses[p]?.length) errors.push(`필수 포즈 없음: ${p}`);
  if ((poses.walk?.length ?? 0) < 2) errors.push('walk는 프레임이 2장 이상이어야 해요');

  // Each file is decoded once even if many frames reuse it.
  const used = new Set<string>();
  for (const [pose, frames] of Object.entries(poses as Record<string, string[]>)) for (const file of frames) {
    if (!FILE_RE.test(file)) errors.push(`${pose}/${file}: 파일 이름은 영문·숫자·-_. 이고 .png나 .svg로 끝나야 해요`);
    else if (!files[file]) errors.push(`${pose}/${file}: 파일이 없어요`);
    else if (file.endsWith('.svg') && !svg) errors.push(`${pose}/${file}: 가져오는 팩은 PNG만 쓸 수 있어요`);
    else used.add(file);
  }
  let size = 0;
  for (const file of used) {
    if (errors.length && !all) break; // a hostile pack must not cost a full decode of every file
    const where = file;
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

// My imported packs, kept by manifest id so they can be picked again without the files.
const LIB = 'lib:';

function store<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest) {
  return new Promise<T>((ok, fail) => {
    const req = indexedDB.open('ct-packs', 2);
    req.onupgradeneeded = ({ oldVersion }) => {
      if (oldVersion < 1) { req.result.createObjectStore('packs'); return; }
      // v2 added the kept list; a pack imported before it lives only in 'me'. Copied once here, so deleting it later sticks.
      const s = req.transaction!.objectStore('packs'), me = s.get('me');
      me.onsuccess = () => { if (me.result) s.put(me.result, LIB + me.result.manifest.id); };
    };
    req.onerror = () => fail(req.error);
    req.onsuccess = () => {
      // Close right away (the transaction still completes): an open connection in a pet window blocks deleteDatabase on reset.
      const db = req.result;
      const r = fn(db.transaction('packs', mode).objectStore('packs'));
      db.close();
      r.onsuccess = () => ok(r.result);
      r.onerror = () => fail(r.error);
    };
  });
}
export const savePack = (who: Who, p: StoredPack | null) => store<void>('readwrite', (s) => (p ? s.put(p, who) : s.delete(who)));
export const storedPack = (who: Who) => store<StoredPack | undefined>('readonly', (s) => s.get(who));

export const keepPack = (p: StoredPack) => store<void>('readwrite', (s) => s.put(p, LIB + p.manifest.id));
export const dropPack = (id: string) => store<void>('readwrite', (s) => s.delete(LIB + id));
export const keptPacks = () => store<StoredPack[]>('readonly', (s) => s.getAll(IDBKeyRange.bound(LIB, LIB + '￿')));

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
export async function loadPack(who: Who): Promise<{ manifest: Manifest; url: (file: string) => string; builtin: boolean }> {
  const p = await storedPack(who).catch(() => undefined);
  if (p) return { manifest: p.manifest, url: (f) => p.files[f], builtin: false };
  const base = `/characters/${BUILTIN}/`;
  const manifest: Manifest = await (await fetch(base + 'manifest.json')).json();
  return { manifest, url: (f) => base + f, builtin: true };
}
