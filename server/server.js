// Content-blind relay: stores and forwards opaque encrypted blobs per room.
import { DatabaseSync } from 'node:sqlite';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8080);
const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9464);
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
// Photos and stickers (#10) use the same part upload with `kind: 'file'`. Each room has a byte budget, oldest out first;
// local rooms also delete a file once the other side has stored it and acked. Scrolling a photo-heavy history fetches
// many files in a minute, so they get their own budget and never block chat sends.
const FILE_MAX = 3 * 1024 * 1024;
const FILE_ROOM_MAX = Number(process.env.FILE_ROOM_MAX ?? 64 * 1024 * 1024);
const FILES_PER_MIN = 120;
// Signals (presence heartbeats, read marks) are relayed live and never stored, so they get their own small cap and budget.
const SIGNAL_MAX = 4 * 1024;
const SIGNALS_PER_MIN = 120;
// A client that requests packs but never reads its socket would otherwise grow our send buffer without bound.
const SEND_BUFFER_MAX = 16 * 1024 * 1024;
// Unfinished uploads are held in memory, so they are capped across all sockets and dropped when they stall.
const UPLOADS_MAX = Number(process.env.UPLOADS_MAX ?? 128 * 1024 * 1024);
const UPLOAD_IDLE_MS = Number(process.env.UPLOAD_IDLE_MS ?? 30_000);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 30_000);
const EXPIRE_MS = Number(process.env.EXPIRE_MS ?? 3600 * 1000);
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
  CREATE TABLE IF NOT EXISTS files (
    room_id TEXT NOT NULL, sender TEXT NOT NULL, hash TEXT NOT NULL, ts INTEGER NOT NULL, size INTEGER NOT NULL, blob TEXT NOT NULL,
    PRIMARY KEY (room_id, hash));
