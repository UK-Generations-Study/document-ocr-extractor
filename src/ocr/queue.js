/**
 * OCR job queue: watches for documents in 'queued' status and runs Quick Read
 * on their pages, storing per-page results in the ocrPages store.
 *
 * One document is processed at a time (serial across docs). Within a document,
 * pages are processed sequentially so we can update status + progress
 * incrementally without racing writes on the same record.
 *
 * The QuickClient (private-eye's worker facade) is instantiated lazily on the
 * first enqueue. Models are loaded once and stay resident across jobs.
 */
import { QuickClient } from './workers/client.ts';
import {
    allDocuments,
    getBlob,
    getDocument,
    putDocument,
    putOcrPage,
} from '../db.js';

let client = null;      // QuickClient instance (lazy)
let ready = false;      // set when the worker reports 'ready'
let readyPromise = null;
const listeners = new Set(); // subscribers to (event) notifications
const pending = [];     // FIFO queue of doc IDs to process
let processing = false; // guard so we don't run two jobs in parallel

function emit(event) {
    for (const fn of listeners) {
        try { fn(event); } catch (err) { console.error('[ocr-queue] listener error', err); }
    }
}

export function subscribeQueue(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

async function ensureClient() {
    if (client && ready) return client;
    if (!client) {
        readyPromise = new Promise((resolve, reject) => {
            client = new QuickClient({
                debug: false,
                onnxEp: 'webgpu',
                handlers: {
                    onLoadProgress: (loaded, total) => {
                        emit({ type: 'load-progress', loaded, total });
                    },
                    onReady: (epNote) => {
                        ready = true;
                        emit({ type: 'ready', epNote });
                        resolve(client);
                    },
                    onError: (err) => {
                        emit({ type: 'error', error: err });
                        // If the worker died before ever going 'ready', let waiters fail.
                        if (!ready) reject(err);
                    },
                },
            });
            client.warm(); // begin model download / warmup
        });
    }
    await readyPromise;
    return client;
}

/** Add a document id to the OCR queue if it isn't already scheduled. */
export function enqueueDocument(docId) {
    if (!docId) return;
    if (pending.includes(docId)) return;
    pending.push(docId);
    emit({ type: 'enqueued', docId, pending: pending.length });
    tick();
}

/** Scan the documents store on boot and re-enqueue anything still 'queued'. */
export async function primeQueueFromDb() {
    const docs = await allDocuments();
    for (const d of docs) {
        if (d.status === 'queued') enqueueDocument(d.id);
    }
}

/** Recover documents left in 'ocr-running' by a session that was closed or
 *  reloaded mid-job. Flip them back to 'queued' so they get picked up by the
 *  next primeQueueFromDb pass. Must be called BEFORE primeQueueFromDb to
 *  avoid a race with a doc genuinely being processed in this session. */
export async function recoverStuckDocuments() {
    const docs = await allDocuments();
    for (const d of docs) {
        if (d.status === 'ocr-running' || d.status === 'extraction-running') {
            d.status = d.status === 'ocr-running' ? 'queued' : 'ocr-confirmed';
            await putDocument(d);
            emit({ type: 'status', docId: d.id, status: d.status });
        }
    }
}

async function tick() {
    if (processing) return;
    if (!pending.length) return;
    processing = true;
    try {
        while (pending.length) {
            const docId = pending.shift();
            await processDocument(docId);
        }
    } finally {
        processing = false;
    }
}

async function processDocument(docId) {
    const doc = await getDocument(docId);
    if (!doc) return;
    if (doc.status !== 'queued') return; // caught up: user may have re-run or dropped

    // Move to ocr-running.
    await patchStatus(doc, 'ocr-running');
    emit({ type: 'doc-start', docId });

    let c;
    try {
        c = await ensureClient();
    } catch (err) {
        emit({ type: 'doc-error', docId, error: err });
        // Roll back so the user isn't stuck in "OCR..." forever.
        await patchStatus(doc, 'queued');
        return;
    }

    const pages = doc.pages || [];
    let failed = false;
    for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        emit({ type: 'page-start', docId, pageIndex: i, pageCount: pages.length });
        const blob = await getBlob(page.blobKey);
        if (!blob) {
            emit({ type: 'page-error', docId, pageIndex: i, error: new Error('page blob missing') });
            failed = true;
            continue;
        }
        const url = URL.createObjectURL(blob);
        try {
            const result = await c.run(`doc:${docId}/page:${i + 1}`, url);
            await putOcrPage({
                pageBlobKey: page.blobKey,
                docId,
                markdown: result.markdown || '',
                blocks: result.blocks || [],
                uncertainty: result.uncertainty || null,
                width: result.width,
                height: result.height,
                stageMs: result.stageMs || {},
                totalMs: result.totalMs || 0,
                source: 'quick',
                updatedAt: Date.now(),
            });
            emit({ type: 'page-done', docId, pageIndex: i });
        } catch (err) {
            failed = true;
            emit({ type: 'page-error', docId, pageIndex: i, error: err });
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    // Reload the latest doc record in case the user renamed/edited during OCR.
    const latest = await getDocument(docId);
    if (!latest) return;
    // Roll status forward but don't overwrite a later state (e.g., user hit
    // Confirm on the previous run and it's already ocr-confirmed).
    if (latest.status === 'ocr-running') {
        await patchStatus(latest, failed ? 'queued' : 'ocr-done');
    }
    emit({ type: 'doc-done', docId, failed });
}

async function patchStatus(doc, status) {
    if (doc.status === status) return;
    doc.status = status;
    await putDocument(doc);
    emit({ type: 'status', docId: doc.id, status });
}
