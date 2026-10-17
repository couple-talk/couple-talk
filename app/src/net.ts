const PACK_PART = 192 * 1024;

export type Item = { id: number; ts: number; blob: string };
type Handlers = {
  onReady: (mode: 'server' | 'local', items: Item[]) => void;
  onMsg: (item: Item) => void;
  onState: (online: boolean, error?: string) => void;
};

/** Keeps one authenticated socket open, reconnecting every 3s. `since()` lets server mode resume without duplicates. */
export function connect(url: string, auth: object, since: () => number, h: Handlers) {
  let ws: WebSocket;
  let fatal = false;
  // put/get replies arrive as op 'stored'/'pack' keyed by hash; error replies echo the hash.
  type Wait = { p: Promise<any>; ok: (m: any) => void; fail: (e: Error) => void };
  const waits = new Map<string, Wait>();
  const settle = (key: string, fn: (w: Wait) => void) => { const w = waits.get(key); if (w) { waits.delete(key); fn(w); } };
  const failAll = (e: Error) => { for (const w of waits.values()) w.fail(e); waits.clear(); };
  const open = () => {
    ws = new WebSocket(url);
    ws.onopen = () => ws.send(JSON.stringify({ op: 'auth', v: 1, ...auth, since: since() }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.op === 'ready') { h.onState(true); h.onReady(m.mode, m.items); }
      else if (m.op === 'msg') h.onMsg(m);
      else if (m.op === 'stored' || m.op === 'pack') settle(m.op + m.hash, (w) => w.ok(m));
      else if (m.op === 'error') {
        fatal = m.error === 'unauthorized';
        if (m.hash) for (const k of ['stored', 'pack']) settle(k + m.hash, (w) => w.fail(new Error(m.error)));
        else if (m.error === 'unknown op') failAll(new Error(m.error)); // relay without pack support
      }
    };
    ws.onclose = () => { failAll(new Error('offline')); h.onState(false, fatal ? 'unauthorized' : undefined); if (!fatal) setTimeout(open, 3000); };
  };
  open();
  const send = (m: object) => ws.readyState === WebSocket.OPEN && (ws.send(JSON.stringify(m)), true);
  // Concurrent requests for the same hash share one round trip.
  const request = (key: string, msgs: object[], timeoutMs: number) => {
    const inflight = waits.get(key);
    if (inflight) return inflight.p;
    if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('offline'));
    const w = {} as Wait;
    w.p = new Promise((ok, fail) => Object.assign(w, { ok, fail }));
    waits.set(key, w);
    for (const m of msgs) ws.send(JSON.stringify(m));
    setTimeout(() => settle(key, (x) => x.fail(new Error('timeout'))), timeoutMs);
    return w.p;
  };
  return {
    // Must match PACK_PART in server.js. Timeouts allow ~16KB/s for an 8MB pack on a slow uplink.
    putPack: (hash: string, blob: string) => {
      const parts = Math.max(1, Math.ceil(blob.length / PACK_PART));
      const msgs = Array.from({ length: parts }, (_, part) => ({ op: 'put', hash, part, parts, data: blob.slice(part * PACK_PART, (part + 1) * PACK_PART) }));
      return request('stored' + hash, msgs, 60_000 + blob.length / 16);
    },
    getPack: (hash: string) => request('pack' + hash, [{ op: 'get', hash }], 600_000).then((m) => m.blob as string | null),
    send: (blob: string, receipt: string) => send({ op: 'send', blob, receipt }),
    ack: (id: number, receipt: string) => send({ op: 'ack', id, receipt }),
  };
}
