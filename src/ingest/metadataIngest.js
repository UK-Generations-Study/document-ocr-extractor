/**
 * Metadata-CSV ingest path.
 *
 * The abstractor picks a folder (typically the parent of BBD_Path_Reports/)
 * via <input type="file" webkitdirectory>. We look for metadata.csv at any
 * depth, parse it, and for each row resolve the pages under
 *    BBD_Path_Reports/<yearmonth>/<mm>/<CB_DOCID>.<3-digit page number>
 * decode each single-page TIFF to a PNG, and store one document record per
 * CSV row with { tcode, yearmonth, mm, docid, pageCount } tucked onto
 * doc.metadata so the report list can render it richly.
 *
 * Decoding runs in a small pool of workers (tiffDecode.worker.js): a batch of
 * hundreds of pages used to decode serially on the main thread and freeze
 * the UI for its whole duration.
 */
import { putBlob, putDocument } from '../db.js';
import { emitAppEvent } from '../core/bus.js';

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

/**
 * Worker pool for TIFF -> PNG decodes. Buffers are transferred (zero-copy);
 * jobs are matched to replies by id. Sized to a few cores - decode is
 * CPU-bound, and more workers than that just multiplies peak memory.
 */
function createTiffPool() {
    const size = Math.min(4, Math.max(2, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
    const workers = [];
    const jobs = new Map(); // id -> { resolve, reject }
    let nextId = 1;
    let rr = 0;

    for (let i = 0; i < size; i++) {
        const w = new Worker(new URL('./tiffDecode.worker.js', import.meta.url), { type: 'module' });
        w.onmessage = (e) => {
            const { id, ok, blob, width, height, error } = e.data;
            const job = jobs.get(id);
            if (!job) return;
            jobs.delete(id);
            if (ok) job.resolve({ blob, width, height });
            else job.reject(new Error(error));
        };
        w.onerror = (e) => {
            // A crashed worker fails all of its outstanding jobs; page-level
            // callers treat that like any other decode failure.
            for (const [id, job] of jobs) {
                job.reject(new Error(e.message || 'TIFF decode worker crashed'));
                jobs.delete(id);
            }
        };
        workers.push(w);
    }

    return {
        size,
        async decode(file) {
            const buffer = await file.arrayBuffer();
            const id = nextId++;
            const w = workers[rr++ % workers.length];
            return new Promise((resolve, reject) => {
                jobs.set(id, { resolve, reject });
                w.postMessage({ id, buffer, name: file.name }, [buffer]);
            });
        },
        terminate() {
            for (const w of workers) w.terminate();
        },
    };
}

/** Run `tasks` (functions returning promises) with at most `limit` in flight. */
async function runWithConcurrency(tasks, limit) {
    const results = new Array(tasks.length);
    let next = 0;
    const lanes = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
        while (next < tasks.length) {
            const i = next++;
            results[i] = await tasks[i]();
        }
    });
    await Promise.all(lanes);
    return results;
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

    const pool = createTiffPool();
    try {
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            const nPages = Number(r.CB_PAGES) || 0;
            const missingPages = [];

            // Decode this row's pages in parallel across the worker pool,
            // keeping page order in the results array.
            const tasks = [];
            for (let p = 1; p <= nPages; p++) {
                const pageNo = p;
                const key = `${r.yearmonth}/${r.mm}/${r.CB_DOCID}.${String(p).padStart(3, '0')}`;
                const f = fileIdx.get(key);
                tasks.push(async () => {
                    if (!f) return { pageNo, missing: true };
                    try {
                        const { blob, width, height } = await pool.decode(f);
                        const pageKey = uid('page');
                        await putBlob(pageKey, blob);
                        done++;
                        emit('rasterizing', done, totalPages, `${r.TCode} · ${r.CB_DOCID} page ${pageNo}/${nPages}`);
                        return { pageNo, page: { blobKey: pageKey, width, height, sourceIdx: 0, sourcePage: pageNo } };
                    } catch (err) {
                        console.warn(`[metadata-ingest] TIFF decode failed for ${key}`, err);
                        done++;
                        return { pageNo, missing: true };
                    }
                });
            }
            const results = await runWithConcurrency(tasks, pool.size);
            const pages = [];
            for (const res of results) {
                if (res.missing) missingPages.push(res.pageNo);
                else pages.push(res.page);
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
            // Announce so app.js routes the new doc into the OCR queue.
            emitAppEvent({ source: 'ingest', type: 'status', docId, status: 'queued' });
            docIds.push(docId);
        }
    } finally {
        pool.terminate();
    }

    emit('done', totalPages, totalPages);
    return { docIds, missing, skipped };
}
