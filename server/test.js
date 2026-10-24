// Spawns the relay on a temp db and checks auth, broadcast, history, local-mode ack, signal relay and crash handling.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import WebSocket from 'ws';

const PORT = 18080;
const METRICS_PORT = 18081;
const DIR = mkdtempSync(join(tmpdir(), 'ct-'));
const DB_PATH = join(DIR, 'test.db');
// start from the pre-receipt schema to cover the migration
new DatabaseSync(DB_PATH).exec(`CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, sender TEXT NOT NULL, ts INTEGER NOT NULL, blob TEXT NOT NULL)`);
const srv = spawn('node', ['server.js'], {
  // Small upload budget and fast heartbeat so the stalled-upload case runs in under a second.
  // FILE_ROOM_MAX small enough that a few 150KB photos overflow a room's budget. EXPIRE_MS so the hourly sweep runs here.
  env: { ...process.env, PORT, METRICS_PORT, DB_PATH, UPLOADS_MAX: 550 * 1024, UPLOAD_IDLE_MS: 300, HEARTBEAT_MS: 100, FILE_ROOM_MAX: 400 * 1024, EXPIRE_MS: 100 },
  stdio: 'inherit',
});
// A fixed wait lost the race on a slow CI runner (ECONNREFUSED); poll until the relay answers.
// Each try times out: a process that accepts but never answers would otherwise hang the first fetch for minutes.
for (let t = Date.now(); !(await fetch(`http://localhost:${PORT}/healthz`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false));) {
  // A relay that died (e.g. EADDRINUSE) fails at once; another process on PORT could otherwise answer for it.
  if (srv.exitCode !== null || srv.signalCode) throw new Error(`relay exited (${srv.exitCode ?? srv.signalCode}); is port ${PORT} in use?`);
  if (Date.now() - t > 10_000) { srv.kill(); throw new Error('relay did not start'); }
  await new Promise((r) => setTimeout(r, 50));
}

const id = () => randomBytes(32).toString('base64url');
const receiptOf = (n) => createHash('sha256').update(n).digest('base64url');
function client(auth) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const queue = [], waiters = [];
  ws.on('message', (d) => { const m = JSON.parse(d); waiters.length ? waiters.shift()(m) : queue.push(m); });
  ws.next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r));
  // Waits a moment and takes a queued message if one came, without leaving a waiter behind.
  ws.quiet = async () => { await new Promise((r) => setTimeout(r, 150)); return queue.length ? queue.shift() : 'quiet'; };
  ws.put = (m) => ws.send(JSON.stringify(m));
  return new Promise((r) => ws.on('open', () => { ws.put({ op: 'auth', v: 1, ...auth }); r(ws); }));
}

