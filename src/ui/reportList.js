/**
 * Left-sidebar report queue.
 *
 * Renders into #report-list: a toolbar (add files / CSV batch / export), a
 * search box, status filter chips with live counts (the batch dashboard), a
 * contextual batch action (Confirm all / Retry all), and the scrolling row
 * list. Clicking a row selects the document for the viewer + work panes.
 *
 * The whole sidebar is also a drop zone: any file drop starts the same
 * ingest flow as the picker.
 *
 * Auto-advance: reviewFlow.js emits `{ type: 'advance', fromStatus }` after a
 * confirm; we move the selection to the next visible document in the same
 * review stage so the abstractor lands on their next unit of work.
 */
import { allDocuments, deleteDocument, getOcrPagesByDoc } from '../db.js';
import { onAppEvent, emitAppEvent } from '../core/bus.js';
import { STATUS_META, setDocumentStatus } from '../core/status.js';
import { canExtract, canImportHandoff, canRead } from '../core/flags.js';
import { pageOutputText } from '../deid/deidentify.js';
import { ingestFiles } from '../ingest/ingest.js';
import { ingestFromMetadata } from '../ingest/metadataIngest.js';
import { importHandoff } from '../ingest/handoffImport.js';
import { combineExtractedData, combineOcrText, convertJsonToCsv } from '../results/processor.js';
import { buildHandoff, parseHandoff } from '../results/handoff.js';
import { isCurrentSchema } from '../deid/deidentify.js';
import { confirmOcr, confirmExtraction, retryDoc } from './reviewFlow.js';
import { showToast, confirmDialog, infoDialog } from './toast.js';

const MOUNT_ID = 'report-list';

const ACCEPTED_EXT = '.pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff';

/** Documents eligible for export: those whose reviewed output is final. */
const EXPORTABLE = canExtract
    ? ['confirmed', 'exported']
    : ['ocr-confirmed', 'exported'];

/** Filter chips: id -> { label, statuses (null = all) }. Without extraction
 *  those stages don't exist, so 'ocr-confirmed' is the Done bucket. */
const FILTERS = canExtract
    ? [
        { id: 'all',          label: 'All',          statuses: null },
        // Reading stages are dropped where nothing is read: in Extract mode
        // documents are imported straight into 'ocr-confirmed', so a chip for
        // 'ocr-running' could only ever show zero.
        { id: 'working',      label: 'Working',      statuses: canRead
            ? ['queued', 'ocr-running', 'ocr-confirmed', 'extraction-running']
            : ['ocr-confirmed', 'extraction-running'] },
        ...(canRead ? [{ id: 'check-text', label: 'Check text', statuses: ['ocr-done'] }] : []),
        { id: 'check-fields', label: 'Check fields', statuses: ['extraction-done'] },
        { id: 'done',         label: 'Done',         statuses: ['confirmed', 'exported'] },
        { id: 'failed',       label: 'Failed',       statuses: canRead
            ? ['ocr-failed', 'extraction-failed']
            : ['extraction-failed'] },
    ]
    : [
        { id: 'all',        label: 'All',        statuses: null },
        { id: 'working',    label: 'Working',    statuses: ['queued', 'ocr-running'] },
        { id: 'check-text', label: 'Check text', statuses: ['ocr-done'] },
        { id: 'done',       label: 'Done',       statuses: ['ocr-confirmed', 'exported'] },
        { id: 'failed',     label: 'Failed',     statuses: ['ocr-failed'] },
    ];

let selectionRef = null;   // { getSelected(), setSelected(id), subscribe(fn) }
let currentDocs = [];      // last-fetched list, in creation order
let activeFilter = 'all';
let searchTerm = '';

/**
 * Mount the report queue into #report-list.
 * @param {object} deps
 * @param {{ getSelected: () => (string|null), setSelected: (id: string|null) => void,
 *          subscribe: (fn: (id: string|null) => void) => (() => void) }} deps.selection
 */
