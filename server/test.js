// Spawns the relay on a temp db and checks auth, broadcast, history and local-mode ack.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';

const PORT = 18080;
const srv = spawn('node', ['server.js'], {
  env: { ...process.env, PORT, DB_PATH: join(mkdtempSync(join(tmpdir(), 'ct-')), 'test.db') },
  stdio: 'inherit',
});
await new Promise((r) => setTimeout(r, 500));

const id = () => randomBytes(32).toString('base64url');
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
  a.put({ op: 'send', blob: 'CIPHER1' });
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
  la.put({ op: 'send', blob: 'L1' });
  await la.next();
  la.put({ op: 'ack', id: 999 }); // sender's own ack must not delete
  const lb = await client({ ...lroom, device: devB });
  const pending = (await lb.next()).items;
  assert.deepEqual(pending.map((m) => m.blob), ['L1']);
  lb.put({ op: 'ack', id: pending[0].id });
  await new Promise((r) => setTimeout(r, 100));
  const lb2 = await client({ ...lroom, device: devB });
  assert.deepEqual((await lb2.next()).items, []);

  console.log('server ok');
  for (const ws of [a, b, c, la, lb, lb2]) ws.close();
} finally {
  srv.kill();
}