try {
  // a relay that can't take its port must exit so the restart policy and health check notice, not idle on metrics
  const dup = spawn('node', ['server.js'], { env: { ...process.env, PORT, METRICS_PORT: 18082, DB_PATH: join(DIR, 'dup.db') }, stdio: 'ignore' });
  const code = await Promise.race([new Promise((r) => dup.on('exit', r)), new Promise((r) => setTimeout(r, 3000, 'still running'))]);
  dup.kill();
  assert.ok(Number.isInteger(code) && code !== 0, `a port conflict exits non-zero (got ${code})`);

  // server mode: history + broadcast
  const room = { roomId: id(), token: id() };
  const a = await client({ ...room, device: id() });
  const ready = await a.next();
  assert.deepEqual(ready.items, []);
  assert.equal(ready.packs, 2, 'ready advertises the pack upload protocol');
  assert.equal(ready.signals, 1, 'ready advertises signal relaying');
  assert.equal(ready.files, 1, 'ready advertises photo files');
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
  // a stalled upload must not hold the global upload budget
  const sa = await client({ ...room, device: id() });
  await sa.next();
  const sb = await client({ ...room, device: id() });
  await sb.next();
  const stalled = id();
  for (let i = 0; i < 2; i++) sa.put({ op: 'put', hash: stalled, part: i, parts: 3, data: 'A'.repeat(PART) });
  await new Promise((r) => setTimeout(r, 100));
  const small = 'B'.repeat(190 * 1024);
  sb.put({ op: 'put', hash: sha(small), part: 0, parts: 1, data: small });
  assert.equal((await sb.next()).error, 'busy');
  await new Promise((r) => setTimeout(r, 600));
  sb.put({ op: 'put', hash: sha(small), part: 0, parts: 1, data: small });
  assert.deepEqual(await sb.next(), { op: 'stored', hash: sha(small) }, 'stalled upload released by heartbeat');
  for (const ws of [pa, pb, other, sa, sb]) ws.close();

  // photos (#10): a separate, larger blob store with a per-room byte budget
  const uploadFile = (ws, blob, parts = Math.ceil(blob.length / PART)) => {
    for (let i = 0; i < parts; i++) ws.put({ op: 'put', kind: 'file', hash: sha(blob), part: i, parts, data: blob.slice(i * PART, (i + 1) * PART) });
  };
  const fa = await client({ ...room, device: id() });
  await fa.next();
  const fb = await client({ ...room, device: id() });
  await fb.next();
  const photo1 = 'F'.repeat(300 * 1024);
  uploadFile(fa, photo1);
  assert.deepEqual(await fa.next(), { op: 'stored', hash: sha(photo1) }, 'a multi-part photo is stored');
  fb.put({ op: 'get', kind: 'file', hash: sha(photo1) });
  assert.deepEqual(await fb.next(), { op: 'file', hash: sha(photo1), blob: photo1 });
  fb.put({ op: 'get', kind: 'file', hash: sha(photo1) });
  assert.equal((await fb.next()).blob, photo1, 'server rooms keep photos for other PCs');
  fb.put({ op: 'get', hash: sha(photo1) });
  assert.equal((await fb.next()).blob, null, 'photos are not packs');
  fb.put({ op: 'get', kind: 'file', hash: sha(pack) });
  assert.equal((await fb.next()).blob, null, 'packs are not photos');
  fa.put({ op: 'put', kind: 'file', hash: sha(photo1), part: 1, parts: 2, data: 'x' });
  assert.equal((await fa.next()).error, 'bad request', 'a pack upload cannot be continued as a photo');
  fa.put({ op: 'put', kind: 'file', hash: id(), part: 0, parts: 17, data: 'x' });
  assert.equal((await fa.next()).error, 'bad request', 'photos over 3MB are refused up front');
  const photo2 = 'G'.repeat(150 * 1024), photo3 = 'H'.repeat(150 * 1024);
  uploadFile(fa, photo2);
  await fa.next();
  uploadFile(fa, photo3);
  await fa.next();
  fb.put({ op: 'get', kind: 'file', hash: sha(photo1) });
  assert.equal((await fb.next()).blob, null, 'the oldest photo goes when the room budget overflows');
  fb.put({ op: 'get', kind: 'file', hash: sha(photo3) });
  assert.equal((await fb.next()).blob, photo3, 'newer photos stay');
  // scrolling a photo-heavy history must not eat the chat budget
  for (let i = 0; i < 61; i++) fb.put({ op: 'get', kind: 'file', hash: sha(photo3) });
  for (let i = 0; i < 61; i++) await fb.next();
  fb.put({ op: 'send', blob: 'AFTER-PHOTOS', receipt: receiptOf(id()) });
  assert.equal((await fb.next()).blob, 'AFTER-PHOTOS', 'photo fetches have their own rate budget');
  // local rooms: the relay forgets a photo once the other side acks that it stored its copy
  const lf1 = await client({ ...lroom, device: id() });
  await lf1.next();
  const lf2 = await client({ ...lroom, device: id() });
  await lf2.next();
  const lphoto = 'L'.repeat(100 * 1024);
  uploadFile(lf1, lphoto);
  await lf1.next();
  lf2.put({ op: 'get', kind: 'file', hash: sha(lphoto) });
  assert.equal((await lf2.next()).blob, lphoto);
  lf2.put({ op: 'get', kind: 'file', hash: sha(lphoto) });
  assert.equal((await lf2.next()).blob, lphoto, 'fetching alone keeps it (the copy may not have been stored)');
  lf1.put({ op: 'ack', kind: 'file', hash: sha(lphoto) });
  await new Promise((r) => setTimeout(r, 100));
  lf2.put({ op: 'get', kind: 'file', hash: sha(lphoto) });
  assert.equal((await lf2.next()).blob, lphoto, 'the sender acking does not delete');
  lf2.put({ op: 'ack', kind: 'file', hash: sha(lphoto) });
  await new Promise((r) => setTimeout(r, 100));
  lf2.put({ op: 'get', kind: 'file', hash: sha(lphoto) });
  assert.equal((await lf2.next()).blob, null, 'deleted once the other side acked');
  fb.put({ op: 'ack', kind: 'file', hash: sha(photo3) });
  await new Promise((r) => setTimeout(r, 100));
  fb.put({ op: 'get', kind: 'file', hash: sha(photo3) });
  assert.equal((await fb.next()).blob, photo3, 'server rooms ignore file acks');
  for (const ws of [fa, fb, lf1, lf2]) ws.close();

  // per-socket send rate limit
  const spam = await client({ roomId: id(), token: id(), device: id() });
  await spam.next();
  for (let i = 0; i < 61; i++) spam.put({ op: 'send', blob: 'S', receipt: receiptOf(id()) });
  const replies = [];
  for (let i = 0; i < 61; i++) replies.push(await spam.next());
  assert.equal(replies.at(-1).error, 'rate limited');
  spam.close();

  // signals: relayed to the rest of the room only, never stored, with their own budget
  const sroom = { roomId: id(), token: id() };
  const ga = await client({ ...sroom, device: id() });
  await ga.next();
  const gb = await client({ ...sroom, device: id() });
  await gb.next();
  const outsider = await client({ roomId: id(), token: id(), device: id() });
  await outsider.next();
  ga.put({ op: 'signal', blob: 'SIG1' });
  assert.deepEqual(await gb.next(), { op: 'signal', blob: 'SIG1' });
  assert.equal(await ga.quiet(), 'quiet', 'sender does not get its own signal');
  assert.equal(await outsider.quiet(), 'quiet', 'signals are room-scoped');
  const gc = await client({ ...sroom, device: id() });
  assert.deepEqual((await gc.next()).items, [], 'signals are not stored');
  ga.put({ op: 'signal', blob: 'X'.repeat(4 * 1024 + 1) });
  assert.equal((await ga.next()).error, 'bad request', 'signals stay small');
  ga.put({ op: 'signal', blob: 42 });
  assert.equal((await ga.next()).error, 'bad request');
  for (let i = 0; i < 121; i++) ga.put({ op: 'signal', blob: `S${i}` });
  const relayed = [];
  for (let m; (m = await gb.quiet()) !== 'quiet';) relayed.push(m.blob);
  // 120 a minute, and SIG1 above already used one
  assert.equal(relayed.length, 119, 'over-budget signals are dropped');
  assert.equal(await ga.quiet(), 'quiet', 'dropping a signal sends no error');
  ga.put({ op: 'send', blob: 'AFTER', receipt: receiptOf(id()) });
  assert.equal((await ga.next()).blob, 'AFTER', 'signals do not use up the message budget');
  for (const ws of [ga, gb, gc, outsider]) ws.close();

  // health on the public port, metrics only on the internal one
  assert.equal(await (await fetch(`http://localhost:${PORT}/healthz`)).text(), 'ok');
  assert.equal((await fetch(`http://localhost:${PORT}/metrics`)).status, 404);
  const metrics = await (await fetch(`http://localhost:${METRICS_PORT}/metrics`)).text();
  assert.match(metrics, /^couple_talk_rooms [1-9]\d*$/m);
  assert.match(metrics, /^couple_talk_messages_total [1-9]\d*$/m);
  assert.match(metrics, /^couple_talk_connections \d+$/m);
  assert.ok(!/[A-Za-z0-9_-]{43}/.test(metrics), 'no room ids in metrics');

  // a DB failure must not take the relay down through a metrics scrape
  new DatabaseSync(DB_PATH).exec('DROP TABLE rooms');
  assert.equal((await fetch(`http://localhost:${METRICS_PORT}/metrics`)).status, 503);
  assert.equal((await fetch(`http://localhost:${PORT}/healthz`)).status, 503, 'process still up after the failed scrape');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(srv.exitCode, null, 'a failed expiry sweep does not take the relay down');

  console.log('server ok');
  for (const ws of [a, b, c, la, intruder, lb, lb2]) ws.close();
} finally {
  srv.kill();
}
