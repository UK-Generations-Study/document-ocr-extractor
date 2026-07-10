/**
 * Confirm / retry actions shared by the work-pane views, keyboard shortcuts,
 * and the sidebar's batch buttons. Each confirm announces an 'advance' event
 * so the report list can move the selection to the next document awaiting
 * the same review stage (the abstractor's next unit of work).
 */
import { emitAppEvent } from '../core/bus.js';
import { setDocumentStatus } from '../core/status.js';

/** Approve a document's OCR text; extraction is queued via status routing. */
export async function confirmOcr(docId, { advance = true } = {}) {
    await setDocumentStatus(docId, 'ocr-confirmed', { ocrAutoConfirmed: false });
    if (advance) emitAppEvent({ source: 'ui', type: 'advance', docId, fromStatus: 'ocr-done' });
}

/** Approve a document's extracted fields. */
export async function confirmExtraction(docId, { advance = true } = {}) {
    await setDocumentStatus(docId, 'confirmed', { confirmedAt: Date.now() });
    if (advance) emitAppEvent({ source: 'ui', type: 'advance', docId, fromStatus: 'extraction-done' });
}

/** Send a failed document back into the pipeline at the right stage. */
export async function retryDoc(doc) {
    if (!doc) return;
    if (doc.status === 'ocr-failed') {
        await setDocumentStatus(doc.id, 'queued', { lastError: null });
    } else if (doc.status === 'extraction-failed') {
        await setDocumentStatus(doc.id, 'ocr-confirmed', { lastError: null });
    }
}
