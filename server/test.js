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
const METRICS_PORT = 18081;
const DB_PATH = join(mkdtempSync(join(tmpdir(), 'ct-')), 'test.db');
// start from the pre-receipt schema to cover the migration
new DatabaseSync(DB_PATH).exec(`CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, sender TEXT NOT NULL, ts INTEGER NOT NULL, blob TEXT NOT NULL)`);
const srv = spawn('node', ['server.js'], {
  env: { ...process.env, PORT, METRICS_PORT, DB_PATH },
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
  big.send('x'.repeat(9 * 1024 * 1024));
  await new Promise((r) => big.on('close', r));
  const alive = await client({ roomId: id(), token: id(), device: id() });
  assert.equal((await alive.next()).op, 'ready');
  alive.close();

  // character packs: content-addressed, room-scoped, deleted after the partner fetches in local mode
  const sha = (s) => createHash('sha256').update(s).digest('base64url');
  const pa = await client({ ...room, device: id() });
  await pa.next();
  const pack = 'P'.repeat(200 * 1024);
  pa.put({ op: 'put', hash: id(), blob: pack });
  assert.equal((await pa.next()).error, 'bad request', 'hash must match blob');
  pa.put({ op: 'put', hash: sha(pack), blob: pack });
  assert.deepEqual(await pa.next(), { op: 'stored', hash: sha(pack) });
  pa.put({ op: 'send', blob: pack, receipt: receiptOf(id()) });
  assert.equal((await pa.next()).error, 'bad request', 'chat blobs stay small');
  const pb = await client({ ...room, device: id() });
  await pb.next();
  pb.put({ op: 'get', hash: sha(pack) });
  assert.equal((await pb.next()).blob, pack);
  const other = await client({ roomId: id(), token: id(), device: id() });
  await other.next();
  other.put({ op: 'get', hash: sha(pack) });
  assert.equal((await other.next()).blob, null, 'packs are room-scoped');

  const lpa = await client({ ...lroom, device: devA });
  await lpa.next();
  lpa.put({ op: 'put', hash: sha('LP'), blob: 'LP' });
  await lpa.next();
  lpa.put({ op: 'get', hash: sha('LP') });
  assert.equal((await lpa.next()).blob, 'LP', "sender's own fetch keeps it");
  const lpb = await client({ ...lroom, device: devB });
  await lpb.next();
  lpb.put({ op: 'get', hash: sha('LP') });
  assert.equal((await lpb.next()).blob, 'LP');
  lpb.put({ op: 'get', hash: sha('LP') });
  assert.equal((await lpb.next()).blob, null);
  for (const ws of [pa, pb, other, lpa, lpb]) ws.close();

  // per-socket send rate limit
  const spam = await client({ roomId: id(), token: id(), device: id() });
  await spam.next();
  for (let i = 0; i < 61; i++) spam.put({ op: 'send', blob: 'S', receipt: receiptOf(id()) });
  const replies = [];
  for (let i = 0; i < 61; i++) replies.push(await spam.next());
  assert.equal(replies.at(-1).error, 'rate limited');
  spam.close();

  // health on the public port, metrics only on the internal one
  assert.equal(await (await fetch(`http://localhost:${PORT}/healthz`)).text(), 'ok');
  assert.equal((await fetch(`http://localhost:${PORT}/metrics`)).status, 404);
  const metrics = await (await fetch(`http://localhost:${METRICS_PORT}/metrics`)).text();
  assert.match(metrics, /^couple_talk_rooms [1-9]\d*$/m);
  assert.match(metrics, /^couple_talk_messages_total [1-9]\d*$/m);
  assert.match(metrics, /^couple_talk_connections \d+$/m);
  assert.ok(!/[A-Za-z0-9_-]{43}/.test(metrics), 'no room ids in metrics');

  console.log('server ok');
  for (const ws of [a, b, c, la, intruder, lb, lb2]) ws.close();
} finally {
  srv.kill();
}
