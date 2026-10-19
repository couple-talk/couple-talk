// Run: node scripts/crypto-check.ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deriveRoom, legacyPerson, open, randomId, receiptOf, seal, unwrapSecret, wrapSecret } from '../src/crypto.ts';

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

// Password change (#4): the same secret and pepper, re-wrapped; the old password must stop working.
const rewrapped = await wrapSecret(await unwrapSecret(peppered, '1234', pepper), 'new-password', pepper);
assert.deepEqual(await unwrapSecret(rewrapped, 'new-password', pepper), secret);
await assert.rejects(unwrapSecret(rewrapped, '1234', pepper), 'the old password must not unwrap after a change');

const nonce = randomId();
assert.equal(await receiptOf(nonce), createHash('sha256').update(nonce).digest('base64url'));

// Two of my PCs set up before #7 must agree on my person id without being linked again.
const person = await legacyPerson(secret, '곰');
assert.equal(person, await legacyPerson(secret, '곰'));
assert.match(person, /^[\w-]{43}$/);
assert.notEqual(person, await legacyPerson(secret, '토끼'));
assert.notEqual(person, await legacyPerson(crypto.getRandomValues(new Uint8Array(32)), '곰'));
assert.notEqual(person, a.roomId, 'unrelated to the ids the relay sees');

console.log('crypto ok');