export async function mountReportList(deps) {
    selectionRef = deps.selection;
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;

    mount.innerHTML = `
<div class="shrink-0 border-b border-gray-200 bg-gray-50 p-2 space-y-2">
    <div class="flex gap-1.5">
        ${!canRead ? '' : `
        <label for="rl-file-input" title="Upload PDFs or images (one report per PDF; loose images group into one report)"
               class="cursor-pointer flex-1 inline-flex items-center justify-center gap-1.5 rounded-md bg-green-800 px-2 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-green-700">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4">
                <path d="M9.25 13.25a.75.75 0 001.5 0V4.636l2.955 3.129a.75.75 0 001.09-1.03l-4.25-4.5a.75.75 0 00-1.09 0l-4.25 4.5a.75.75 0 101.09 1.03L9.25 4.636v8.614z"/>
                <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z"/>
            </svg>
            Add files
        </label>
        <input id="rl-file-input" type="file" multiple accept="${ACCEPTED_EXT}" class="sr-only"/>
        <label for="rl-metadata-input" title="Pick a folder containing metadata.csv to load a whole batch"
               class="cursor-pointer flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4">
                <path fill-rule="evenodd" d="M2 4.75A2.75 2.75 0 014.75 2h3.5A2.75 2.75 0 0111 4.75v0h4.25A2.75 2.75 0 0118 7.5v7.75A2.75 2.75 0 0115.25 18H4.75A2.75 2.75 0 012 15.25V4.75zM4.75 3.5A1.25 1.25 0 003.5 4.75v10.5c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25V7.5a1.25 1.25 0 00-1.25-1.25H10.25A1.75 1.75 0 018.5 4.5v-.25A.75.75 0 007.75 3.5H4.75z" clip-rule="evenodd"/>
            </svg>
            CSV batch
        </label>
        <input id="rl-metadata-input" type="file" webkitdirectory directory multiple class="sr-only"/>`}
        ${!canImportHandoff ? '' : `
        <label for="rl-handoff-input" title="Load a handoff file of de-identified OCR text from an air-gapped machine. These reports have no page images and go straight to extraction."
               class="cursor-pointer flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4">
                <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03L10.75 11.364V2.75z"/>
                <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z"/>
            </svg>
            Import text
        </label>
        <input id="rl-handoff-input" type="file" accept="application/json,.json" class="sr-only"/>`}
        <div id="rl-export-wrap" class="relative flex-1">
            <button id="rl-export" type="button" disabled title="Download the confirmed extractions"
                    class="w-full inline-flex items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4">
                    <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614l-2.955-3.129a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03L10.75 11.364V2.75z"/>
                    <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z"/>
                </svg>
                Export<span id="rl-export-count" class="text-gray-400"></span>
            </button>
            <div id="rl-export-menu" class="hidden absolute right-0 mt-1 w-52 rounded-md border border-gray-200 bg-white shadow-lg z-20">
                <button data-format="csv" class="rl-export-choice block w-full text-left px-3 py-2 text-xs text-gray-700 hover:bg-gray-100">Download CSV</button>
                <button data-format="json" class="rl-export-choice block w-full text-left px-3 py-2 text-xs text-gray-700 hover:bg-gray-100">Download JSON</button>
                ${!canExtract ? `
                <button data-format="handoff"
                        title="Per-page de-identified text, for importing on a machine that can reach an LLM. No page images."
                        class="rl-export-choice block w-full text-left px-3 py-2 text-xs text-gray-700 hover:bg-gray-100 border-t border-gray-200">
                    Download handoff (JSON)
                </button>` : ''}
            </div>
        </div>
    </div>
    <div id="rl-progress" style="display:none" class="items-center gap-2 text-xs text-gray-600">
        <div class="flex-1 h-1.5 bg-gray-200 rounded overflow-hidden">
            <div id="rl-progress-bar" class="h-full bg-green-600 transition-all" style="width:0%"></div>
        </div>
        <span id="rl-progress-label" class="truncate max-w-[10rem]"></span>
    </div>
    <input id="rl-search" type="search" placeholder="Search reports…"
           class="w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-xs focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"/>
    <div id="rl-filters" class="flex flex-wrap gap-1"></div>
    <div id="rl-batch"></div>
</div>
<div id="rl-scroll" class="flex-1 overflow-y-auto"></div>
<div class="shrink-0 border-t border-gray-200 px-3 py-1.5 text-[11px] text-gray-400 flex justify-between">
    <span><kbd class="font-sans">K</kbd>/<kbd class="font-sans">J</kbd> next / previous</span>
    <span><kbd class="font-sans">Enter</kbd> confirm</span>
</div>`;

    // Wire the file inputs. These exist only where there is an OCR stage to
    // feed - in Extract mode the only way in is a handoff file.
    const input = mount.querySelector('#rl-file-input');
    input?.addEventListener('change', async () => {
        if (!input.files?.length) return;
        const files = Array.from(input.files);
        input.value = '';
        await ingestAndRefresh(files);
    });

    const metadataInput = mount.querySelector('#rl-metadata-input');
    metadataInput?.addEventListener('change', async () => {
        if (!metadataInput.files?.length) return;
        const files = Array.from(metadataInput.files);
        metadataInput.value = '';
        await ingestMetadataAndRefresh(files);
    });

    // Handoff import exists only where there is an LLM to extract with.
    const handoffInput = mount.querySelector('#rl-handoff-input');
    handoffInput?.addEventListener('change', async () => {
        const file = handoffInput.files?.[0];
        handoffInput.value = '';
        if (file) await importHandoffAndRefresh(file);
    });

    // Whole sidebar is a drop-target. Prevent default on all four events so
    // the browser doesn't try to navigate to the file.
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((e) => {
        mount.addEventListener(e, (ev) => { ev.preventDefault(); ev.stopPropagation(); });
    });
    ['dragenter', 'dragover'].forEach((e) => {
        mount.addEventListener(e, () => mount.classList.add('bg-green-50'));
    });
    ['dragleave', 'drop'].forEach((e) => {
        mount.addEventListener(e, () => mount.classList.remove('bg-green-50'));
    });
    mount.addEventListener('drop', async (ev) => {
        // Dropping scans is the OCR entry point; with no OCR stage there is
        // nothing to do with them, and silently ingesting would strand them.
        if (!canRead) return;
        const files = Array.from(ev.dataTransfer?.files || []);
        if (files.length) await ingestAndRefresh(files);
    });

    // Search + selection redraw the rows.
    mount.querySelector('#rl-search').addEventListener('input', (e) => {
        searchTerm = e.target.value.trim().toLowerCase();
        renderRows();
    });
    deps.selection.subscribe(() => renderRows());

    // Export button + format menu.
    const exportBtn = mount.querySelector('#rl-export');
    const exportMenu = mount.querySelector('#rl-export-menu');
    exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        exportMenu.classList.toggle('hidden');
    });
    document.addEventListener('click', () => exportMenu.classList.add('hidden'));
    mount.querySelectorAll('.rl-export-choice').forEach((btn) => {
        btn.addEventListener('click', async () => {
            exportMenu.classList.add('hidden');
            await handleExport(btn.dataset.format);
        });
    });

    // Auto-advance after a confirm from the work pane / keyboard.
    onAppEvent((ev) => {
        if (ev.type === 'advance') selectNextWithStatus(ev.docId, ev.fromStatus);
    });

    await refresh();
}

