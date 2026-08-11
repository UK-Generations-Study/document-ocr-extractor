import { openDB } from 'idb';
import { getPipelineMode } from './core/mode.js';

/**
 * TWO databases, on purpose.
 *
 * The shared one holds `config` - settings, LLM credentials, the schema, the
 * chosen model. Those describe the machine, not the work, so they must survive
 * a change of pipeline mode; nobody wants to re-enter an API key because they
 * switched from Extract to Read + Extract.
 *
 * The per-mode one holds the WORK: documents, their page blobs and their OCR
 * results. Each mode is its own workspace, so reports read in Read mode are not
 * waiting in Extract mode. The mode is readable synchronously at boot (see
 * core/mode.js), so the right database opens before anything queries it - which
 * is why no call site has to filter by mode.
 *
 * One connection each per session: openDB() creates a fresh connection every
 * call, and these helpers run dozens of times per second during OCR.
 */
let dbPromise = null;
let docsDbPromise = null;

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

/**
 * The per-mode workspace holding documents, page blobs and OCR results.
 *
 * `documents`, `blobs` and `ocrPages` are also defined in the shared database
 * above, because they used to live there. Nothing reads them from it any more.
 * They are left alone deliberately: dropping them would be migration code for
 * data that is only ever cleared by hand.
 */
function getOrCreateDocsDB() {
    if (docsDbPromise) return docsDbPromise;
    const mode = getPipelineMode();
    if (!mode) {
        // app.js shows the blocking mode picker before mounting anything that
        // could reach here, so this is a wiring bug rather than a user state -
        // fail loudly instead of quietly creating a workspace under a name that
        // no mode will ever open again.
        throw new Error('No pipeline mode chosen: document storage is per-mode and cannot be opened yet.');
    }
    docsDbPromise = openDB(`medical-report-information-extractor-docs-${mode}`, 1, {
        upgrade(db) {
            const docs = db.createObjectStore('documents', { keyPath: 'id' });
            docs.createIndex('byCreatedAt', 'createdAt');
            db.createObjectStore('blobs');
            const ocr = db.createObjectStore('ocrPages', { keyPath: 'pageBlobKey' });
            ocr.createIndex('byDoc', 'docId');
        },
    });
    return docsDbPromise;
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
    const db = await getOrCreateDocsDB();
    await db.put('documents', doc);
}

async function getDocument(id) {
    const db = await getOrCreateDocsDB();
    return db.get('documents', id);
}

async function allDocuments() {
    const db = await getOrCreateDocsDB();
    return db.getAllFromIndex('documents', 'byCreatedAt');
}

async function deleteDocument(id) {
    const db = await getOrCreateDocsDB();
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
    const db = await getOrCreateDocsDB();
    await db.put('blobs', blob, key);
}

async function getBlob(key) {
    const db = await getOrCreateDocsDB();
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
    const db = await getOrCreateDocsDB();
    await db.put('ocrPages', rec);
}

async function getOcrPage(pageBlobKey) {
    const db = await getOrCreateDocsDB();
    return db.get('ocrPages', pageBlobKey);
}

async function getOcrPagesByDoc(docId) {
    const db = await getOrCreateDocsDB();
    return db.getAllFromIndex('ocrPages', 'byDoc', docId);
}

async function deleteOcrPagesByDoc(docId) {
    const db = await getOrCreateDocsDB();
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
