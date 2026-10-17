// Run: node scripts/crypto-check.ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deriveRoom, open, randomId, receiptOf, seal, unwrapSecret, wrapSecret } from '../src/crypto.ts';

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

const big = { data: 'x'.repeat(5 * 1024 * 1024) };
assert.deepEqual(await open(a.key, await seal(a.key, big)), big, 'pack-sized payloads must round-trip');

const other = await deriveRoom(crypto.getRandomValues(new Uint8Array(32)));
await assert.rejects(open(other.key, blob));

const wrapped = await wrapSecret(secret, '1234');
assert.deepEqual(await unwrapSecret(wrapped, '1234'), secret);
await assert.rejects(unwrapSecret(wrapped, '0000'));

const pepper = crypto.getRandomValues(new Uint8Array(32));
const peppered = await wrapSecret(secret, '1234', pepper);
assert.deepEqual(await unwrapSecret(peppered, '1234', pepper), secret);
await assert.rejects(unwrapSecret(peppered, '1234'), 'copied storage without the keychain key must not unwrap');

const nonce = randomId();
assert.equal(await receiptOf(nonce), createHash('sha256').update(nonce).digest('base64url'));

console.log('crypto ok');