/** Re-fetch documents from IDB and redraw everything. */
export async function refresh() {
    currentDocs = await allDocuments();
    renderFilters();
    renderBatchAction();
    renderRows();
    refreshExportAffordance();
}

// ---------- selection helpers (used by keyboard shortcuts + auto-advance) ----------

/** The docs matching the active filter chip + search term, grouped so all
 *  reports of one TCode sit together (order of first appearance). J/K
 *  navigation and rendering both follow this visual order. */
function visibleDocs() {
    const filter = FILTERS.find((f) => f.id === activeFilter) || FILTERS[0];
    const filtered = currentDocs.filter((d) => {
        if (filter.statuses && !filter.statuses.includes(d.status)) return false;
        if (!searchTerm) return true;
        const m = d.metadata;
        const hay = `${d.name || ''} ${m?.tcode || ''} ${m?.docid || ''}`.toLowerCase();
        return hay.includes(searchTerm);
    });
    const order = [];
    const groups = new Map(); // tcode (or per-doc key) -> docs
    for (const d of filtered) {
        const key = d.metadata?.tcode || `solo:${d.id}`;
        if (!groups.has(key)) { groups.set(key, []); order.push(key); }
        groups.get(key).push(d);
    }
    return order.flatMap((k) => groups.get(k));
}

