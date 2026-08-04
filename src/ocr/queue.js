/**
 * OCR job queue: runs Quick Read over a document's pages, storing per-page
 * results in the ocrPages store.
 *
 * One document is processed at a time (serial across docs). Within a document,
 * pages are processed sequentially so we can update status + progress
 * incrementally without racing writes on the same record.
 *
 * Event-driven: app.js routes every `status: 'queued'` bus event here, so the
 * queue needs no polling. `primeQueueFromDb` runs once at boot to pick up
 * documents left over from a previous session.
 *
 * Failure is terminal: a document whose OCR run errors moves to 'ocr-failed'
 * (with doc.lastError) and stays there until the user retries. It is NOT
 * rolled back to 'queued' - that used to re-enqueue it in an infinite loop.
 *
 * After a successful run the doc-level low-confidence line count is stored on
 * the record (doc.lowConfLines) and the review-mode gate is applied:
 * 'flagged' auto-confirms clean documents, 'auto' confirms everything.
 *
 * The QuickClient (private-eye's worker facade) is instantiated lazily on the
 * first enqueue. Models are loaded once and stay resident across jobs.
 */
import { QuickClient } from './workers/client.ts';
import { emitAppEvent } from '../core/bus.js';
import { setDocumentStatus } from '../core/status.js';
import { getSettings, REVIEW_MODES } from '../core/settings.js';
import { deidentifyPage } from '../deid/deidentify.js';
import { countDocLowConfLines } from './confidence.js';
import {
    allDocuments,
    getBlob,
    getDocument,
    getOcrPagesByDoc,
    putOcrPage,
} from '../db.js';

let client = null;      // QuickClient instance (lazy)
let ready = false;      // set when the worker reports 'ready'
let readyPromise = null;
const pending = [];     // FIFO queue of doc IDs to process
let processing = false; // guard so we don't run two jobs in parallel

function emit(event) {
    emitAppEvent({ source: 'ocr', ...event });
}

/**
 * ?ortThreads=N from the page URL, or undefined to let the worker decide from
 * core count and cross-origin isolation.
 *
 * Read here rather than in the worker because a Web Worker can see neither the
 * page's query string nor localStorage. It is a diagnostic escape hatch, not a
 * setting: ?ortThreads=1 restores single-threaded OCR if the threaded runtime
 * misbehaves on a given host, without needing a rebuild - which matters on an
 * air-gapped machine, where a rebuild means moving multiple GB again.
 */
function ortThreadsOverride() {
    const raw = new URLSearchParams(location.search).get('ortThreads');
    const n = Number(raw);
    return raw !== null && Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}

async function ensureClient() {
    if (client && ready) return client;
    if (!client) {
        readyPromise = new Promise((resolve, reject) => {
            client = new QuickClient({
                debug: false,
                onnxEp: 'webgpu',
                numThreads: ortThreadsOverride(),
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

/** Scan the documents store at boot and enqueue anything still 'queued'. */
export async function primeQueueFromDb() {
    const docs = await allDocuments();
    for (const d of docs) {
        if (d.status === 'queued') enqueueDocument(d.id);
    }
}

/** Recover documents left in a *-running state by a session that was closed
 *  or reloaded mid-job. Flip them back to their re-enqueueable state. Must be
 *  called BEFORE primeQueueFromDb to avoid a race with a doc genuinely being
 *  processed in this session. */
export async function recoverStuckDocuments() {
    const docs = await allDocuments();
    for (const d of docs) {
        if (d.status === 'ocr-running') {
            await setDocumentStatus(d.id, 'queued');
        } else if (d.status === 'extraction-running') {
            await setDocumentStatus(d.id, 'ocr-confirmed');
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

    await setDocumentStatus(docId, 'ocr-running');
    emit({ type: 'doc-start', docId });

    let c;
    try {
        c = await ensureClient();
    } catch (err) {
        emit({ type: 'doc-error', docId, error: err });
        await setDocumentStatus(docId, 'ocr-failed', {
            lastError: `OCR engine failed to start: ${err?.message || err}`,
        });
        emit({ type: 'doc-done', docId, failed: true });
        return;
    }

    const pages = doc.pages || [];
    const pageErrors = [];
    for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        emit({ type: 'page-start', docId, pageIndex: i, pageCount: pages.length });
        const blob = await getBlob(page.blobKey);
        if (!blob) {
            emit({ type: 'page-error', docId, pageIndex: i, error: new Error('page blob missing') });
            pageErrors.push(`page ${i + 1}: stored image missing`);
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
            pageErrors.push(`page ${i + 1}: ${err?.message || err}`);
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
        if (pageErrors.length) {
            await setDocumentStatus(docId, 'ocr-failed', { lastError: pageErrors.join('; ') });
        } else {
            const ocrPages = await getOcrPagesByDoc(docId);
            // De-identify BEFORE the document becomes reviewable. A failure
            // here fails the document: continuing would surface (and later
            // export) text that was supposed to be redacted.
            try {
                await deidentifyDocument(docId, ocrPages);
            } catch (err) {
                emit({ type: 'deid-error', docId, error: err });
                await setDocumentStatus(docId, 'ocr-failed', {
                    lastError: `De-identification failed: ${err?.message || err}`,
                });
                emit({ type: 'doc-done', docId, failed: true });
                return;
            }
            const lowConfLines = countDocLowConfLines(ocrPages);
            // No redaction count is stored: which spans are redacted depends on
            // the current entity selection and score threshold, so any stored
            // tally would go stale the moment those change.
            await setDocumentStatus(docId, 'ocr-done', { lowConfLines, lastError: null });
            await maybeAutoConfirm(docId, lowConfLines);
        }
    }
    emit({ type: 'doc-done', docId, failed: pageErrors.length > 0 });
}

/**
 * Run Presidio de-identification over every page of a document, storing the
 * redacted text + findings on each ocrPages record.
 *
 * Returns the number of findings, or null when the feature is disabled.
 * Throws if the service is unreachable - the caller turns that into a failed
 * document, because quietly continuing would let un-redacted text reach the
 * review pane and the export.
 */
async function deidentifyDocument(docId, ocrPages) {
    const settings = await getSettings();
    if (!settings.deidEnabled) return null;

    emit({ type: 'deid-start', docId, pageCount: ocrPages.length });
    let spanCount = 0;
    for (let i = 0; i < ocrPages.length; i++) {
        const rec = ocrPages[i];
        // No entity/threshold filter here: analysis records every candidate so
        // the user's selection can be applied later as a live filter.
        const deid = await deidentifyPage(rec, { base: settings.deidBaseUrl });
        spanCount += deid.units.reduce((n, u) => n + u.spans.length, 0);
        // The original text stays untouched alongside the evidence; the
        // redacted copy is derived on demand (see pageOutputText).
        await putOcrPage({ ...rec, deid });
        emit({ type: 'deid-page', docId, pageIndex: i, pageCount: ocrPages.length });
    }
    emit({ type: 'deid-done', docId, spanCount });
    return spanCount;
}

/** Apply the review-mode gate: skip the human "check text" stop when allowed. */
async function maybeAutoConfirm(docId, lowConfLines) {
    const { reviewMode } = await getSettings();
    const clean = lowConfLines === 0;
    if (reviewMode === REVIEW_MODES.AUTO || (reviewMode === REVIEW_MODES.FLAGGED && clean)) {
        // ocr-confirmed routes into the extraction queue via app.js.
        await setDocumentStatus(docId, 'ocr-confirmed', { ocrAutoConfirmed: true });
    }
}
