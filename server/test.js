// Spawns the relay on a temp db and checks auth, broadcast, history and local-mode ack.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import WebSocket from 'ws';

const PORT = 18080;
const DB_PATH = join(mkdtempSync(join(tmpdir(), 'ct-')), 'test.db');
// start from the pre-receipt schema to cover the migration
new DatabaseSync(DB_PATH).exec(`CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, sender TEXT NOT NULL, ts INTEGER NOT NULL, blob TEXT NOT NULL)`);
const srv = spawn('node', ['server.js'], {
  env: { ...process.env, PORT, DB_PATH },
  stdio: 'inherit',
});
await new Promise((r) => setTimeout(r, 500));

const id = () => randomBytes(32).toString('base64url');
const receiptOf = (n) => createHash('sha256').update(n).digest('base64url');
function client(auth) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const queue = [], waiters = [];
  ws.on('message', (d) => { const m = JSON.parse(d); waiters.length ? waiters.shift()(m) : queue.push(m); });
  ws.next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r));
  ws.put = (m) => ws.send(JSON.stringify(m));
  return new Promise((r) => ws.on('open', () => { ws.put({ op: 'auth', v: 1, ...auth }); r(ws); }));
}

try {
  // server mode: history + broadcast
  const room = { roomId: id(), token: id() };
  const a = await client({ ...room, device: id() });
  assert.deepEqual((await a.next()).items, []);
  const b = await client({ ...room, device: id() });
  await b.next();
  a.put({ op: 'send', blob: 'CIPHER1', receipt: receiptOf(id()) });
  assert.equal((await a.next()).blob, 'CIPHER1');
  assert.equal((await b.next()).blob, 'CIPHER1');

  const wrong = await client({ ...room, token: id(), device: id() });
  assert.equal((await wrong.next()).error, 'unauthorized');

  const c = await client({ ...room, device: id() });
  assert.deepEqual((await c.next()).items.map((m) => m.blob), ['CIPHER1']);

  // local mode: undelivered kept, acked deleted
  const lroom = { roomId: id(), token: id(), mode: 'local' };
  const devA = id(), devB = id();
  const la = await client({ ...lroom, device: devA });
  assert.equal((await la.next()).mode, 'local');
  const nonce = id();
  la.put({ op: 'send', blob: 'L1', receipt: receiptOf(nonce) });
  const sent = await la.next();
  la.put({ op: 'ack', id: sent.id, receipt: nonce }); // sender's own ack must not delete
  // someone holding only the token (e.g. a TLS-inspecting proxy) can't forge the receipt
  const intruder = await client({ ...lroom, device: id() });
  await intruder.next();
  intruder.put({ op: 'ack', id: sent.id, receipt: id() });
  await new Promise((r) => setTimeout(r, 100));
  const lb = await client({ ...lroom, device: devB });
  const pending = (await lb.next()).items;
  assert.deepEqual(pending.map((m) => m.blob), ['L1']);
  lb.put({ op: 'ack', id: pending[0].id, receipt: nonce });
  await new Promise((r) => setTimeout(r, 100));
  const lb2 = await client({ ...lroom, device: devB });
  assert.deepEqual((await lb2.next()).items, []);

  // oversized frame must not take the relay down
  const big = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise((r) => big.on('open', r));
  big.send('x'.repeat(300 * 1024));
  await new Promise((r) => big.on('close', r));
  const alive = await client({ roomId: id(), token: id(), device: id() });
  assert.equal((await alive.next()).op, 'ready');
  alive.close();

  // character packs: uploaded in ordered parts, content-addressed, room-scoped
  const sha = (s) => createHash('sha256').update(s).digest('base64url');
  const PART = 192 * 1024;
  const upload = (ws, hash, blob, parts = Math.ceil(blob.length / PART)) => {
    for (let i = 0; i < parts; i++) ws.put({ op: 'put', hash, part: i, parts, data: blob.slice(i * PART, (i + 1) * PART) });
  };
  const pa = await client({ ...room, device: id() });
  await pa.next();
  const pack = 'P'.repeat(500 * 1024);
  upload(pa, id(), pack);
  assert.equal((await pa.next()).error, 'bad request', 'hash must match blob');
  upload(pa, sha(pack), pack);
  assert.deepEqual(await pa.next(), { op: 'stored', hash: sha(pack) });
  pa.put({ op: 'put', hash: sha(pack), part: 1, parts: 3, data: 'x' });
  assert.deepEqual(await pa.next(), { op: 'error', error: 'bad request', hash: sha(pack) }, 'parts must start at 0');
  pa.put({ op: 'send', blob: 'Q'.repeat(100 * 1024), receipt: receiptOf(id()) });
  assert.equal((await pa.next()).error, 'bad request', 'chat blobs stay small');
  const pb = await client({ ...room, device: id() });
  await pb.next();
  pb.put({ op: 'get', hash: sha(pack) });
  assert.equal((await pb.next()).blob, pack);
  pb.put({ op: 'get', hash: sha(pack) });
  assert.equal((await pb.next()).blob, pack, 'fetching again still works (other PCs, failed validation)');
  const other = await client({ roomId: id(), token: id(), device: id() });
  await other.next();
  other.put({ op: 'get', hash: sha(pack) });
  assert.equal((await other.next()).blob, null, 'packs are room-scoped');
  for (const ws of [pa, pb, other]) ws.close();

  // per-socket send rate limit
  const spam = await client({ roomId: id(), token: id(), device: id() });
  await spam.next();
  for (let i = 0; i < 61; i++) spam.put({ op: 'send', blob: 'S', receipt: receiptOf(id()) });
  const replies = [];
  for (let i = 0; i < 61; i++) replies.push(await spam.next());
  assert.equal(replies.at(-1).error, 'rate limited');
  spam.close();

  console.log('server ok');
  for (const ws of [a, b, c, la, intruder, lb, lb2]) ws.close();
} finally {
  srv.kill();
}
