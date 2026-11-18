import type { Cue, MediaKind } from './media-cues';

export type MediaWork = { id: string; scope: string; kind: MediaKind; title: string; playlist: string; order: number; url?: string };
let opening: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  if (!opening) opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('tillith-media-library', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('works', { keyPath: 'id' }).createIndex('scope', 'scope');
      for (const name of ['files', 'cues', 'positions']) db.createObjectStore(name);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); opening = undefined; };
      resolve(db);
    };
  }).catch(reason => { opening = undefined; throw reason; });
  return opening;
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function write(stores: string[], action: (tx: IDBTransaction) => void): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('本机媒体未能保存。'));
    try { action(tx); } catch (reason) { tx.abort(); reject(reason); }
  });
}

export async function listWorks(scope: string): Promise<MediaWork[]> {
  const db = await database();
  const rows: MediaWork[] = await result(db.transaction('works').objectStore('works').index('scope').getAll(scope));
  return rows.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

export async function addWorks(scope: string, kind: MediaKind, playlist: string, entries: { title: string; file?: File; url?: string }[]): Promise<MediaWork[]> {
  const now = Date.now();
  const works = entries.map(({ title, url }, index) => ({
    id: crypto.randomUUID(), scope, kind, playlist, title: title.slice(0, 160), url, order: now + index,
  }));
  await write(['works', 'files'], tx => {
    works.forEach((work, index) => {
      tx.objectStore('works').add(work);
      const file = entries[index].file;
      if (file) tx.objectStore('files').add(file, work.id);
    });
  });
  return works;
}

export async function loadWork(work: MediaWork): Promise<{ file?: Blob; position: number; cues: Cue[] }> {
  const db = await database();
  const tx = db.transaction(['files', 'positions', 'cues']);
  const [file, position, cues] = await Promise.all([
    work.url ? Promise.resolve(undefined) : result(tx.objectStore('files').get(work.id)),
    result(tx.objectStore('positions').get(work.id)),
    result(tx.objectStore('cues').get(work.id)),
  ]);
  if (!work.url && !file) throw new Error('本地媒体文件无法读取，请重新导入。');
  return { file, position: Number.isFinite(position) ? position : 0, cues: cues || [] };
}

function saveWorkValue(store: string, id: string, value: number | Cue[]) {
  return write(['works', store], tx => {
    const found = tx.objectStore('works').getKey(id);
    found.onsuccess = () => { if (found.result !== undefined) tx.objectStore(store).put(value, id); };
  });
}
export const savePosition = (id: string, seconds: number) => saveWorkValue('positions', id, seconds);
export const saveCues = (id: string, cues: Cue[]) => saveWorkValue('cues', id, cues);

export function removeWork(id: string): Promise<void> {
  const stores = ['works', 'files', 'positions', 'cues'];
  return write(stores, tx => { for (const store of stores) tx.objectStore(store).delete(id); });
}
