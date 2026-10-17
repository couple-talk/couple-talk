// Run: node scripts/pack-check.ts — hostile and broken packs must be rejected without throwing.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { checkPack, type Files } from '../src/pack.ts';

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

console.log('pack ok');
