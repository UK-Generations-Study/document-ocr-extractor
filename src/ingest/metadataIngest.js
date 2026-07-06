/**
 * Metadata-CSV ingest path.
 *
 * The abstractor picks a folder (typically the parent of BBD_Path_Reports/)
 * via <input type="file" webkitdirectory>. We look for metadata.csv at any
 * depth, parse it, and for each row resolve the pages under
 *    BBD_Path_Reports/<yearmonth>/<mm>/<CB_DOCID>.<3-digit page number>
 * decode each single-page TIFF to a PNG via utif, and store one document
 * record per CSV row with { tcode, yearmonth, mm, docid, pageCount } tucked
 * onto doc.metadata so the report list can render it richly.
 */
import UTIF from 'utif';
import { putBlob, putDocument } from '../db.js';

/** Simple csv parser: no quoting, no embedded commas, no escapes. Enough for
 *  the columnar metadata format described in the task. */
function parseCsv(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    const header = lines[0].split(',').map((h) => h.trim());
    return lines.slice(1).map((line) => {
        const cells = line.split(',').map((c) => c.trim());
        const row = {};
        for (let i = 0; i < header.length; i++) row[header[i]] = cells[i];
        return row;
    });
}

/** Trim leading path components until <yearmonth>/<mm>/<docid>.<n> matches. */
function trailingPath(file) {
    // webkitRelativePath is "picked-folder/BBD_Path_Reports/201207/02/15738246.001"
    const p = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
    return p;
}

/** Build a lookup keyed by "<yearmonth>/<mm>/<docid>.<page>". */
function indexReportFiles(files) {
    const map = new Map();
    for (const f of files) {
        const rel = trailingPath(f);
        // Match `.../BBD_Path_Reports/<ym>/<mm>/<docid>.<page>`
        const m = rel.match(/BBD_Path_Reports\/(\d+)\/(\d+)\/(\d+)\.(\d+)$/);
        if (!m) continue;
        const [, ym, mm, docid, page] = m;
        map.set(`${ym}/${mm}/${docid}.${page}`, f);
    }
    return map;
}

function findMetadataCsv(files) {
    // The picked folder may sit under one wrapper directory; accept the first
    // file whose basename is exactly "metadata.csv".
    return Array.from(files).find((f) => {
        const rel = trailingPath(f);
        return rel.endsWith('/metadata.csv') || rel === 'metadata.csv' || f.name === 'metadata.csv';
    });
}

/** utif decode a single-page TIFF Blob and return a PNG Blob + dimensions. */
async function tiffToPngBlob(file) {
    const buf = await file.arrayBuffer();
    const ifds = UTIF.decode(buf);
    if (!ifds || !ifds.length) throw new Error(`no TIFF pages in ${file.name}`);
    const ifd = ifds[0];
    UTIF.decodeImage(buf, ifd);
    const rgba = UTIF.toRGBA8(ifd);
    const width = ifd.width;
    const height = ifd.height;
    const canvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d');
    const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
    ctx.putImageData(imageData, 0, 0);
    const blob = 'convertToBlob' in canvas
        ? await canvas.convertToBlob({ type: 'image/png' })
        : await new Promise((r) => canvas.toBlob(r, 'image/png'));
    return { blob, width, height };
}

function uid(prefix) {
    const rand = Math.random().toString(36).slice(2, 10);
    return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

/** Format a "201207" yearmonth as "Jul 2012" (short human label). */
function yyyymmToLabel(ym) {
    if (!/^\d{6}$/.test(ym)) return ym;
    const y = ym.slice(0, 4);
    const m = Number(ym.slice(4, 6));
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[m - 1] || ym.slice(4, 6)} ${y}`;
}

/**
 * @param {FileList|File[]} files      Everything the abstractor picked.
 * @param {(p: { stage: string, done: number, total: number, message?: string }) => void} [onProgress]
 * @returns {Promise<{ docIds: string[], missing: Array<{tcode, docid, pages: number[]}>, skipped: number }>}
 */
export async function ingestFromMetadata(files, onProgress) {
    const emit = (stage, done, total, message) => onProgress?.({ stage, done, total, message });

    const csvFile = findMetadataCsv(files);
    if (!csvFile) throw new Error('metadata.csv not found in the picked folder.');
    const csvText = await csvFile.text();
    const rows = parseCsv(csvText);
    const fileIdx = indexReportFiles(files);

    const totalPages = rows.reduce((n, r) => n + Number(r.CB_PAGES || 0), 0);
    let done = 0;
    const docIds = [];
    const missing = [];
    let skipped = 0;

    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const nPages = Number(r.CB_PAGES) || 0;
        const pages = [];
        const missingPages = [];
        for (let p = 1; p <= nPages; p++) {
            const key = `${r.yearmonth}/${r.mm}/${r.CB_DOCID}.${String(p).padStart(3, '0')}`;
            const f = fileIdx.get(key);
            if (!f) { missingPages.push(p); continue; }
            emit('rasterizing', done, totalPages, `${r.TCode} · ${r.CB_DOCID} page ${p}/${nPages}`);
            try {
                const { blob, width, height } = await tiffToPngBlob(f);
                const pageKey = uid('page');
                await putBlob(pageKey, blob);
                pages.push({ blobKey: pageKey, width, height, sourceIdx: 0, sourcePage: p });
                done++;
            } catch (err) {
                console.warn(`[metadata-ingest] TIFF decode failed for ${key}`, err);
                missingPages.push(p);
                done++;
            }
        }
        if (!pages.length) {
            skipped++;
            missing.push({ tcode: r.TCode, docid: r.CB_DOCID, pages: missingPages });
            continue;
        }
        if (missingPages.length) {
            missing.push({ tcode: r.TCode, docid: r.CB_DOCID, pages: missingPages });
        }
        const docId = uid('doc');
        const doc = {
            id: docId,
            name: r.TCode, // primary label; UI shows this + subtitle
            createdAt: Date.now(),
            status: 'queued',
            sources: [],
            pages,
            metadata: {
                tcode: r.TCode,
                yearmonth: r.yearmonth,
                yearmonthLabel: yyyymmToLabel(r.yearmonth),
                mm: r.mm,
                docid: r.CB_DOCID,
                pageCount: nPages,
            },
        };
        await putDocument(doc);
        docIds.push(docId);
    }

    emit('done', totalPages, totalPages);
    return { docIds, missing, skipped };
}
