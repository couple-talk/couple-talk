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
  // put/get replies arrive as op 'stored'/'pack' keyed by hash; any error or disconnect fails them all.
  const waits = new Map<string, { ok: (m: any) => void; fail: (e: Error) => void }>();
  const failAll = (e: Error) => { for (const w of waits.values()) w.fail(e); waits.clear(); };
  const open = () => {
    ws = new WebSocket(url);
    ws.onopen = () => ws.send(JSON.stringify({ op: 'auth', v: 1, ...auth, since: since() }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.op === 'ready') { h.onState(true); h.onReady(m.mode, m.items); }
      else if (m.op === 'msg') h.onMsg(m);
      else if (m.op === 'stored' || m.op === 'pack') { waits.get(m.op + m.hash)?.ok(m); waits.delete(m.op + m.hash); }
      else if (m.op === 'error') { fatal = m.error === 'unauthorized'; failAll(new Error(m.error)); }
    };
    ws.onclose = () => { failAll(new Error('offline')); h.onState(false, fatal ? 'unauthorized' : undefined); if (!fatal) setTimeout(open, 3000); };
  };
  open();
  const send = (m: object) => ws.readyState === WebSocket.OPEN && (ws.send(JSON.stringify(m)), true);
  const request = (key: string, m: object) => new Promise<any>((ok, fail) => {
    if (!send(m)) return fail(new Error('offline'));
    waits.set(key, { ok, fail });
    setTimeout(() => { if (waits.delete(key)) fail(new Error('timeout')); }, 60_000);
  });
  return {
    putPack: (hash: string, blob: string) => request('stored' + hash, { op: 'put', hash, blob }),
    getPack: (hash: string) => request('pack' + hash, { op: 'get', hash }).then((m) => m.blob as string | null),
    send: (blob: string, receipt: string) => send({ op: 'send', blob, receipt }),
    ack: (id: number, receipt: string) => send({ op: 'ack', id, receipt }),
  };
}
