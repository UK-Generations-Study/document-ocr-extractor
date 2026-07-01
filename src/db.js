import { openDB } from 'idb';


async function getOrCreateDB() {
    return openDB('medical-report-information-extractor-db', 2, {
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
        }
    });
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
    const tx = db.transaction(['documents', 'blobs'], 'readwrite');
    // Cascade-delete every blob this document references so we don't leak.
    const blobKeys = new Set();
    for (const s of doc.sources || []) if (s.blobKey) blobKeys.add(s.blobKey);
    for (const p of doc.pages || []) if (p.blobKey) blobKeys.add(p.blobKey);
    for (const key of blobKeys) tx.objectStore('blobs').delete(key);
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
    getBlob
};
