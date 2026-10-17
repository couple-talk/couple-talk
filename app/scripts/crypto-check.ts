// Run: node scripts/crypto-check.ts
import assert from 'node:assert/strict';
import { deriveRoom, open, seal, unwrapSecret, wrapSecret } from '../src/crypto.ts';

const secret = crypto.getRandomValues(new Uint8Array(32));
const a = await deriveRoom(secret);
const b = await deriveRoom(secret);
assert.equal(a.roomId, b.roomId);
assert.equal(a.token, b.token);
assert.notEqual(a.roomId, a.token);

const msg = { v: 1, type: 'chat', text: '사랑해 🥰' };
const blob = await seal(a.key, msg);
assert.ok(!blob.includes('사랑해'));
assert.deepEqual(await open(b.key, blob), msg);
assert.notEqual(blob, await seal(a.key, msg), 'IV must be random');

const other = await deriveRoom(crypto.getRandomValues(new Uint8Array(32)));
await assert.rejects(open(other.key, blob));

const wrapped = await wrapSecret(secret, '1234');
assert.deepEqual(await unwrapSecret(wrapped, '1234'), secret);
await assert.rejects(unwrapSecret(wrapped, '0000'));

console.log('crypto ok');
