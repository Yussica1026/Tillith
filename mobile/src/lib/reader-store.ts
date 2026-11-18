export type ReaderMark = { id: string; page: number; note: string };
export type ReaderBook = { scope: string; id: string; title: string; format: string; count: number; page: number; marks: ReaderMark[]; updated: number };
let opening: Promise<IDBDatabase> | undefined;

function database() {
  if (!opening) opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('tillith-reader', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('books', { keyPath: ['scope', 'id'] }).createIndex('scope', 'scope');
      request.result.createObjectStore('pages');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); opening = undefined; };
      resolve(db);
    };
  }).catch(error => { opening = undefined; throw error; });
  return opening;
}

function read<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readerShelf(scope: string): Promise<ReaderBook[]> {
  const db = await database();
  const items: ReaderBook[] = await read(db.transaction('books').objectStore('books').index('scope').getAll(scope));
  return items.sort((a, b) => b.updated - a.updated);
}

export async function readerPages(book: ReaderBook): Promise<string[]> {
  const db = await database();
  const pages = await read(db.transaction('pages').objectStore('pages').get([book.scope, book.id]));
  if (!Array.isArray(pages) || !pages.length) throw new Error('正文读取失败，请重新导入这本书。');
  return pages;
}

export async function writeReaderBook(scope: string, id: string, change: (existing?: ReaderBook) => ReaderBook, pages?: string[]): Promise<ReaderBook> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(pages ? ['books', 'pages'] : 'books', 'readwrite');
    const books = transaction.objectStore('books');
    const current = books.get([scope, id]);
    let saved: ReaderBook;
    current.onsuccess = () => {
      try {
        saved = change(current.result);
        books.put(saved);
        if (pages) transaction.objectStore('pages').put(pages, [scope, id]);
      } catch { transaction.abort(); }
    };
    transaction.oncomplete = () => resolve(saved);
    transaction.onabort = () => reject(new Error('本机书架保存失败，请检查设备存储空间。'));
  });
}
