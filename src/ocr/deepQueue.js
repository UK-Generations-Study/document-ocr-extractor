/**
 * Deep Read facade + per-document queue (Phase 4b).
 *
 * Separate from src/ocr/queue.js because Deep Read is opt-in and its resource
 * profile is very different: a ~1.4 GB weight download that streams once and
 * lives in OPFS across sessions, then ~2-3 GB of resident memory while active.
 *
 * We instantiate the DeepClient lazily on the first enqueue and tear it down
 * with terminate() when there's nothing left to process, so the 1.4 GB doesn't
 * stay resident forever after one report.
 *
 * On success, we write a NEW ocrPages row with source='deep' *replacing* the
 * quick row for the same pageBlobKey - the schema keys by pageBlobKey, so
 * putOcrPage overwrites. If the abstractor prefers the quick output, they can
 * re-run Quick Read via the queue's re-run path (Phase 5).
 */
import { DeepClient, DeepCancelled } from './workers/deep-client.ts';
import { getBlob, getDocument, putDocument, putOcrPage } from '../db.js';

let client = null;
let loading = null;   // Promise resolving to the loaded client
const listeners = new Set();
const pending = [];   // queue of doc ids to process
let processing = false;
let idleTimer = null;
const IDLE_TEARDOWN_MS = 60_000; // release the ~1.4 GB after 60 s idle

function emit(event) {
    for (const fn of listeners) {
        try { fn(event); } catch (err) { console.error('[deep-queue] listener error', err); }
    }
}

export function subscribeDeepQueue(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

async function ensureClient() {
    if (client && client.loaded) {
        clearIdleTimer();
        return client;
    }
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
        try {
            client = new DeepClient({
                debug: false,
                onnxEp: 'webgpu',
                vlmEp: 'webgpu',
                handlers: {
                    onError: (err) => emit({ type: 'error', error: err }),
                },
            });
        } catch (err) {
            loading = null;
            reject(err);
            return;
        }
        client.load({
            onLoadProgress: (loaded, total) => emit({ type: 'load-progress', loaded, total }),
        }).then(
            (epNote) => {
                loading = null;
                emit({ type: 'loaded', epNote });
                resolve(client);
            },
            (err) => {
                loading = null;
                emit({ type: 'error', error: err });
                reject(err);
            },
        );
    });
    return loading;
}

function clearIdleTimer() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}
function scheduleIdleTeardown() {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
        if (client && !processing) {
            emit({ type: 'unload' });
            client.terminate();
            client = null;
        }
    }, IDLE_TEARDOWN_MS);
}

/** Enqueue a document for Deep Read. */
export function enqueueDeep(docId) {
    if (!docId) return;
    if (pending.includes(docId)) return;
    pending.push(docId);
    emit({ type: 'enqueued', docId, pending: pending.length });
    tick();
}

async function tick() {
    if (processing) return;
    if (!pending.length) return;
    processing = true;
    try {
        while (pending.length) {
            const docId = pending.shift();
            await processDeep(docId);
        }
    } finally {
        processing = false;
        scheduleIdleTeardown();
    }
}

async function processDeep(docId) {
    const doc = await getDocument(docId);
    if (!doc) return;
    emit({ type: 'doc-start', docId });

    let c;
    try {
        c = await ensureClient();
    } catch (err) {
        emit({ type: 'doc-error', docId, error: err });
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
            const result = await c.run(`doc:${docId}/page:${i + 1}`, url, {
                onPhase: (phase, index, total) => emit({ type: 'phase', docId, pageIndex: i, phase, index, total }),
            });
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
                source: 'deep',
                pipeline: result.pipeline,
                fellBack: result.fellBack,
                note: result.note,
                updatedAt: Date.now(),
            });
            emit({ type: 'page-done', docId, pageIndex: i, pipeline: result.pipeline });
        } catch (err) {
            if (err instanceof DeepCancelled) {
                emit({ type: 'page-cancelled', docId, pageIndex: i });
                failed = true;
                break;
            }
            failed = true;
            emit({ type: 'page-error', docId, pageIndex: i, error: err });
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    emit({ type: 'doc-done', docId, failed });
}

/** Cancel the in-flight page (leaves earlier pages of this document written). */
export function cancelCurrentDeep() {
    client?.cancelCurrent();
}
