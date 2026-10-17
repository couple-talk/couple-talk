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
const BLOB_MAX = 64 * 1024;
// Character packs are images, so they get their own larger cap and a small per-room store.
const PACK_MAX = 8 * 1024 * 1024;
const PACKS_PER_ROOM = 4;
// Signals (presence heartbeats, read marks) are relayed live and never stored, so they get their own small cap and budget.
const SIGNAL_MAX = 4 * 1024;
const SIGNALS_PER_MIN = 120;
// ponytail: global cap on new rooms stops disk-filling spam but also blocks real sign-ups during an attack; per-IP limits need trusted proxy headers.
const NEW_ROOMS_PER_HOUR = Number(process.env.NEW_ROOMS_PER_HOUR ?? 50);

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, token_hash BLOB NOT NULL, mode TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, sender TEXT NOT NULL, ts INTEGER NOT NULL, blob TEXT NOT NULL,
    receipt TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS messages_room ON messages (room_id, id);
  CREATE TABLE IF NOT EXISTS packs (
    room_id TEXT NOT NULL, sender TEXT NOT NULL, hash TEXT NOT NULL, ts INTEGER NOT NULL, blob TEXT NOT NULL,
    PRIMARY KEY (room_id, sender));
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
  putPack: db.prepare('INSERT OR REPLACE INTO packs (room_id, sender, hash, ts, blob) VALUES (?, ?, ?, ?, ?)'),
  prunePacks: db.prepare(`DELETE FROM packs WHERE room_id = ? AND rowid NOT IN
    (SELECT rowid FROM packs WHERE room_id = ? ORDER BY ts DESC LIMIT ${PACKS_PER_ROOM})`),
  getPack: db.prepare('SELECT sender, blob FROM packs WHERE room_id = ? AND hash = ?'),
  delPack: db.prepare('DELETE FROM packs WHERE room_id = ? AND hash = ?'),
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

/** Per-socket, per-minute budget; `kind` keeps signals from eating into the message budget. */
function limited(ws, kind = 'send', max = MSG_PER_MIN) {
  const now = Date.now();
  const w = (ws.windows ??= {});
  if (now - (w[kind]?.start ?? 0) > 60_000) w[kind] = { start: now, n: 0 };
  return ++w[kind].n > max;
}

function handle(ws, m) {
  if (!ws.roomId) return m.op === 'auth' ? auth(ws, m) : 'auth first';
  if (m.op === 'send') {
    // receipt = sha256 of a nonce sealed inside the blob; only someone who decrypted it can later prove delivery.
    if (typeof m.blob !== 'string' || m.blob.length > BLOB_MAX || !ID_RE.test(m.receipt)) return 'bad request';
    if (limited(ws)) return 'rate limited';
    const now = Date.now();
    const { id } = q.add.get(ws.roomId, ws.device, now, m.blob, m.receipt);
    const out = JSON.stringify({ op: 'msg', id, ts: now, blob: m.blob });
    for (const peer of rooms.get(ws.roomId)) peer.send(out);
  } else if (m.op === 'put') {
    // Content-addressed: the hash is checked here, so a client can't store a blob under someone else's hash.
    if (typeof m.blob !== 'string' || m.blob.length > PACK_MAX || m.hash !== sha256b64(m.blob)) return 'bad request';
    if (limited(ws)) return 'rate limited';
    q.putPack.run(ws.roomId, ws.device, m.hash, Date.now(), m.blob);
    q.prunePacks.run(ws.roomId, ws.roomId);
    ws.send(JSON.stringify({ op: 'stored', hash: m.hash }));
  } else if (m.op === 'get') {
    if (!ID_RE.test(m.hash)) return 'bad request';
    const row = q.getPack.get(ws.roomId, m.hash);
    ws.send(JSON.stringify({ op: 'pack', hash: m.hash, blob: row?.blob ?? null }));
    // local mode keeps nothing once the partner has it
    if (row && ws.mode === 'local' && row.sender !== ws.device) q.delPack.run(ws.roomId, m.hash);
  } else if (m.op === 'signal') {
    // Sealed like a message, so the relay can't tell a heartbeat from a read mark. Only peers online right now get it.
    if (typeof m.blob !== 'string' || m.blob.length > SIGNAL_MAX) return 'bad request';
    // Dropped silently: an error reply would also fail the client's pending pack put/get.
    if (limited(ws, 'signal', SIGNALS_PER_MIN)) return;
    const out = JSON.stringify({ op: 'signal', blob: m.blob });
    for (const peer of rooms.get(ws.roomId)) if (peer !== ws) peer.send(out);
  } else if (m.op === 'ack') {
    if (ws.mode === 'local' && typeof m.receipt === 'string') q.ack.run(ws.roomId, Number(m.id) || 0, ws.device, sha256b64(m.receipt));
  } else return 'unknown op';
}

const wss = new WebSocketServer({ port: PORT, maxPayload: PACK_MAX + 1024 });
wss.on('error', console.error);
// Cloudflare drops WebSockets idle for ~100s, and half-open sockets otherwise linger in `rooms`.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.alive === false) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 30_000).unref();
wss.on('connection', (ws) => {
  ws.on('pong', () => { ws.alive = true; });
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
