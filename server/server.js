// Content-blind relay: stores and forwards opaque encrypted blobs per room.
import { DatabaseSync } from 'node:sqlite';
import { createHash, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8080);
const DB_PATH = process.env.DB_PATH ?? 'data.db';
const LOCAL_TTL_MS = 7 * 24 * 3600 * 1000;
const HISTORY_LIMIT = 500;
const ID_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes base64url
const MSG_PER_MIN = 60;
// ponytail: global cap on new rooms stops disk-filling spam but also blocks real sign-ups during an attack; per-IP limits need trusted proxy headers.
const NEW_ROOMS_PER_HOUR = Number(process.env.NEW_ROOMS_PER_HOUR ?? 50);

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, token_hash BLOB NOT NULL, mode TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, sender TEXT NOT NULL, ts INTEGER NOT NULL, blob TEXT NOT NULL,
    receipt TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS messages_room ON messages (room_id, id);
`);
// Databases created before delivery receipts: old rows get an unmatchable receipt and just expire.
if (!db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'receipt'))
  db.exec(`ALTER TABLE messages ADD COLUMN receipt TEXT NOT NULL DEFAULT ''`);
const q = {
  room: db.prepare('SELECT token_hash, mode FROM rooms WHERE id = ?'),
  addRoom: db.prepare('INSERT INTO rooms (id, token_hash, mode) VALUES (?, ?, ?)'),
  add: db.prepare('INSERT INTO messages (room_id, sender, ts, blob, receipt) VALUES (?, ?, ?, ?, ?) RETURNING id'),
  since: db.prepare('SELECT id, ts, blob FROM messages WHERE room_id = ? AND id > ? ORDER BY id DESC LIMIT ?'),
  pending: db.prepare('SELECT id, ts, blob FROM messages WHERE room_id = ? AND sender != ? ORDER BY id'),
  ack: db.prepare('DELETE FROM messages WHERE room_id = ? AND id = ? AND sender != ? AND receipt = ?'),
  expire: db.prepare(`DELETE FROM messages WHERE ts < ? AND room_id IN (SELECT id FROM rooms WHERE mode = 'local')`),
};
const expire = () => q.expire.run(Date.now() - LOCAL_TTL_MS);
expire();
setInterval(expire, 3600 * 1000).unref();

const sha256 = (s) => createHash('sha256').update(s).digest();
const sha256b64 = (s) => sha256(s).toString('base64url');
const rooms = new Map(); // roomId -> Set<ws>
let newRooms = 0;
setInterval(() => { newRooms = 0; }, 3600 * 1000).unref();

function auth(ws, m) {
  if (m.v !== 1 || !ID_RE.test(m.roomId) || !ID_RE.test(m.token) || !ID_RE.test(m.device)) return 'bad request';
  const hash = sha256(m.token);
  let room = q.room.get(m.roomId);
  if (!room) {
    if (++newRooms > NEW_ROOMS_PER_HOUR) return 'busy';
    const mode = m.mode === 'local' ? 'local' : 'server';
    q.addRoom.run(m.roomId, hash, mode);
    room = { token_hash: hash, mode };
  } else if (!timingSafeEqual(Buffer.from(room.token_hash), hash)) return 'unauthorized';

  Object.assign(ws, { roomId: m.roomId, device: m.device, mode: room.mode });
  if (!rooms.has(m.roomId)) rooms.set(m.roomId, new Set());
  rooms.get(m.roomId).add(ws);
  const items = room.mode === 'local'
    ? q.pending.all(m.roomId, m.device)
    : q.since.all(m.roomId, Number(m.since) || 0, HISTORY_LIMIT).reverse();
  ws.send(JSON.stringify({ op: 'ready', v: 1, mode: room.mode, items }));
}

function handle(ws, m) {
  if (!ws.roomId) return m.op === 'auth' ? auth(ws, m) : 'auth first';
  if (m.op === 'send') {
    // receipt = sha256 of a nonce sealed inside the blob; only someone who decrypted it can later prove delivery.
    if (typeof m.blob !== 'string' || !ID_RE.test(m.receipt)) return 'bad request';
    const now = Date.now();
    if (now - (ws.windowStart ?? 0) > 60_000) Object.assign(ws, { windowStart: now, sent: 0 });
    if (++ws.sent > MSG_PER_MIN) return 'rate limited';
    const { id } = q.add.get(ws.roomId, ws.device, now, m.blob, m.receipt);
    const out = JSON.stringify({ op: 'msg', id, ts: now, blob: m.blob });
    for (const peer of rooms.get(ws.roomId)) peer.send(out);
  } else if (m.op === 'ack') {
    if (ws.mode === 'local' && typeof m.receipt === 'string') q.ack.run(ws.roomId, Number(m.id) || 0, ws.device, sha256b64(m.receipt));
  } else return 'unknown op';
}

const wss = new WebSocketServer({ port: PORT, maxPayload: 64 * 1024 });
wss.on('error', console.error);
wss.on('connection', (ws) => {
  // Oversized or malformed frames emit 'error'; without a listener they crash the process.
  ws.on('error', () => ws.terminate());
  ws.on('message', (data) => {
    let err;
    try { err = handle(ws, JSON.parse(data)); } catch { err = 'bad request'; }
    if (err) { ws.send(JSON.stringify({ op: 'error', error: err })); if (!ws.roomId) ws.close(); }
  });
  ws.on('close', () => {
    const set = rooms.get(ws.roomId);
    if (set?.delete(ws) && set.size === 0) rooms.delete(ws.roomId);
  });
});
console.log(`couple-talk relay on :${PORT}, db=${DB_PATH}`);
