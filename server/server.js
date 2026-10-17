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
// They arrive in parts so maxPayload (which also applies before auth) stays small.
const PACK_MAX = 8 * 1024 * 1024;
const PACK_PART = 192 * 1024;
const PACKS_PER_ROOM = 4;
// A client that requests packs but never reads its socket would otherwise grow our send buffer without bound.
const SEND_BUFFER_MAX = 16 * 1024 * 1024;
// Unfinished uploads are held in memory, so they are capped across all sockets and dropped when they stall.
const UPLOADS_MAX = Number(process.env.UPLOADS_MAX ?? 128 * 1024 * 1024);
const UPLOAD_IDLE_MS = Number(process.env.UPLOAD_IDLE_MS ?? 30_000);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 30_000);
let uploading = 0;
const dropUpload = (ws) => { if (ws.upload) { uploading -= ws.upload.size; ws.upload = null; } };
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
  expire: db.prepare(`DELETE FROM messages WHERE ts < ? AND room_id IN (SELECT id FROM rooms WHERE mode = 'local')`),
  // ponytail: server-mode packs are kept (bounded per room) so a new PC can restore them; add a TTL if spam rooms fill the disk.
  expirePacks: db.prepare(`DELETE FROM packs WHERE ts < ? AND room_id IN (SELECT id FROM rooms WHERE mode = 'local')`),
};
const expire = () => { q.expire.run(Date.now() - LOCAL_TTL_MS); q.expirePacks.run(Date.now() - LOCAL_TTL_MS); };
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
  // packs: version of the pack upload protocol (2 = ordered parts). Clients check it before uploading.
  ws.send(JSON.stringify({ op: 'ready', v: 1, mode: room.mode, items, packs: 2 }));
}

function limited(ws) {
  const now = Date.now();
  if (now - (ws.windowStart ?? 0) > 60_000) Object.assign(ws, { windowStart: now, sent: 0 });
  return ++ws.sent > MSG_PER_MIN;
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
    // Parts must arrive in order on one socket: {hash, part: 0..parts-1, parts, data}.
    const held = ws.upload && Date.now() - ws.upload.at < UPLOAD_IDLE_MS ? ws.upload : null;
    dropUpload(ws);
    const up = m.part === 0 ? { hash: m.hash, chunks: [], size: 0 } : held;
    if (!ID_RE.test(m.hash) || typeof m.data !== 'string' || m.data.length > PACK_PART || !Number.isInteger(m.parts)
      || m.parts < 1 || m.parts > Math.ceil(PACK_MAX / PACK_PART) || up?.hash !== m.hash || m.part !== up.chunks.length) return 'bad request';
    if (up.size + m.data.length > PACK_MAX) return 'bad request';
    if (uploading + up.size + m.data.length > UPLOADS_MAX) return 'busy';
    up.chunks.push(m.data);
    up.size += m.data.length;
    up.at = Date.now();
    if (m.part < m.parts - 1) { ws.upload = up; uploading += up.size; return; }
    const blob = up.chunks.join('');
    // Content-addressed: the hash is checked here, so a client can't store a blob under someone else's hash.
    if (m.hash !== sha256b64(blob)) return 'bad request';
    if (limited(ws)) return 'rate limited';
    q.putPack.run(ws.roomId, ws.device, m.hash, Date.now(), blob);
    q.prunePacks.run(ws.roomId, ws.roomId);
    ws.send(JSON.stringify({ op: 'stored', hash: m.hash }));
  } else if (m.op === 'get') {
    if (!ID_RE.test(m.hash)) return 'bad request';
    if (limited(ws)) return 'rate limited';
    if (ws.bufferedAmount > SEND_BUFFER_MAX) return 'busy';
    const row = q.getPack.get(ws.roomId, m.hash);
    ws.send(JSON.stringify({ op: 'pack', hash: m.hash, blob: row?.blob ?? null }));
  } else if (m.op === 'ack') {
    if (ws.mode === 'local' && typeof m.receipt === 'string') q.ack.run(ws.roomId, Number(m.id) || 0, ws.device, sha256b64(m.receipt));
  } else return 'unknown op';
}

const wss = new WebSocketServer({ port: PORT, maxPayload: PACK_PART + 1024 });
wss.on('error', console.error);
// Cloudflare drops WebSockets idle for ~100s, and half-open sockets otherwise linger in `rooms`.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.alive === false) { ws.terminate(); continue; }
    // A socket that stops mid-upload stays alive on pongs, so release its bytes here too.
    if (ws.upload && Date.now() - ws.upload.at >= UPLOAD_IDLE_MS) dropUpload(ws);
    ws.alive = false;
    ws.ping();
  }
}, HEARTBEAT_MS).unref();
wss.on('connection', (ws) => {
  ws.on('pong', () => { ws.alive = true; });
  // Oversized or malformed frames emit 'error'; without a listener they crash the process.
  ws.on('error', () => ws.terminate());
  ws.on('message', (data) => {
    let err, m;
    try { m = JSON.parse(data); err = handle(ws, m); } catch { err = 'bad request'; }
    // Echo the hash so a client can tell which pack request failed.
    const hash = typeof m?.hash === 'string' ? m.hash : undefined;
    if (err) { ws.send(JSON.stringify({ op: 'error', error: err, hash })); if (!ws.roomId) ws.close(); }
  });
  ws.on('close', () => {
    dropUpload(ws);
    const set = rooms.get(ws.roomId);
    if (set?.delete(ws) && set.size === 0) rooms.delete(ws.roomId);
  });
});
console.log(`couple-talk relay on :${PORT}, db=${DB_PATH}`);
