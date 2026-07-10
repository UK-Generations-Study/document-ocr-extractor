/**
 * Ingest pipeline: turn a File[] into one or more `documents` records with
 * rasterized page blobs.
 *
 * Grouping rule (Phase 3): a single upload event forms
 *   - one document per PDF file (multi-page PDFs keep all pages inside it), and
 *   - one document grouping all loose images from the same event, in the order
 *     the user picked them.
 * This means "click Start new report between drops" is implicit here - a new
 * upload event IS a new report.
 *
 * PDF pages are rasterized to PNG blobs via src/ocr/orchestrate/pdf-raster.ts
 * (already tuned for pixel budget and megapixel cap). Images are stored as-is
 * plus a `<img>` decode to capture their intrinsic width/height so the report
 * viewer can layout page slots before the blob has been loaded from IDB.
 *
 * Progress callback: `onProgress({ stage, done, total, message })`. Stages:
 *   'reading'   - image decode metadata pass
 *   'rasterizing' - PDF pages being rendered
 *   'saving'    - writing to IndexedDB
 *   'done'
 */
import { openPdfForRaster } from '../ocr/orchestrate/pdf-raster.ts';
import { putBlob, putDocument } from '../db.js';
import { emitAppEvent } from '../core/bus.js';

/** Persist a new doc and announce it so app.js routes it into the OCR queue. */
async function saveNewDocument(doc) {
    await putDocument(doc);
    emitAppEvent({ source: 'ingest', type: 'status', docId: doc.id, status: doc.status });
}

/** File extensions we treat as PDFs. */
const PDF_EXT = /\.pdf$/i;
/** File extensions we treat as images. Anything else is rejected. */
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

function isPdf(file) {
    return file.type === 'application/pdf' || PDF_EXT.test(file.name);
}
function isImage(file) {
    return (file.type && file.type.startsWith('image/')) || IMAGE_EXT.test(file.name);
}

/** Random-ish id suitable for a keyPath. */
function uid(prefix) {
    const rand = Math.random().toString(36).slice(2, 10);
    return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

/** Read an image blob's intrinsic dimensions. */
async function readImageDims(blob) {
    // createImageBitmap is faster and works off-DOM, but not on every Safari.
    if (typeof createImageBitmap === 'function') {
        try {
            const bmp = await createImageBitmap(blob);
            const { width, height } = bmp;
            bmp.close?.();
            return { width, height };
        } catch { /* fall through to <img> decode */ }
    }
    const url = URL.createObjectURL(blob);
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return { width: img.naturalWidth, height: img.naturalHeight };
    } finally {
        URL.revokeObjectURL(url);
    }
}

/**
 * Ingest a batch of files, produce one or more `documents` records.
 * @param {File[]} files
 * @param {(p: {stage: string, done: number, total: number, message?: string}) => void} [onProgress]
 * @returns {Promise<string[]>} document ids in creation order
 */
export async function ingestFiles(files, onProgress) {
    const emit = (stage, done, total, message) => onProgress?.({ stage, done, total, message });

    // Partition: PDFs (each its own report) + one image bucket (all images this event).
    const pdfs = [];
    const images = [];
    for (const f of files) {
        if (isPdf(f)) pdfs.push(f);
        else if (isImage(f)) images.push(f);
        // Silently drop unknown types; the picker's `accept` should have filtered them.
    }

    // Open each PDF once and keep the parsed document around for its page
    // rasters: re-parsing per page made an n-page PDF O(n²) to ingest.
    emit('reading', 0, files.length, 'reading files…');
    const pdfDocs = [];
    for (const pdf of pdfs) {
        pdfDocs.push(await openPdfForRaster(pdf));
    }
    const totalPages = pdfDocs.reduce((a, d) => a + d.numPages, 0) + images.length;

    let done = 0;
    const docIds = [];

    // Process each PDF as its own document.
    for (let i = 0; i < pdfs.length; i++) {
        const pdf = pdfs[i];
        const pdfDoc = pdfDocs[i];
        const pageCount = pdfDoc.numPages;
        const docId = uid('doc');
        const pdfBlobKey = uid('src');
        await putBlob(pdfBlobKey, pdf);

        const pages = [];
        try {
            for (let p = 1; p <= pageCount; p++) {
                emit('rasterizing', done, totalPages, `${pdf.name} page ${p} of ${pageCount}`);
                const { blob, width, height, scale } = await pdfDoc.rasterizePage(p);
                const pageKey = uid('page');
                await putBlob(pageKey, blob);
                pages.push({ blobKey: pageKey, width, height, sourceIdx: 0, sourcePage: p, scale });
                done++;
            }
        } finally {
            pdfDoc.destroy();
        }

        emit('saving', done, totalPages, `saving ${pdf.name}…`);
        const doc = {
            id: docId,
            name: pdf.name || `Report ${docIds.length + 1}`,
            createdAt: Date.now(),
            status: 'queued',
            sources: [{ kind: 'pdf', filename: pdf.name, blobKey: pdfBlobKey, pageCount }],
            pages,
        };
        await saveNewDocument(doc);
        docIds.push(docId);
    }

    // Group all loose images from this upload into one document (if any).
    if (images.length > 0) {
        const docId = uid('doc');
        const sources = [];
        const pages = [];
        for (let idx = 0; idx < images.length; idx++) {
            const img = images[idx];
            emit('reading', done, totalPages, `${img.name}`);
            const srcKey = uid('src');
            await putBlob(srcKey, img);
            // Image files ARE the display asset, so a source blob doubles as its page blob.
            const { width, height } = await readImageDims(img);
            sources.push({ kind: 'image', filename: img.name, blobKey: srcKey });
            pages.push({ blobKey: srcKey, width, height, sourceIdx: idx });
            done++;
        }

        emit('saving', done, totalPages, `saving image group…`);
        const doc = {
            id: docId,
            name: images.length === 1
                ? images[0].name
                : `${images.length} images`,
            createdAt: Date.now(),
            status: 'queued',
            sources,
            pages,
        };
        await saveNewDocument(doc);
        docIds.push(docId);
    }

    emit('done', totalPages, totalPages);
    return docIds;
}
