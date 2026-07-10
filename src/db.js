import { openDB } from 'idb';

// One connection per session: openDB() creates a fresh IndexedDB connection
// every call, and the helpers below run dozens of times per second during
// OCR. Cache the open promise so every helper shares a single connection.
let dbPromise = null;

function getOrCreateDB() {
    if (dbPromise) return dbPromise;
    dbPromise = openDB('medical-report-information-extractor-db', 3, {
        upgrade(db, oldVersion) {
            // v1 stores.
            // "config" store: system prompt, JSON schemas, JSON-LD contexts, LLM API credentials.
            if (!db.objectStoreNames.contains('config')) {
                db.createObjectStore('config', {keyPath: 'id'});
            }

            // "reports" store: legacy text-based reports (pre-Phase 3).
            // Preserved so an in-progress session survives the upgrade.
            if (!db.objectStoreNames.contains('reports')) {
                db.createObjectStore('reports', {keyPath: 'id'});
            }

            // v2 stores (Phase 3): image/PDF ingest.
            //   "documents" - one row per pathology report. Metadata + status +
            //                 references into 'blobs' for original files and rasterized pages.
            //   "blobs"     - out-of-line Blob store, keyed by string. Kept separate from
            //                 documents so we can read a document record without loading
            //                 megabytes of page images.
            if (oldVersion < 2) {
                if (!db.objectStoreNames.contains('documents')) {
                    const docs = db.createObjectStore('documents', {keyPath: 'id'});
                    docs.createIndex('byCreatedAt', 'createdAt');
                }
                if (!db.objectStoreNames.contains('blobs')) {
                    db.createObjectStore('blobs');
                }
            }

            // v3 store (Phase 4a): per-page OCR result. Keyed by the page's blobKey
            // (which is stable across a document's lifetime). Kept out of the document
            // record so we can rewrite an OCR result (e.g. after manual edit or Deep
            // Read) without touching the document metadata.
            if (oldVersion < 3) {
                if (!db.objectStoreNames.contains('ocrPages')) {
                    const ocr = db.createObjectStore('ocrPages', {keyPath: 'pageBlobKey'});
                    ocr.createIndex('byDoc', 'docId');
                }
            }
        }
    });
    return dbPromise;
}

/*
   config store:
     - id = "appConfig" for systemPrompt + JSON schemas + JSON-LD contexts
     - id = "llmApiCreds" for API baseURL + key
     - id = "model" for user-selected model
*/

async function saveConfigRecord(record) {
    const db = await getOrCreateDB();
    await db.put('config', record);
}


async function getConfigRecord(id) {
    const db = await getOrCreateDB();
    return db.get('config', id);
}


async function deleteConfigRecord(id) {
    const db = await getOrCreateDB();
    return db.delete('config', id);
}

/*
    reports store:
     {
       id: <unique>,
       name: <string>,
       content: <string>,
       extractions?: [
         {
           schemaTitle: <string>,
           data: <object> // LLM-extracted JSON for that schema
         }
       ]
     }
*/

async function putUploadedFile(fileRecord) {
    const db = await getOrCreateDB();
    await db.put('reports', fileRecord);
}


async function getAllUploadedFiles() {
    const db = await getOrCreateDB();
    return db.getAll('reports');
}


async function clearUploadedFiles() {
    const db = await getOrCreateDB();
    await db.clear('reports');
}

async function deleteUploadedFile(fileId) {
    const db = await getOrCreateDB();
    return db.delete('reports', fileId);
}


/*
   documents store (Phase 3+):
     {
       id: <uuid>,
       name: <string>,            // shown in the report list; editable later
       createdAt: <number>,       // ms epoch, used for sort order (index: byCreatedAt)
       status: 'queued' | 'ocr-running' | 'ocr-done' | 'ocr-confirmed'
             | 'extraction-running' | 'extraction-done' | 'confirmed' | 'exported',
       sources: [                 // original uploaded files, one entry per file
         { kind: 'pdf' | 'image', filename: <string>, blobKey: <string>, pageCount?: <number> }
       ],
       pages: [                   // rasterized pages in display order
         { blobKey: <string>, width: <number>, height: <number>,
           sourceIdx: <number>, sourcePage?: <number>, scale?: <number> }
       ]
     }

   blobs store: out-of-line, key = string (see makeBlobKey). Values are raw Blobs.
*/

async function putDocument(doc) {
    const db = await getOrCreateDB();
    await db.put('documents', doc);
}

async function getDocument(id) {
    const db = await getOrCreateDB();
    return db.get('documents', id);
}

async function allDocuments() {
    const db = await getOrCreateDB();
    return db.getAllFromIndex('documents', 'byCreatedAt');
}

async function deleteDocument(id) {
    const db = await getOrCreateDB();
    const doc = await db.get('documents', id);
    if (!doc) return;
    const tx = db.transaction(['documents', 'blobs', 'ocrPages'], 'readwrite');
    // Cascade-delete every blob this document references so we don't leak.
    const blobKeys = new Set();
    for (const s of doc.sources || []) if (s.blobKey) blobKeys.add(s.blobKey);
    for (const p of doc.pages || []) if (p.blobKey) blobKeys.add(p.blobKey);
    for (const key of blobKeys) tx.objectStore('blobs').delete(key);
    // Cascade-delete OCR rows for this doc.
    const ocrKeys = await tx.objectStore('ocrPages').index('byDoc').getAllKeys(id);
    for (const k of ocrKeys) tx.objectStore('ocrPages').delete(k);
    tx.objectStore('documents').delete(id);
    await tx.done;
}

async function putBlob(key, blob) {
    const db = await getOrCreateDB();
    await db.put('blobs', blob, key);
}

async function getBlob(key) {
    const db = await getOrCreateDB();
    return db.get('blobs', key);
}

/*
   ocrPages store (Phase 4a):
     {
       pageBlobKey: <string>,   // = documents.pages[i].blobKey
       docId: <string>,         // = documents.id (indexed for cascade + lookup)
       text: <string>,          // linearized page text
       blocks: [                // one entry per detected text block, in reading order
         { text, x0, y0, x1, y1, confidence }
       ],
       source: 'quick' | 'deep' | 'edit',   // origin of the current stored value
       updatedAt: <number>
     }
*/

async function putOcrPage(rec) {
    const db = await getOrCreateDB();
    await db.put('ocrPages', rec);
}

async function getOcrPage(pageBlobKey) {
    const db = await getOrCreateDB();
    return db.get('ocrPages', pageBlobKey);
}

async function getOcrPagesByDoc(docId) {
    const db = await getOrCreateDB();
    return db.getAllFromIndex('ocrPages', 'byDoc', docId);
}

async function deleteOcrPagesByDoc(docId) {
    const db = await getOrCreateDB();
    const tx = db.transaction('ocrPages', 'readwrite');
    const keys = await tx.store.index('byDoc').getAllKeys(docId);
    for (const k of keys) tx.store.delete(k);
    await tx.done;
}

export {
    getOrCreateDB,
    saveConfigRecord,
    getConfigRecord,
    deleteConfigRecord,
    putUploadedFile,
    getAllUploadedFiles,
    clearUploadedFiles,
    deleteUploadedFile,
    putDocument,
    getDocument,
    allDocuments,
    deleteDocument,
    putBlob,
    getBlob,
    putOcrPage,
    getOcrPage,
    getOcrPagesByDoc,
    deleteOcrPagesByDoc
};