/** Move the selection by delta within the visible rows (J/K navigation). */
export function selectRelative(delta) {
    const docs = visibleDocs();
    if (!docs.length) return;
    const cur = selectionRef?.getSelected();
    const idx = docs.findIndex((d) => d.id === cur);
    const next = idx === -1
        ? (delta > 0 ? docs[0] : docs[docs.length - 1])
        : docs[Math.min(docs.length - 1, Math.max(0, idx + delta))];
    selectionRef?.setSelected(next.id);
}

/** After confirming `afterId`, select the next visible doc still in `status`. */
function selectNextWithStatus(afterId, status) {
    const docs = visibleDocs().filter((d) => d.status === status || d.id === afterId);
    const idx = docs.findIndex((d) => d.id === afterId);
    const candidates = idx === -1 ? docs : [...docs.slice(idx + 1), ...docs.slice(0, idx)];
    const next = candidates.find((d) => d.status === status && d.id !== afterId);
    if (next) selectionRef?.setSelected(next.id);
}

/** The currently selected document record, if any. */
export function getSelectedDoc() {
    const id = selectionRef?.getSelected();
    return currentDocs.find((d) => d.id === id) || null;
}

// ---------- filters + batch actions ----------

function renderFilters() {
    const wrap = document.getElementById('rl-filters');
    if (!wrap) return;
    wrap.innerHTML = FILTERS.map((f) => {
        const count = f.statuses
            ? currentDocs.filter((d) => f.statuses.includes(d.status)).length
            : currentDocs.length;
        const active = f.id === activeFilter;
        const isFailed = f.id === 'failed';
        if (f.statuses && count === 0 && !active && f.id !== 'all') {
            return ''; // hide empty stages to keep the chip row quiet
        }
        return `<button type="button" data-filter="${f.id}"
            class="rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset transition-colors
                ${active
                    ? 'bg-green-800 text-white ring-green-800'
                    : isFailed && count > 0
                        ? 'bg-red-50 text-red-700 ring-red-300 hover:bg-red-100'
                        : 'bg-white text-gray-600 ring-gray-300 hover:bg-gray-100'}">
            ${f.label}${count ? ` <span class="${active ? 'text-green-200' : 'text-gray-400'}">${count}</span>` : ''}
        </button>`;
    }).join('');
    wrap.querySelectorAll('button[data-filter]').forEach((btn) => {
        btn.addEventListener('click', () => {
            activeFilter = btn.dataset.filter;
            renderFilters();
            renderBatchAction();
            renderRows();
        });
    });
}

function renderBatchAction() {
    const wrap = document.getElementById('rl-batch');
    if (!wrap) return;
    const docs = visibleDocs();
    let html = '';
    if (activeFilter === 'check-text' && docs.length) {
        html = batchButtonHtml('confirm-text', `Confirm text for all ${docs.length}`);
    } else if (activeFilter === 'check-fields' && docs.length) {
        html = batchButtonHtml('confirm-fields', `Confirm fields for all ${docs.length}`);
    } else if (activeFilter === 'failed' && docs.length) {
        html = batchButtonHtml('retry', `Retry all ${docs.length}`);
    }
    wrap.innerHTML = html;
    wrap.querySelector('button[data-batch]')?.addEventListener('click', () => runBatchAction(wrap.querySelector('button[data-batch]').dataset.batch));
}

function batchButtonHtml(action, label) {
    return `<button type="button" data-batch="${action}"
        class="w-full rounded-md border border-green-700 bg-green-50 px-2 py-1.5 text-xs font-medium text-green-800 hover:bg-green-100">
        ${label}
    </button>`;
}

