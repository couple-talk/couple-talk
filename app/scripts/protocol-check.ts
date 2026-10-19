// Run: node scripts/protocol-check.ts
// Payload validation guards rendering against a partner's client (or a tampered history), so it is checked here.
import assert from 'node:assert/strict';
import { IMAGE_FILE_MAX, IMAGE_MAX_SIDE, isImageFile, isValid } from '../src/protocol.ts';

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

assert.ok(isImageFile({ mime: 'image/jpeg', data: 'abc' }));
assert.ok(isImageFile({ mime: 'image/png', data: '' }));
assert.ok(!isImageFile({ mime: 'image/svg+xml', data: 'abc' }), 'only formats that cannot carry scripts');
assert.ok(!isImageFile({ mime: 'image/jpeg', data: 'x'.repeat(IMAGE_FILE_MAX + 1) }));
assert.ok(!isImageFile({ mime: 'image/jpeg' }));
assert.ok(!isImageFile(null));

console.log('protocol ok');
