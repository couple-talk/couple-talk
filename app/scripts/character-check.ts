// Run: node scripts/character-check.ts public/characters/<id>
// Checks a character pack against docs/character-pack.md before it ships or gets imported.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

export const REQUIRED_POSES = [
  'idle', 'walk', 'notify',
  'heart_send', 'heart_hit', 'poke_hit', 'hug',
  'status_work', 'status_meeting', 'status_eat', 'status_rest', 'status_busy', 'status_off',
] as const;

type Img = { w: number; h: number; rgba?: Uint8Array };

// Only 8-bit RGBA PNGs are decoded; that is what image generators export with a transparent background.
function readPng(buf: Buffer): Img {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG 파일이 아니에요');
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20), depth = buf[24], color = buf[25];
  if (depth !== 8 || color !== 6) return { w, h };
  const idat: Buffer[] = [];
  for (let p = 8; p < buf.length; ) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = w * 4, out = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[row + x - 4] : 0, b = y ? out[row - stride + x] : 0, c = x >= 4 && y ? out[row - stride + x - 4] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      out[row + x] = (raw[src + x] + pred) & 0xff;
    }
  }
  return { w, h, rgba: out };
}

export function checkPack(dir: string) {
  const errors: string[] = [], warnings: string[] = [];
  const mPath = join(dir, 'manifest.json');
  if (!existsSync(mPath)) return { errors: ['manifest.json이 없어요'], warnings };
  const m = JSON.parse(readFileSync(mPath, 'utf8'));
  if (m.v !== 2) errors.push('manifest.v는 2여야 해요');
  if (!/^[a-z0-9-]{1,32}$/.test(m.id ?? '')) errors.push('id는 영문 소문자·숫자·하이픈 32자 이내');
  if (typeof m.name !== 'string' || !m.name) errors.push('name이 없어요');
  if (!Array.isArray(m.hand) || m.hand.length !== 2 || m.hand.some((n: unknown) => typeof n !== 'number' || n < 0 || n > 1))
    errors.push('hand는 [x, y] (0~1 비율)이어야 해요');

  const poses: Record<string, string[]> = m.poses ?? {};
  for (const p of REQUIRED_POSES) if (!poses[p]?.length) errors.push(`필수 포즈 없음: ${p}`);
  if ((poses.walk?.length ?? 0) < 2) errors.push('walk는 프레임이 2장 이상이어야 해요');

  let size = 0;
  for (const [pose, frames] of Object.entries(poses)) for (const file of frames) {
    const where = `${pose}/${file}`;
    if (file.includes('/') || file.includes('..')) { errors.push(`${where}: 하위 폴더·상위 경로는 못 써요`); continue; }
    if (!existsSync(join(dir, file))) { errors.push(`${where}: 파일이 없어요`); continue; }
    if (file.endsWith('.svg')) continue;
    if (!file.endsWith('.png')) { errors.push(`${where}: png 또는 svg만 돼요`); continue; }
    let img: Img;
    try { img = readPng(readFileSync(join(dir, file))); } catch (e) { errors.push(`${where}: ${(e as Error).message}`); continue; }
    if (img.w !== img.h) errors.push(`${where}: 정사각형이 아니에요 (${img.w}×${img.h})`);
    size ||= img.w;
    if (img.w !== size) errors.push(`${where}: 다른 포즈와 크기가 달라요 (${img.w}, 기준 ${size})`);
    if (!img.rgba) { errors.push(`${where}: 8bit RGBA(투명 배경) PNG로 저장해 주세요`); continue; }

    const A = (x: number, y: number) => img.rgba![(y * img.w + x) * 4 + 3];
    const s = img.w - 1;
    if (A(0, 0) || A(s, 0) || A(0, s) || A(s, s)) { errors.push(`${where}: 배경이 투명하지 않아요 (모서리가 칠해져 있음)`); continue; }
    let top = img.h, bottom = -1, left = img.w, right = -1;
    for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (A(x, y) > 16) {
      top = Math.min(top, y); bottom = Math.max(bottom, y); left = Math.min(left, x); right = Math.max(right, x);
    }
    if (bottom < 0) { errors.push(`${where}: 완전히 투명한 이미지예요`); continue; }
    const pct = (n: number) => Math.round((n / img.w) * 100);
    if (pct(bottom) < 88 || pct(bottom) > 97) warnings.push(`${where}: 발끝이 ${pct(bottom)}% 높이에 있어요 (권장 92% 근처)`);
    if (pct(top) < 3) warnings.push(`${where}: 위쪽 여백이 거의 없어요 (점프할 때 잘려요)`);
    if (Math.abs(pct((left + right) / 2) - 50) > 12) warnings.push(`${where}: 몸 중심이 가운데에서 많이 벗어나 있어요`);
  }
  return { errors, warnings };
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node scripts/character-check.ts <pack dir>'); process.exit(2); }
  const { errors, warnings } = checkPack(dir);
  for (const w of warnings) console.warn('⚠️ ', w);
  for (const e of errors) console.error('❌', e);
  console.log(errors.length ? `불합격: 오류 ${errors.length}개` : `합격 (경고 ${warnings.length}개)`);
  process.exit(errors.length ? 1 : 0);
}