async function runBatchAction(action) {
    // Re-read from IDB first: statuses may have moved since the last render
    // (e.g. flagged-mode auto-confirm), and acting on stale rows could rewind
    // a doc that has already progressed.
    currentDocs = await allDocuments();
    const docs = visibleDocs();
    if (!docs.length) return;
    if (action === 'confirm-text') {
        const ok = await confirmDialog({
            title: 'Confirm OCR text in bulk',
            bodyHtml: `Approve the OCR text of <strong>${docs.length}</strong> report${docs.length === 1 ? '' : 's'} without individual review? They will be queued for extraction.`,
            confirmLabel: `Confirm ${docs.length}`,
        });
        if (!ok) return;
        for (const d of docs) if (d.status === 'ocr-done') await confirmOcr(d.id, { advance: false });
        showToast(`${docs.length} report${docs.length === 1 ? '' : 's'} queued for extraction.`, { tone: 'success' });
    } else if (action === 'confirm-fields') {
        const ok = await confirmDialog({
            title: 'Confirm extracted fields in bulk',
            bodyHtml: `Mark the extracted fields of <strong>${docs.length}</strong> report${docs.length === 1 ? '' : 's'} as final without individual review?`,
            confirmLabel: `Confirm ${docs.length}`,
        });
        if (!ok) return;
        for (const d of docs) if (d.status === 'extraction-done') await confirmExtraction(d.id, { advance: false });
        showToast(`${docs.length} report${docs.length === 1 ? '' : 's'} marked done.`, { tone: 'success' });
    } else if (action === 'retry') {
        for (const d of docs) await retryDoc(d);
        showToast(`Retrying ${docs.length} report${docs.length === 1 ? '' : 's'}.`);
    }
    await refresh();
}

// ---------- export ----------

function refreshExportAffordance() {
    const btn = document.getElementById('rl-export');
    const count = document.getElementById('rl-export-count');
    if (!btn || !count) return;
    const eligible = currentDocs.filter((d) => EXPORTABLE.includes(d.status)).length;
    btn.disabled = eligible === 0;
    count.textContent = eligible > 0 ? ` ${eligible}` : '';
}

