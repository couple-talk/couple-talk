// "Each PC only" history (#8): sealed items as the relay delivered them, keyed by relay id. Connections close per
// request (app/AGENTS.md). Before #8 this lived in localStorage under `ct.history`, capped near 5MB.
import type { Item } from './net';

function store<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void, collect?: (r: IDBRequest) => Item | null) {
  return new Promise<T>((ok, fail) => {
    const req = indexedDB.open('ct-history', 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore('items', { keyPath: 'id' });
      // Once, so a reset or a later cleanup is never undone. The old key is dropped after this commits (onsuccess).
      try { for (const it of JSON.parse(localStorage.getItem('ct.history') ?? '[]') as Item[]) s.put(it); } catch { /* unreadable: nothing to keep */ }
    };
    req.onerror = () => fail(req.error);
    req.onsuccess = () => {
      localStorage.removeItem('ct.history');
      const db = req.result;
      const tx = db.transaction('items', mode);
      const r = fn(tx.objectStore('items'));
      db.close();
      const out: Item[] = [];
      if (r && collect) r.onsuccess = () => { const it = collect(r); if (it) out.push(it); };
      else if (r) r.onsuccess = () => out.push(r.result);
      tx.oncomplete = () => ok((collect ? out.reverse() : out[0]) as T);
      tx.onerror = () => fail(tx.error);
    };
  });
}

export const keepItem = (it: Item) => store<void>('readwrite', (s) => { s.put(it); });

/** Up to `n` items with an id below `before`, oldest first. */
export function itemsBefore(before: number, n: number) {
  let left = n;
  return store<Item[]>('readonly', (s) => s.openCursor(IDBKeyRange.upperBound(before, true), 'prev'), (r) => {
    const c = r.result as IDBCursorWithValue | null;
    if (!c || left-- <= 0) return null;
    const it = c.value as Item; // read before continue(), which resets the request
    c.continue();
    return it;
  });
}
