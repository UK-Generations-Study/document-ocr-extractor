/**
 * App-wide event bus.
 *
 * A single pub/sub channel replacing the three per-module listener sets that
 * the OCR queue, Deep Read queue, and extraction queue used to own. Every
 * event carries a `source` ('ocr' | 'deep' | 'extract' | 'doc' | 'ingest' |
 * 'settings' | 'ui') so subscribers can filter, plus the same `type`/`docId`
 * payloads as before.
 *
 * Status transitions are the backbone: emitting `{ type: 'status', docId,
 * status }` is what drives the queue routing in app.js (queued -> OCR queue,
 * ocr-confirmed -> extraction queue), so status changes must go through
 * setDocumentStatus in src/core/status.js rather than bare putDocument calls.
 */
const listeners = new Set();

/** Subscribe to all app events. Returns an unsubscribe function. */
export function onAppEvent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function emitAppEvent(event) {
    for (const fn of listeners) {
        try { fn(event); } catch (err) { console.error('[bus] listener error', err, event); }
    }
}