async function handleExport(format) {
    const eligible = currentDocs.filter((d) => EXPORTABLE.includes(d.status));
    if (!eligible.length) return;
    if (format === 'handoff') {
        await exportHandoff(eligible);
        return;
    }
    let rows;
    if (!canExtract) {
        // No extracted fields exist; export the reviewed OCR text instead,
        // reading each document's pages in stored order.
        const textByDoc = new Map();
        for (const d of eligible) {
            const pages = await getOcrPagesByDoc(d.id);
            const byKey = new Map(pages.map((p) => [p.pageBlobKey, p]));
            const text = (d.pages || [])
                .map((p, i) => {
                    // Redacted copy when de-identification ran, else raw OCR.
                    const md = pageOutputText(byKey.get(p.blobKey));
                    return (d.pages.length > 1 ? `--- Page ${i + 1} ---\n` : '') + md;
                })
                .join('\n\n')
                .trim();
            textByDoc.set(d.id, text);
        }
        rows = combineOcrText(eligible, textByDoc);
    } else {
        rows = combineExtractedData(eligible);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = canExtract ? 'extractions' : 'ocr-text';
    if (format === 'csv') {
        const csv = convertJsonToCsv(rows);
        triggerDownload(`${name}-${stamp}.csv`, 'text/csv', csv);
    } else {
        const json = JSON.stringify(rows, null, 2);
        triggerDownload(`${name}-${stamp}.json`, 'application/json', json);
    }
    // Mark each exported doc so the badge reflects the terminal state.
    // Via setDocumentStatus so the bus announces it (status strip, etc.).
    // The pre-export terminal status differs by build: 'confirmed' normally,
    // 'ocr-confirmed' when there is no extraction stage.
    const preExport = canExtract ? 'confirmed' : 'ocr-confirmed';
    for (const d of eligible) {
        if (d.status === preExport) {
            await setDocumentStatus(d.id, 'exported', { exportedAt: Date.now() });
        }
    }
    showToast(`Exported ${eligible.length} report${eligible.length === 1 ? '' : 's'} as ${format.toUpperCase()}.`, { tone: 'success' });
    await refresh();
}

/**
 * Write the air-gap handoff file: per-page de-identified text for a machine
 * that can reach an LLM. See src/results/handoff.js for the format and why it
 * is not the same artifact as the flat ocr-text export.
 */
async function exportHandoff(eligible) {
    const entries = [];
    for (const d of eligible) {
        const ocrPages = await getOcrPagesByDoc(d.id);
        const byKey = new Map(ocrPages.map((p) => [p.pageBlobKey, p]));
        const docPages = d.pages || [];
        const pages = docPages.map((p, i) => ({
            index: i + 1,
            // Redacted copy when de-identification ran, else raw OCR - the same
            // gate every other export path goes through.
            text: pageOutputText(byKey.get(p.blobKey)),
        }));
        // "Every page was analyzed", not "something was redacted": a clean page
        // and an unanalyzed one both produce zero spans.
        const deidentified = docPages.length > 0
            && docPages.every((p) => isCurrentSchema(byKey.get(p.blobKey)?.deid));
        entries.push({ doc: d, pages, deidentified });
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    triggerDownload(
        `ocr-handoff-${stamp}.json`,
        'application/json',
        JSON.stringify(buildHandoff(entries), null, 2),
    );

    for (const d of eligible) {
        if (d.status === 'ocr-confirmed') {
            await setDocumentStatus(d.id, 'exported', { exportedAt: Date.now() });
        }
    }

    // Un-redacted documents are exported with the flag false rather than
    // blocked, so say so plainly - the file then carries PHI across the gap.
    const bare = entries.filter((e) => !e.deidentified).length;
    showToast(
        `Handoff written: ${eligible.length} report${eligible.length === 1 ? '' : 's'}.`
        + (bare ? ` ${bare} not de-identified - this file contains identifiable text.` : ''),
        bare ? { tone: 'info', duration: 8000 } : { tone: 'success' },
    );
    await refresh();
}

function triggerDownload(filename, mime, content) {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Give the browser a beat to start the download before we free the URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- ingest ----------

/**
 * Load a handoff file of de-identified OCR text (the receiving half of the
 * air-gapped split workflow). The documents arrive already reviewed, so they
 * land at 'ocr-confirmed' and the status routing hands them to extraction.
 */
async function importHandoffAndRefresh(file) {
    const progress = document.getElementById('rl-progress');
    const bar = document.getElementById('rl-progress-bar');
    const label = document.getElementById('rl-progress-label');
    if (progress) progress.style.display = 'flex';
    try {
        // parseHandoff throws with a message worth showing: a file carried by
        // hand across an air gap must not fail silently.
        const parsed = parseHandoff(await file.text());
        const { docIds, pageCount, notDeidentified } = await importHandoff(parsed, (done, total, name) => {
            const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 100;
            if (bar) bar.style.width = pct + '%';
            if (label) label.textContent = `importing: ${name}`;
        });
        await refresh();
        if (docIds.length && selectionRef) selectionRef.setSelected(docIds[0]);
        showToast(
            `Imported ${docIds.length} report${docIds.length === 1 ? '' : 's'} (${pageCount} page${pageCount === 1 ? '' : 's'}).`
            + (notDeidentified ? ` ${notDeidentified} not de-identified.` : ''),
            notDeidentified ? { tone: 'info', duration: 8000 } : { tone: 'success' },
        );
    } catch (err) {
        console.error('[handoff-import] failed', err);
        showToast(`Import failed: ${err?.message || err}`, { tone: 'error', duration: 10000 });
    } finally {
        setTimeout(() => { if (progress) progress.style.display = 'none'; }, 300);
    }
}

async function ingestMetadataAndRefresh(files) {
    const progress = document.getElementById('rl-progress');
    const bar = document.getElementById('rl-progress-bar');
    const label = document.getElementById('rl-progress-label');
    if (progress) progress.style.display = 'flex';
    try {
        const { docIds, missing, skipped } = await ingestFromMetadata(files, ({ stage, done, total, message }) => {
            const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 100;
            if (bar) bar.style.width = pct + '%';
            if (label) label.textContent = message ? `${stage}: ${message}` : stage;
        });
        await refresh();
        if (docIds.length && selectionRef) selectionRef.setSelected(docIds[0]);
        if (skipped || (missing && missing.length)) {
            const items = missing.map((m) =>
                `<li class="font-mono text-xs">${escapeHtml(m.tcode)} · ${escapeHtml(m.docid)}${m.pages?.length ? ` (pages ${m.pages.join(', ')})` : ''}</li>`
            ).join('');
            await infoDialog({
                title: 'Batch loaded with gaps',
                bodyHtml: `
<p>Loaded <strong>${docIds.length}</strong> reports.</p>
${skipped ? `<p class="mt-1">${skipped} CSV row${skipped === 1 ? '' : 's'} skipped entirely (no matching files).</p>` : ''}
${items ? `<p class="mt-2 font-medium">Missing pages:</p><ul class="mt-1 space-y-0.5 list-disc pl-4">${items}</ul>` : ''}`,
            });
        } else if (docIds.length) {
            showToast(`Loaded ${docIds.length} report${docIds.length === 1 ? '' : 's'} from metadata.csv.`, { tone: 'success' });
        }
    } catch (err) {
        console.error('[metadata-ingest] failed', err);
        showToast(`Batch load failed: ${err?.message || err}`, { tone: 'error', duration: 8000 });
    } finally {
        setTimeout(() => { if (progress) progress.style.display = 'none'; }, 300);
    }
}

async function ingestAndRefresh(files) {
    const progress = document.getElementById('rl-progress');
    const bar = document.getElementById('rl-progress-bar');
    const label = document.getElementById('rl-progress-label');
    if (progress) progress.style.display = 'flex';

    try {
        const docIds = await ingestFiles(files, ({ stage, done, total, message }) => {
            const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 100;
            if (bar) bar.style.width = pct + '%';
            if (label) label.textContent = message ? `${stage}: ${message}` : stage;
        });
        await refresh();
        // Auto-select the first-ingested document so the viewer shows its pages.
        if (docIds.length && selectionRef) selectionRef.setSelected(docIds[0]);
    } catch (err) {
        console.error('[ingest] failed', err);
        showToast(`Upload failed: ${err?.message || err}`, { tone: 'error', duration: 8000 });
    } finally {
        setTimeout(() => { if (progress) progress.style.display = 'none'; }, 300);
    }
}

// ---------- rows ----------

function renderRows() {
    const scroll = document.getElementById('rl-scroll');
    if (!scroll) return;

    if (!currentDocs.length) {
        scroll.innerHTML = `
<div class="h-full flex items-center justify-center text-gray-400">
    <div class="text-center px-4">
        <p class="text-sm">Add report files to get started.</p>
        <p class="text-xs mt-1">Drop PDFs or images here, or load a folder with metadata.csv.</p>
    </div>
</div>`;
        return;
    }

    const docs = visibleDocs();
    if (!docs.length) {
        scroll.innerHTML = `
<div class="py-10 text-center text-xs text-gray-400">No reports match this filter.</div>`;
        return;
    }

    const selected = selectionRef?.getSelected();
    // Group headers for TCodes (visibleDocs already placed same-TCode
    // reports consecutively); solo uploads render as plain rows.
    let html = '';
    for (let i = 0; i < docs.length; i++) {
        const tcode = docs[i].metadata?.tcode || null;
        const prev = i > 0 ? (docs[i - 1].metadata?.tcode || null) : null;
        if (tcode && tcode !== prev) {
            let run = i;
            while (run < docs.length && (docs[run].metadata?.tcode || null) === tcode) run++;
            html += groupHeaderHtml(tcode, run - i);
        }
        html += rowHtml(docs[i], docs[i].id === selected, !!tcode);
    }
    scroll.innerHTML = html;

    // Row click -> select.
    scroll.querySelectorAll('[data-doc-id]').forEach((row) => {
        row.addEventListener('click', (ev) => {
            if (ev.target.closest('button')) return; // don't select when clicking Delete
            selectionRef?.setSelected(row.dataset.docId);
        });
    });

    // Delete buttons.
    scroll.querySelectorAll('button[data-delete-id]').forEach((btn) => {
        btn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const id = btn.dataset.deleteId;
            const doc = currentDocs.find((d) => d.id === id);
            const ok = await confirmDialog({
                title: 'Delete report',
                bodyHtml: `Delete <strong>${escapeHtml(doc?.metadata?.tcode || doc?.name || 'this report')}</strong> and its OCR text and extracted fields? This cannot be undone.`,
                confirmLabel: 'Delete',
                danger: true,
            });
            if (!ok) return;
            await deleteDocument(id);
            // Announce so the status strip (and anyone else) recounts.
            emitAppEvent({ source: 'ui', type: 'doc-deleted', docId: id });
            if (selectionRef?.getSelected() === id) selectionRef.setSelected(null);
            await refresh();
        });
    });

    // Keep the selected row in view when selection moved via keyboard/advance.
    scroll.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
}

function groupHeaderHtml(tcode, count) {
    return `
<div class="px-3 py-1 bg-gray-100/80 border-b border-gray-200 flex items-baseline justify-between">
    <span class="text-[11px] font-semibold tracking-wide text-gray-700">${escapeHtml(tcode)}</span>
    <span class="text-[10px] text-gray-400">${count} report${count === 1 ? '' : 's'}</span>
</div>`;
}

/**
 * One compact single-line row (batches run to hundreds of reports, so
 * height matters). Status is the colored dot + short label; docid/name
 * truncates; page count and date live in the hover tooltip only.
 */
function rowHtml(doc, isSelected, grouped) {
    const status = STATUS_META[doc.status] || STATUS_META.queued;
    const m = doc.metadata;
    const label = grouped ? (m?.docid || doc.name) : (m?.tcode || doc.name || 'Untitled report');
    const tipParts = [doc.name, m?.yearmonthLabel, `${doc.pages?.length ?? 0} page${(doc.pages?.length ?? 0) === 1 ? '' : 's'}`, status.label];
    const lowConf = doc.status === 'ocr-done' && doc.lowConfLines > 0
        ? `<span class="shrink-0 inline-flex items-center rounded bg-yellow-50 text-yellow-800 ring-1 ring-inset ring-yellow-300 px-1 text-[10px]"
                 title="${doc.lowConfLines} region${doc.lowConfLines === 1 ? '' : 's'} the OCR engine was unsure about">${doc.lowConfLines}</span>`
        : '';

    return `
<div data-doc-id="${doc.id}" ${isSelected ? 'aria-current="true"' : ''}
     title="${escapeAttr(tipParts.filter(Boolean).join(' · '))}"
     class="group cursor-pointer flex items-center gap-2 border-b border-gray-50 ${grouped ? 'pl-5' : 'pl-3'} pr-2 py-1.5 ${isSelected ? 'bg-green-50 border-l-2 border-l-green-700' : 'border-l-2 border-l-transparent hover:bg-gray-50'}">
    <span class="w-2 h-2 rounded-full shrink-0 ${status.dot}"></span>
    <span class="flex-1 min-w-0 truncate text-xs font-medium text-gray-900">${escapeHtml(label)}</span>
    ${lowConf}
    <span class="shrink-0 text-[10px] whitespace-nowrap ${status.text}">${status.label}</span>
    <button type="button" data-delete-id="${doc.id}" title="Delete report" aria-label="Delete report"
            class="shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 text-gray-400 hover:text-red-600 transition-opacity">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5">
            <path fill-rule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clip-rule="evenodd"/>
        </svg>
    </button>
</div>`;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}
function escapeAttr(s) {
    return escapeHtml(s);
}
