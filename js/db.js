// IndexedDB 封裝：所有資料只存在這台裝置的瀏覽器裡。
const DB_NAME = 'janna';
const DB_VERSION = 1;
const STORE = 'items';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // iOS 有時會在背景關閉連線，下次存取時重新開啟。
      db.onclose = () => { dbPromise = null; };
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('交易已中止'));
  });
}

export const all = () => run('readonly', (s) => s.getAll());
export const get = (id) => run('readonly', (s) => s.get(id));
export const put = (item) => run('readwrite', (s) => { s.put(item); });
export const putMany = (items) => run('readwrite', (s) => { items.forEach((i) => s.put(i)); });
export const remove = (id) => run('readwrite', (s) => { s.delete(id); });
