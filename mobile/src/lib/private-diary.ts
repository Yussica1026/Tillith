import type { LifeEntry } from './life-api';

type DiaryRow = { scope: string; id: string; iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer };
let opening: Promise<IDBDatabase> | undefined;

function database() {
  if (!opening) opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('tillith-private-diary', 1);
    request.onupgradeneeded = () => {
      const entries = request.result.createObjectStore('entries', { keyPath: ['scope', 'id'] });
      entries.createIndex('scope', 'scope');
      request.result.createObjectStore('keys');
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); opening = undefined; };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  }).catch(error => { opening = undefined; throw error; });
  return opening;
}

function result<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function committed(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}

async function encryptionKey(db: IDBDatabase): Promise<CryptoKey> {
  const existing = await result(db.transaction('keys').objectStore('keys').get('device')) as CryptoKey | undefined;
  if (existing) return existing;
  const candidate = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  // A second tab may have initialized the key while generation was in progress.
  const transaction = db.transaction('keys', 'readwrite');
  const keys = transaction.objectStore('keys');
  const check = keys.get('device');
  let key = candidate;
  check.onsuccess = () => { if (check.result) key = check.result; else keys.add(candidate, 'device'); };
  await committed(transaction);
  return key;
}

export async function listPrivateDiary(scope: string): Promise<LifeEntry[]> {
  const db = await database();
  const rows: DiaryRow[] = await result(db.transaction('entries').objectStore('entries').index('scope').getAll(scope));
  if (!rows.length) return [];
  const key = await encryptionKey(db);
  return Promise.all(rows.map(async row => {
    const additionalData = new TextEncoder().encode(JSON.stringify([scope, row.id]));
    const decoded = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: row.iv, additionalData }, key, row.ciphertext);
    const { day, text, created_at } = JSON.parse(new TextDecoder().decode(decoded));
    return { id: row.id, category: 'diary' as const, author: 'user' as const, ai_visible: false, parent_id: null, day, text, created_at };
  }));
}

export async function savePrivateDiary(scope: string, day: string, text: string, original?: LifeEntry): Promise<LifeEntry> {
  const db = await database();
  const key = await encryptionKey(db), id = original?.id || crypto.randomUUID();
  const created_at = original?.created_at || new Date().toISOString();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode(JSON.stringify([scope, id]));
  const plaintext = new TextEncoder().encode(JSON.stringify({ day, text, created_at }));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, plaintext);
  const transaction = db.transaction('entries', 'readwrite');
  transaction.objectStore('entries').put({ scope, id, iv, ciphertext });
  await committed(transaction);
  return { id, category: 'diary', author: 'user', ai_visible: false, parent_id: null, day, text, created_at };
}

export async function deletePrivateDiary(scope: string, id: string): Promise<void> {
  const db = await database();
  const transaction = db.transaction('entries', 'readwrite');
  transaction.objectStore('entries').delete([scope, id]);
  await committed(transaction);
}
