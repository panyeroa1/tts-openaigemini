const DB_NAME = 'FinlaAudioDB_VAD_Firebase_Topics'; 
const STORE_NAME = 'audioFiles';
let db;

/**
 * Initializes the IndexedDB database.
 * @returns {Promise<IDBDatabase>} A promise that resolves with the database object.
 */
export function initDB() { 
    return new Promise((resolve, reject) => {
        if (db) {
            return resolve(db);
        }
        const request = indexedDB.open(DB_NAME, 1);
        request.onerror = event => {
            console.error("IndexedDB error:", event.target.errorCode, event.target.error);
            reject("IndexedDB error: " + event.target.errorCode);
        };
        request.onsuccess = event => {
            db = event.target.result;
            console.log("IndexedDB initialized successfully.");
            resolve(db);
        };
        request.onupgradeneeded = event => {
            const store = event.target.result.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            store.createIndex('name', 'name', { unique: false });
            store.createIndex('timestamp', 'timestamp', { unique: false });
        };
    });
}

/**
 * Saves an audio blob to IndexedDB.
 * @param {Blob} blob The audio blob to save.
 * @param {string} name The name of the audio file.
 * @returns {Promise<number>} A promise that resolves with the key of the newly added record.
 */
export async function saveAudioToDB(blob, name) { 
    if (!db) {
        try {
            await initDB(); 
            if(!db) { 
                 console.error("DB not initialized for saving, and re-init failed.");
                 return;
            }
        } catch (e) {
            console.error("DB initialization failed during save attempt:", e);
            return;
        }
    }
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const audioRecord = {
            name: name,
            blob: blob,
            timestamp: new Date().toISOString()
        };
        const request = store.add(audioRecord);
        request.onsuccess = () => {
            console.log(`Audio "${name}" saved to IndexedDB.`);
            resolve(request.result); 
        };
        request.onerror = event => {
            console.error("Error saving audio to IndexedDB:", event.target.error);
            reject(event.target.error);
        };
    });
}

/**
 * Fetches all recordings from IndexedDB.
 * @returns {Promise<Array<Object>>} A promise that resolves with an array of recording objects.
 */
export async function fetchAllRecordings() {
    if (!db) {
        await initDB();
    }
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onsuccess = event => {
            // Add a 'source' property to distinguish from cloud records
            const recordings = event.target.result.map(rec => ({...rec, source: 'local'}));
            resolve(recordings);
        };

        request.onerror = event => {
            console.error("Error fetching recordings from IndexedDB:", event.target.error);
            reject(event.target.error);
        };
    });
}
