/**
 * Load a handoff file (see src/results/handoff.js) as documents ready for
 * extraction - the receiving half of the air-gapped split workflow.
 *
 * These documents have no page images, on purpose: de-identification redacts
 * text only, so the originals stay on the air-gapped host. That makes them the
 * one kind of document in the app whose pages have no blob, which is what
 * `textOnly` marks so the UI can render text where it would otherwise draw a
 * page image.
 *
 * Each page is stored as an ordinary ocrPage whose `markdown` is the
 * transferred text and which carries NO `deid` record. That is not a shortcut:
 * pageOutputText returns `markdown` verbatim when there are no de-identification
 * units (deidentify.js), so extraction sees exactly the bytes that crossed the
 * gap - no re-derivation, nothing to drift. The text arrived already redacted;
 * re-analyzing it would only find PHI that is no longer there.
 *
 * Imported documents land at 'ocr-confirmed'. The text was reviewed on the
 * other machine, so the OCR review stage is already done, and that status is
 * exactly the handoff point into the extraction queue (see app.js's status
 * routing). It also keeps them out of the OCR queue permanently: nothing but
 * the OCR queue writes 'ocr-failed', and only 'queued' enqueues OCR, so a
 * document that never enters cannot be sent back to it by Retry.
 */
import { putDocument, putOcrPage } from '../db.js';
import { emitAppEvent } from '../core/bus.js';

/**
 * Nominal page dimensions for imported pages, in pixels (A4 at 150dpi).
 *
 * There is no image to measure, but width/height are not decorative: both page
 * panes set `aspect-ratio: width / height` on every page card, and the two are
 * kept in lockstep so page N lines up across them and the scroll link stays
 * exact. Omitting them would emit `aspect-ratio: undefined / undefined`, which
 * the browser drops, collapsing the card heights. A plausible portrait ratio
 * keeps every existing consumer working without a special case.
 */
const NOMINAL_PAGE_WIDTH = 1240;
const NOMINAL_PAGE_HEIGHT = 1754;

function uid(prefix) {
    const rand = Math.random().toString(36).slice(2, 10);
    return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

/** Format a "201207" yearmonth as "Jul 2012", matching metadataIngest. */
function yyyymmToLabel(ym) {
    if (!/^\d{6}$/.test(String(ym || ''))) return ym || '';
    const y = String(ym).slice(0, 4);
    const m = Number(String(ym).slice(4, 6));
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${names[m - 1] || '?'} ${y}`;
}

/**
 * Create documents from a parsed handoff.
 *
 * @param {{documents: object[]}} parsed output of parseHandoff
 * @param {(done: number, total: number, label: string) => void} [onProgress]
 * @returns {Promise<{docIds: string[], pageCount: number, notDeidentified: number}>}
 */
export async function importHandoff(parsed, onProgress) {
    const docs = parsed.documents;
    const docIds = [];
    let pageCount = 0;
    let notDeidentified = 0;

    for (let i = 0; i < docs.length; i++) {
        const d = docs[i];
        const docId = uid('doc');
        const tcode = d.identifiers.TCode;
        const label = tcode || d.fileName || `Report ${i + 1}`;
        onProgress?.(i, docs.length, label);

        const pages = [];
        for (const p of d.pages) {
            const pageKey = uid('page');
            // No blob is written - there is no image to write.
            pages.push({
                blobKey: pageKey,
                width: NOMINAL_PAGE_WIDTH,
                height: NOMINAL_PAGE_HEIGHT,
                sourceIdx: 0,
                sourcePage: p.index,
            });
            await putOcrPage({
                pageBlobKey: pageKey,
                docId,
                markdown: p.text,
                // No blocks: block structure does not cross the gap, and
                // nothing downstream of import needs it. pageOutputText
                // returns `markdown` untouched when there is no deid record.
                blocks: [],
                uncertainty: null,
                width: NOMINAL_PAGE_WIDTH,
                height: NOMINAL_PAGE_HEIGHT,
                stageMs: {},
                totalMs: 0,
                source: 'handoff',
                updatedAt: Date.now(),
            });
            pageCount++;
        }

        if (!d.deidentified) notDeidentified++;

        const doc = {
            id: docId,
            // TCode when the batch came through the metadata-CSV path, so
            // imported reports group and search the same way as local ones.
            name: label,
            createdAt: Date.now(),
            status: 'ocr-confirmed',
            sources: [],
            pages,
            /** No page images: the review pane renders text instead. */
            textOnly: true,
            /** False means the text was never de-identified - it may hold PHI. */
            deidentified: d.deidentified,
            importedAt: Date.now(),
            metadata: {
                tcode: tcode || null,
                yearmonth: d.identifiers.yearmonth || null,
                yearmonthLabel: yyyymmToLabel(d.identifiers.yearmonth),
                docid: d.identifiers.CB_DOCID || null,
                pageCount: d.pages.length,
            },
        };
        await putDocument(doc);
        // Announce so app.js routes the document into the extraction queue.
        emitAppEvent({ source: 'ingest', type: 'status', docId, status: 'ocr-confirmed' });
        docIds.push(docId);
    }

    onProgress?.(docs.length, docs.length, 'done');
    return { docIds, pageCount, notDeidentified };
}
