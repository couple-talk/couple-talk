// Run: node scripts/protocol-check.ts
// Payload validation guards rendering against a partner's client (or a tampered history), so it is checked here.
import assert from 'node:assert/strict';
import { formatPairingCode, IMAGE_FILE_MAX, IMAGE_MAX_SIDE, isImageFile, isSignal, isValid, parsePairingCode, sentBy, STATUS_TEXT_MAX } from '../src/protocol.ts';

const hash = 'a'.repeat(43);
const image = { v: 1, from: 'me', type: 'image', file: hash, w: 1280, h: 960 };
assert.ok(isValid(image));
assert.ok(isValid({ ...image, sticker: true }));
assert.ok(!isValid({ ...image, file: 'short' }), 'file must be a base64url sha256');
assert.ok(!isValid({ ...image, w: 0 }));
assert.ok(!isValid({ ...image, h: IMAGE_MAX_SIDE + 1 }), 'a huge placeholder could freeze the window');
assert.ok(!isValid({ ...image, w: 1.5 }));
assert.ok(!isValid({ ...image, sticker: 'yes' }));
assert.ok(isValid({ v: 1, from: 'me', type: 'chat', text: 'hi' }), 'existing types still pass');
assert.ok(!isValid({ v: 1, from: 'me', type: 'video', file: hash }), 'unknown types are rejected');

// Made-up statuses (#12): any emoji and phrase within the caps, and only a pack's status poses.
const status = { v: 1, from: 'me', type: 'status', emoji: '🚌', text: '외근 중' };
assert.ok(isValid(status));
assert.ok(isValid({ ...status, pose: 'status_busy' }));
assert.ok(!isValid({ ...status, pose: 'heart_send' }), 'only status poses, so a status cannot trigger a reaction pose');
assert.ok(!isValid({ ...status, text: '가'.repeat(STATUS_TEXT_MAX + 1) }));
assert.ok(!isValid({ ...status, emoji: '🚌'.repeat(10) }));

assert.ok(isImageFile({ mime: 'image/jpeg', data: 'abc' }));
assert.ok(isImageFile({ mime: 'image/png', data: '' }));
assert.ok(!isImageFile({ mime: 'image/svg+xml', data: 'abc' }), 'only formats that cannot carry scripts');
assert.ok(!isImageFile({ mime: 'image/jpeg', data: 'x'.repeat(IMAGE_FILE_MAX + 1) }));
assert.ok(!isImageFile({ mime: 'image/jpeg' }));
assert.ok(!isImageFile(null));

// Person ids (#7): the id decides when present, so two people with one nickname are told apart.
const me = { person: 'm'.repeat(43), nicks: ['곰', '곰돌이'] };
assert.ok(sentBy({ from: '토끼', p: me.person }, me), 'my other PC, renamed there');
assert.ok(!sentBy({ from: '곰', p: 'x'.repeat(43) }, me), 'partner using my nickname');
assert.ok(sentBy({ from: '곰돌이' }, me), 'no id (older app, old message): my past nickname');
assert.ok(!sentBy({ from: '토끼' }, me));
assert.ok(isValid({ v: 1, from: 'me', p: me.person, type: 'chat', text: 'hi' }));
assert.ok(!isValid({ v: 1, from: 'me', p: 'short', type: 'chat', text: 'hi' }), 'p must look like a randomId');
assert.ok(!isValid({ v: 1, from: 'me', p: 1, type: 'chat', text: 'hi' }));
assert.ok(isSignal({ v: 1, type: 'here', from: 'me', p: me.person, read: 0 }));
assert.ok(!isSignal({ v: 1, type: 'here', from: 'me', p: 'short', read: 0 }));
assert.ok(isSignal({ v: 1, type: 'here', from: 'me', read: 0, away: true }), 'away (#12) rides on the heartbeat');
assert.ok(!isSignal({ v: 1, type: 'here', from: 'me', read: 0, away: 'yes' }));

// Pairing codes: older apps read only the first three fields, so those must keep their meaning.
const secret = 's'.repeat(43), partnerCode = { server: 'wss://x', secret, mode: 'server' as const };
assert.deepEqual(parsePairingCode(`wss://x#${secret}#server`), partnerCode, 'partner code and pre-#7 codes');
assert.deepEqual(parsePairingCode(`  wss://x#${secret}#local\n`), { ...partnerCode, mode: 'local' });
assert.deepEqual(parsePairingCode(formatPairingCode(partnerCode)), partnerCode);
const mine = { ...partnerCode, person: me.person, nicks: ['곰', '#1 곰돌이', 'a%b'] };
assert.deepEqual(parsePairingCode(formatPairingCode(mine)), mine, 'nicknames may hold # and %');
assert.ok(!formatPairingCode(mine).split('#')[4].includes('#'));
assert.deepEqual(parsePairingCode(`wss://x#${secret}#server#${me.person}`), { ...partnerCode, person: me.person }, 'id without nicknames');
const many = Array.from({ length: 51 }, (_, i) => `곰${i}`);
assert.deepEqual(parsePairingCode(formatPairingCode({ ...partnerCode, person: me.person, nicks: many })),
  { ...partnerCode, person: me.person, nicks: many.slice(0, 50) }, 'a code made after 51+ names still joins');
for (const bad of [`wss://x#${secret}#chat`, `#${secret}#server`, `wss://x##server`, `wss://x#short#server`,
  `wss://x#${secret}#server#short`, `wss://x#${secret}#server#`, `wss://x#${secret}#server#${me.person}#a#b`,
  `wss://x#${secret}#server#${me.person}#%E0`, `wss://x#${secret}#server#${me.person}#{}`,
  `wss://x#${secret}#server#${me.person}#${encodeURIComponent(JSON.stringify(['x'.repeat(21)]))}`,
  `wss://x#${secret}#server#${me.person}#${encodeURIComponent(JSON.stringify([' ']))}`,
  `wss://x#${secret}#server#${me.person}#${encodeURIComponent(JSON.stringify([1]))}`,
  `wss://x#${secret}#server#${me.person}#${encodeURIComponent(JSON.stringify(many))}`])
  assert.equal(parsePairingCode(bad), null, bad);

console.log('protocol ok');
