// Run: node scripts/pack-check.ts — hostile and broken packs must be rejected without throwing.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { checkPack as check, type Files } from '../src/pack.ts';

// The fixture is the SVG built-in pack; SVG rejection for imports is checked separately below.
const checkPack = (files: Files, o = {}) => check(files, { svg: true, ...o });

const dir = 'public/characters/default/';
const good: Files = Object.fromEntries(readdirSync(dir).filter((f) => !f.startsWith('.')).map((f) => [f, readFileSync(dir + f)]));
const manifest = JSON.parse(good['manifest.json'].toString());
const withManifest = (m: unknown, extra: Files = {}) => ({ ...good, ...extra, 'manifest.json': Buffer.from(JSON.stringify(m)) });
const rejects = async (files: Files, msg: string) => assert.ok((await checkPack(files)).errors.length, msg);

const ok = await checkPack(good);
assert.deepEqual(ok.errors, []);
assert.equal(ok.manifest?.name, '말랑이');

await rejects({ ...good, 'manifest.json': Buffer.from('{not json') }, 'broken JSON');
await rejects(withManifest(null), 'null manifest');
await rejects(withManifest({ ...manifest, poses: { idle: 'idle.svg' } }), 'poses not arrays');
await rejects(withManifest({ ...manifest, poses: { ...manifest.poses, idle: ['../../etc/passwd.png'] } }), 'path traversal');
await rejects(withManifest({ ...manifest, speed: 1e9 }), 'absurd speed');
await rejects(withManifest({ ...manifest, name: 'x'.repeat(200) }), 'long name');
await rejects({ ...good, 'big.png': new Uint8Array(5 * 1024 * 1024) }, 'oversized pack');

// PNG header claiming a huge canvas must be refused before decoding
const huge = Buffer.alloc(40);
huge.writeUInt32BE(0x89504e47, 0);
huge.writeUInt32BE(30000, 16);
huge.writeUInt32BE(30000, 20);
await rejects(withManifest({ ...manifest, poses: { ...manifest.poses, idle: ['huge.png'] } }, { 'huge.png': huge }), 'huge PNG');
// truncated RGBA PNG
huge.writeUInt32BE(64, 16);
huge.writeUInt32BE(64, 20);
huge[24] = 8;
huge[25] = 6;
await rejects(withManifest({ ...manifest, poses: { ...manifest.poses, idle: ['cut.png'] } }, { 'cut.png': huge }), 'truncated PNG');

// decompression bomb: a ~1MB IDAT claiming a 64×64 image inflates to 64MB
const ihdr = (w: number, interlace = 0) => {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(w, 20);
  b[24] = 8; b[25] = 6; b[28] = interlace;
  return b;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
};
const bomb = Buffer.concat([ihdr(64), chunk('IDAT', deflateSync(Buffer.alloc(64 * 1024 * 1024)))]);
const t0 = Date.now();
const r = await checkPack(withManifest({ ...manifest, poses: { ...manifest.poses, idle: ['bomb.png'] } }, { 'bomb.png': bomb }));
assert.ok(r.errors.some((e) => e.includes('이미지 크기보다')), 'bomb must stop at the image size: ' + r.errors.join(', '));
assert.ok(Date.now() - t0 < 2000, 'bomb must be cut off early');
await rejects(withManifest({ ...manifest, poses: { ...manifest.poses, idle: ['il.png'] } }, { 'il.png': ihdr(64, 1) }), 'interlaced PNG');
const noData = await checkPack(withManifest({ ...manifest, poses: { ...manifest.poses, idle: ['nd.png'] } }, { 'nd.png': ihdr(64) }));
assert.ok(noData.errors.some((e) => e.includes('잘못됐어요')), 'empty IDAT gets a readable error: ' + noData.errors.join(', '));
await rejects(withManifest({ ...manifest, poses: { ...manifest.poses, idle: Array(9).fill('idle.svg') } }), 'too many frames');
await rejects(withManifest({ ...manifest, poses: { ...manifest.poses, ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`x${i}`, ['idle.svg']])) } }), 'too many poses');
assert.ok((await check(good)).errors.some((e) => e.includes('PNG만')), 'imports must be PNG only');

// pack authors see every error; received packs stop at the first one
const opaque = Buffer.concat([ihdr(64), chunk('IDAT', deflateSync(Buffer.alloc((64 * 4 + 1) * 64, 0xff)))]);
const many = withManifest({ ...manifest, name: 'x'.repeat(21), poses: { ...manifest.poses, idle: ['o1.png', 'o2.png', 'o3.png'] } },
  { 'o1.png': opaque, 'o2.png': opaque, 'o3.png': opaque });
assert.equal((await checkPack(many)).errors.length, 1, 'default stops before decoding');
assert.equal((await checkPack(many, { all: true })).errors.filter((e) => e.includes('투명하지')).length, 3, 'all checks every frame');

console.log('pack ok');