`);
// Databases created before delivery receipts: old rows get an unmatchable receipt and just expire.
if (!db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'receipt'))
  db.exec(`ALTER TABLE messages ADD COLUMN receipt TEXT NOT NULL DEFAULT ''`);
const q = {
  room: db.prepare('SELECT token_hash, mode FROM rooms WHERE id = ?'),
  countRooms: db.prepare('SELECT count(*) AS n FROM rooms'),
  addRoom: db.prepare('INSERT INTO rooms (id, token_hash, mode) VALUES (?, ?, ?)'),
  add: db.prepare('INSERT INTO messages (room_id, sender, ts, blob, receipt) VALUES (?, ?, ?, ?, ?) RETURNING id'),
  since: db.prepare('SELECT id, ts, blob FROM messages WHERE room_id = ? AND id > ? ORDER BY id DESC LIMIT ?'),
  before: db.prepare('SELECT id, ts, blob FROM messages WHERE room_id = ? AND id < ? ORDER BY id DESC LIMIT ?'),
  pending: db.prepare('SELECT id, ts, blob FROM messages WHERE room_id = ? AND sender != ? ORDER BY id'),
  ack: db.prepare('DELETE FROM messages WHERE room_id = ? AND id = ? AND sender != ? AND receipt = ?'),
  putPack: db.prepare('INSERT OR REPLACE INTO packs (room_id, sender, hash, ts, blob) VALUES (?, ?, ?, ?, ?)'),
  prunePacks: db.prepare(`DELETE FROM packs WHERE room_id = ? AND rowid NOT IN
    (SELECT rowid FROM packs WHERE room_id = ? ORDER BY ts DESC LIMIT ${PACKS_PER_ROOM})`),
  getPack: db.prepare('SELECT sender, blob FROM packs WHERE room_id = ? AND hash = ?'),
  expire: db.prepare(`DELETE FROM messages WHERE ts < ? AND room_id IN (SELECT id FROM rooms WHERE mode = 'local')`),
  // ponytail: server-mode packs are kept (bounded per room) so a new PC can restore them; add a TTL if spam rooms fill the disk.
  expirePacks: db.prepare(`DELETE FROM packs WHERE ts < ? AND room_id IN (SELECT id FROM rooms WHERE mode = 'local')`),
  putFile: db.prepare('INSERT OR REPLACE INTO files (room_id, sender, hash, ts, size, blob) VALUES (?, ?, ?, ?, ?, ?)'),
  getFile: db.prepare('SELECT blob FROM files WHERE room_id = ? AND hash = ?'),
  delFile: db.prepare('DELETE FROM files WHERE room_id = ? AND hash = ?'),
  // The other side acking its copy must not let the sender delete its own upload before the partner has it.
  ackFile: db.prepare('DELETE FROM files WHERE room_id = ? AND hash = ? AND sender != ?'),
  // `size` is stored so pruning doesn't read every blob in the room off the disk.
  listFiles: db.prepare('SELECT hash, size FROM files WHERE room_id = ? ORDER BY ts DESC, rowid DESC'),
  expireFiles: db.prepare(`DELETE FROM files WHERE ts < ? AND room_id IN (SELECT id FROM rooms WHERE mode = 'local')`),
};
const expire = () => {
  const before = Date.now() - LOCAL_TTL_MS;
  q.expire.run(before);
  q.expirePacks.run(before);
  q.expireFiles.run(before);
};
/** Keeps a room's files within FILE_ROOM_MAX, newest first. */
function pruneFiles(roomId) {
  let used = 0;
  for (const f of q.listFiles.all(roomId)) if ((used += f.size) > FILE_ROOM_MAX) q.delFile.run(roomId, f.hash);
}
expire(); // at startup a broken db should fail fast
// Later a throw here would kill the relay once an hour; the next sweep retries.
setInterval(() => { try { expire(); } catch (e) { console.error('expire failed:', e.message); } }, EXPIRE_MS).unref();

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
  // signals: the `signal` op is relayed. Older relays answer it with 'unknown op', which fails pending pack transfers.
  // files: put/get accept `kind: 'file'` (photos). Older relays would store a photo as the sender's character pack.
  // history: the `before` op pages through older messages in server rooms (#8).
  ws.send(JSON.stringify({ op: 'ready', v: 1, mode: room.mode, items, packs: 2, signals: 1, files: 1, history: 1 }));
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
    messagesTotal++;
    const out = JSON.stringify({ op: 'msg', id, ts: now, blob: m.blob });
    for (const peer of rooms.get(ws.roomId)) peer.send(out);
  } else if (m.op === 'put') {
    // Parts must arrive in order on one socket: {hash, part: 0..parts-1, parts, data, kind?}.
    const file = m.kind === 'file';
    const max = file ? FILE_MAX : PACK_MAX;
    const held = ws.upload && Date.now() - ws.upload.at < UPLOAD_IDLE_MS ? ws.upload : null;
    dropUpload(ws);
    const up = m.part === 0 ? { hash: m.hash, file, chunks: [], size: 0 } : held;
    if (!ID_RE.test(m.hash) || typeof m.data !== 'string' || m.data.length > PACK_PART || !Number.isInteger(m.parts)
      || m.parts < 1 || m.parts > Math.ceil(max / PACK_PART) || up?.hash !== m.hash || up.file !== file || m.part !== up.chunks.length) return 'bad request';
    if (up.size + m.data.length > max) return 'bad request';
    if (uploading + up.size + m.data.length > UPLOADS_MAX) return 'busy';
    up.chunks.push(m.data);
    up.size += m.data.length;
    up.at = Date.now();
    if (m.part < m.parts - 1) { ws.upload = up; uploading += up.size; return; }
    const blob = up.chunks.join('');
    // Content-addressed: the hash is checked here, so a client can't store a blob under someone else's hash.
    if (m.hash !== sha256b64(blob)) return 'bad request';
    if (file ? limited(ws, 'file', FILES_PER_MIN) : limited(ws)) return 'rate limited';
    if (file) {
      q.putFile.run(ws.roomId, ws.device, m.hash, Date.now(), blob.length, blob);
      pruneFiles(ws.roomId);
    } else {
      q.putPack.run(ws.roomId, ws.device, m.hash, Date.now(), blob);
      q.prunePacks.run(ws.roomId, ws.roomId);
    }
    ws.send(JSON.stringify({ op: 'stored', hash: m.hash }));
  } else if (m.op === 'get') {
    if (!ID_RE.test(m.hash)) return 'bad request';
    if (m.kind === 'file' ? limited(ws, 'file', FILES_PER_MIN) : limited(ws)) return 'rate limited';
    if (ws.bufferedAmount > SEND_BUFFER_MAX) return 'busy';
    if (m.kind === 'file') {
      const row = q.getFile.get(ws.roomId, m.hash);
      ws.send(JSON.stringify({ op: 'file', hash: m.hash, blob: row?.blob ?? null }));
      return;
    }
    const row = q.getPack.get(ws.roomId, m.hash);
    ws.send(JSON.stringify({ op: 'pack', hash: m.hash, blob: row?.blob ?? null }));
  } else if (m.op === 'before') {
    // Scrolling up in server rooms (#8). Local rooms only hold undelivered messages; their history lives on each PC.
    const limit = m.limit ?? HISTORY_LIMIT;
    if (ws.mode !== 'server' || !Number.isInteger(m.before) || !Number.isInteger(limit) || limit < 1 || limit > HISTORY_LIMIT) return 'bad request';
    if (limited(ws, 'history')) return 'rate limited';
    if (ws.bufferedAmount > SEND_BUFFER_MAX) return 'busy';
    ws.send(JSON.stringify({ op: 'older', before: m.before, items: q.before.all(ws.roomId, m.before, limit).reverse() }));
  } else if (m.op === 'signal') {
    // Sealed like a message, so the relay can't tell a heartbeat from a read mark. Only peers online right now get it.
    if (typeof m.blob !== 'string' || m.blob.length > SIGNAL_MAX) return 'bad request';
    // Dropped silently: an error reply would also fail the client's pending pack put/get.
    if (limited(ws, 'signal', SIGNALS_PER_MIN)) return;
    const out = JSON.stringify({ op: 'signal', blob: m.blob });
    for (const peer of rooms.get(ws.roomId)) if (peer !== ws) peer.send(out);
  } else if (m.op === 'ack') {
    if (ws.mode !== 'local') return;
    // "Each PC only": a photo leaves the relay once the other side says it has stored its copy, like an acked message.
    if (m.kind === 'file') { if (ID_RE.test(m.hash)) q.ackFile.run(ws.roomId, m.hash, ws.device); return; }
    if (typeof m.receipt === 'string') q.ack.run(ws.roomId, Number(m.id) || 0, ws.device, sha256b64(m.receipt));
  } else return 'unknown op';
}

// PORT is what the tunnel exposes publicly, so besides WebSockets it only answers a liveness check.
const http = createServer((req, res) => {
  if (req.url !== '/healthz') return res.writeHead(404).end();
  try { q.room.get(''); res.end('ok'); } catch { res.writeHead(503).end('db unavailable'); }
});
let messagesTotal = 0;
// Counts only, never room ids or content. Served on a port that only the internal docker network reaches.
createServer((req, res) => {
  if (req.url !== '/metrics') return res.writeHead(404).end();
  // A throw here would escape the http handler and kill the relay, not just this scrape.
  let roomCount;
  try { roomCount = q.countRooms.get().n; } catch { return res.writeHead(503).end(); }
  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
  res.end([
    '# TYPE couple_talk_connections gauge', `couple_talk_connections ${wss.clients.size}`,
    '# TYPE couple_talk_rooms_online gauge', `couple_talk_rooms_online ${rooms.size}`,
    '# TYPE couple_talk_rooms gauge', `couple_talk_rooms ${roomCount}`,
    '# TYPE couple_talk_messages_total counter', `couple_talk_messages_total ${messagesTotal}`,
  ].join('\n') + '\n');
}).listen(METRICS_PORT);
const wss = new WebSocketServer({ server: http, maxPayload: PACK_PART + 1024 });
// Listen errors (EADDRINUSE) arrive here. Staying up would leave only the metrics port alive and look healthy to docker.
wss.on('error', (e) => { console.error(e); process.exit(1); });
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
    // Echo the hash (or `before`) so a client can tell which pack or history request failed.
    const hash = typeof m?.hash === 'string' ? m.hash : undefined;
    const before = m?.op === 'before' ? m.before : undefined;
    if (err) { ws.send(JSON.stringify({ op: 'error', error: err, hash, before })); if (!ws.roomId) ws.close(); }
  });
  ws.on('close', () => {
    dropUpload(ws);
    const set = rooms.get(ws.roomId);
    if (set?.delete(ws) && set.size === 0) rooms.delete(ws.roomId);
  });
});
http.listen(PORT);
console.log(`couple-talk relay on :${PORT} (metrics :${METRICS_PORT}), db=${DB_PATH}`);
