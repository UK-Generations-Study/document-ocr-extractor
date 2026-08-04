/**
 * Document status vocabulary + the single write path for status transitions.
 *
 * Lifecycle:
 *   queued -> ocr-running -> ocr-done -> ocr-confirmed
 *          -> extraction-running -> extraction-done -> confirmed -> exported
 * Failure branches (terminal until the user retries):
 *   ocr-running -> ocr-failed          (Retry sets back to queued)
 *   extraction-* -> extraction-failed  (Retry sets back to ocr-confirmed)
 *
 * All status writes should go through setDocumentStatus so the change is
 * announced on the bus; app.js listens there to route documents into the
 * OCR / extraction queues. Writing a doc's status with a bare putDocument
 * would silently skip that routing.
 */
import { getDocument, putDocument } from '../db.js';
import { emitAppEvent } from './bus.js';
import { canExtract } from './flags.js';

/** Presentation metadata per status, in the abstractor's vocabulary. */
export const STATUS_META = {
    'queued':             { label: 'Waiting',       dot: 'bg-gray-400',   text: 'text-gray-600',  badge: 'bg-gray-100 text-gray-700 ring-gray-300' },
    'ocr-running':        { label: 'Reading…',      dot: 'bg-blue-500',   text: 'text-blue-700',  badge: 'bg-blue-50 text-blue-700 ring-blue-300' },
    'ocr-done':           { label: 'Check text',    dot: 'bg-amber-500',  text: 'text-amber-700', badge: 'bg-amber-50 text-amber-800 ring-amber-300' },
    'ocr-confirmed':      { label: 'Text OK',       dot: 'bg-indigo-400', text: 'text-indigo-700',badge: 'bg-indigo-50 text-indigo-700 ring-indigo-300' },
    'extraction-running': { label: 'Extracting…',   dot: 'bg-blue-500',   text: 'text-blue-700',  badge: 'bg-blue-50 text-blue-700 ring-blue-300' },
    'extraction-done':    { label: 'Check fields',  dot: 'bg-amber-500',  text: 'text-amber-700', badge: 'bg-amber-50 text-amber-800 ring-amber-300' },
    'confirmed':          { label: 'Done',          dot: 'bg-green-600',  text: 'text-green-700', badge: 'bg-green-50 text-green-700 ring-green-300' },
    'exported':           { label: 'Exported',      dot: 'bg-green-300',  text: 'text-gray-500',  badge: 'bg-gray-100 text-gray-500 ring-gray-300' },
    'ocr-failed':         { label: 'OCR failed',    dot: 'bg-red-500',    text: 'text-red-700',   badge: 'bg-red-50 text-red-700 ring-red-300' },
    'extraction-failed':  { label: 'Extraction failed', dot: 'bg-red-500', text: 'text-red-700',  badge: 'bg-red-50 text-red-700 ring-red-300' },
};

// With no extraction stage, confirming the text IS the finish line - relabel
// it accordingly (green "Done" rather than the in-progress indigo "Text OK"
// that hands off to extraction).
if (!canExtract) {
    STATUS_META['ocr-confirmed'] = {
        label: 'Done', dot: 'bg-green-600', text: 'text-green-700',
        badge: 'bg-green-50 text-green-700 ring-green-300',
    };
}

/** Statuses whose work pane is the OCR view. */
export const OCR_PANE_STATUSES = new Set(['queued', 'ocr-running', 'ocr-done', 'ocr-failed']);
/** Statuses whose work pane is the extraction view. */
export const EXTRACTION_PANE_STATUSES = new Set([
    'ocr-confirmed', 'extraction-running', 'extraction-done', 'extraction-failed', 'confirmed', 'exported',
]);

/**
 * Set a document's status (optionally patching other fields at the same time)
 * and announce the transition on the bus.
 * @returns the updated document record, or null if the doc no longer exists.
 */
export async function setDocumentStatus(docId, status, patch = {}) {
    const doc = await getDocument(docId);
    if (!doc) return null;
    Object.assign(doc, patch);
    const changed = doc.status !== status;
    doc.status = status;
    await putDocument(doc);
    if (changed) emitAppEvent({ source: 'doc', type: 'status', docId, status });
    return doc;
}
