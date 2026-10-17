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
  const open = () => {
    ws = new WebSocket(url);
    ws.onopen = () => ws.send(JSON.stringify({ op: 'auth', v: 1, ...auth, since: since() }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.op === 'ready') { h.onState(true); h.onReady(m.mode, m.items); }
      else if (m.op === 'msg') h.onMsg(m);
      else if (m.op === 'error') fatal = m.error === 'unauthorized';
    };
    ws.onclose = () => { h.onState(false, fatal ? 'unauthorized' : undefined); if (!fatal) setTimeout(open, 3000); };
  };
  open();
  const send = (m: object) => ws.readyState === WebSocket.OPEN && (ws.send(JSON.stringify(m)), true);
  return {
    send: (blob: string) => send({ op: 'send', blob }),
    ack: (id: number) => send({ op: 'ack', id }),
  };
}
