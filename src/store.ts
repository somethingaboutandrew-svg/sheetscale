// Local persistence (IndexedDB). Everything stays in this browser profile.
import type { Doc, SourceFile } from './types';

const DB = 'planmark';
let dbp: Promise<IDBDatabase> | null = null;
function db() {
  return (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('sources');
      d.createObjectStore('docs');
      d.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return db().then((d) => new Promise<T>((res, rej) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req ? (req.result as T) : (undefined as T));
    t.onerror = () => rej(t.error);
  }));
}

export const putSource = (s: SourceFile) => tx('sources', 'readwrite', (st) => { st.put({ id: s.id, name: s.name, bytes: s.bytes }, s.id); });
export const getSource = (id: string) => tx<SourceFile | undefined>('sources', 'readonly', (st) => st.get(id));
export const delSource = (id: string) => tx('sources', 'readwrite', (st) => { st.delete(id); });
export const allSourceIds = () => tx<IDBValidKey[]>('sources', 'readonly', (st) => st.getAllKeys());
export const putDoc = (d: Doc) => tx('docs', 'readwrite', (st) => { st.put(JSON.parse(JSON.stringify(d)), d.id); });
export const getDoc = (id: string) => tx<Doc | undefined>('docs', 'readonly', (st) => st.get(id));
export const delDoc = (id: string) => tx('docs', 'readwrite', (st) => { st.delete(id); });
export const putMeta = (k: string, v: unknown) => tx('meta', 'readwrite', (st) => { st.put(v, k); });
export const getMeta = <T>(k: string) => tx<T | undefined>('meta', 'readonly', (st) => st.get(k));
