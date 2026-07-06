/**
 * Bottom-pane report list.
 *
 * Renders into #report-list. A thin toolbar at the top holds the Upload
 * button + an ingest progress readout; below that is the report table:
 * name, page count, status badge, and a delete action. Clicking a row
 * calls `selection.setSelected(id)` so the left pane can update.
 *
 * The whole pane is also a drop zone. Any drop of files, wherever it lands,
 * kicks off the same ingest flow as the picker.
 */
import { allDocuments, deleteDocument, putDocument } from '../db.js';
import { ingestFiles } from '../ingest/ingest.js';
import { ingestFromMetadata } from '../ingest/metadataIngest.js';
import { combineExtractedData, convertJsonToCsv } from '../results/processor.js';

const MOUNT_ID = 'report-list';

const ACCEPTED_EXT = '.pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff';

const STATUS_LABELS = {
    'queued': { label: 'Queued', cls: 'bg-gray-100 text-gray-700 ring-gray-300' },
    'ocr-running': { label: 'OCR…', cls: 'bg-blue-50 text-blue-700 ring-blue-300' },
    'ocr-done': { label: 'OCR done', cls: 'bg-blue-50 text-blue-700 ring-blue-300' },
    'ocr-confirmed': { label: 'OCR confirmed', cls: 'bg-indigo-50 text-indigo-700 ring-indigo-300' },
    'extraction-running': { label: 'Extracting…', cls: 'bg-amber-50 text-amber-700 ring-amber-300' },
    'extraction-done': { label: 'Extracted', cls: 'bg-amber-50 text-amber-700 ring-amber-300' },
    'confirmed': { label: 'Confirmed', cls: 'bg-green-50 text-green-700 ring-green-300' },
    'exported': { label: 'Exported', cls: 'bg-gray-100 text-gray-500 ring-gray-300' },
};

let selectionRef = null;   // { getSelected(), setSelected(id) }
let currentDocs = [];      // last-rendered list, in creation order

/**
 * Mount the report list into #report-list.
 * @param {object} deps
 * @param {{ getSelected: () => (string|null), setSelected: (id: string|null) => void,
 *          subscribe: (fn: (id: string|null) => void) => (() => void) }} deps.selection
 */
export async function mountReportList(deps) {
    selectionRef = deps.selection;
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;

    mount.classList.remove('overflow-auto');
    mount.classList.add('flex', 'flex-col', 'overflow-hidden');
    mount.innerHTML = `
<div class="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-gray-200 bg-gray-50">
    <label for="rl-file-input"
           class="cursor-pointer inline-flex items-center gap-1.5 rounded-md bg-green-800 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-green-700">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4">
            <path d="M9.25 13.25a.75.75 0 001.5 0V4.636l2.955 3.129a.75.75 0 001.09-1.03l-4.25-4.5a.75.75 0 00-1.09 0l-4.25 4.5a.75.75 0 101.09 1.03L9.25 4.636v8.614z"/>
            <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z"/>
        </svg>
        Upload files
    </label>
    <input id="rl-file-input" type="file" multiple accept="${ACCEPTED_EXT}" class="sr-only"/>
    <label for="rl-metadata-input"
           class="cursor-pointer inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4">
            <path fill-rule="evenodd" d="M2 4.75A2.75 2.75 0 014.75 2h3.5A2.75 2.75 0 0111 4.75v0h4.25A2.75 2.75 0 0118 7.5v7.75A2.75 2.75 0 0115.25 18H4.75A2.75 2.75 0 012 15.25V4.75zM4.75 3.5A1.25 1.25 0 003.5 4.75v10.5c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25V7.5a1.25 1.25 0 00-1.25-1.25H10.25A1.75 1.75 0 018.5 4.5v-.25A.75.75 0 007.75 3.5H4.75z" clip-rule="evenodd"/>
        </svg>
        Load from metadata CSV
    </label>
    <input id="rl-metadata-input" type="file" webkitdirectory directory multiple class="sr-only"/>
    <span id="rl-hint" class="text-xs text-gray-500">
        upload one report per drop, or pick a folder with metadata.csv to load a batch
    </span>
    <div id="rl-progress" class="hidden ml-auto flex items-center gap-2 text-xs text-gray-600">
        <div class="w-32 h-1.5 bg-gray-200 rounded overflow-hidden">
            <div id="rl-progress-bar" class="h-full bg-green-600 transition-all" style="width:0%"></div>
        </div>
        <span id="rl-progress-label"></span>
    </div>
    <div id="rl-export-wrap" class="ml-auto relative">
        <button id="rl-export" type="button" disabled
                class="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4">
                <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614l-2.955-3.129a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03L10.75 11.364V2.75z"/>
                <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z"/>
            </svg>
            Export <span id="rl-export-count" class="text-gray-500"></span>
        </button>
        <div id="rl-export-menu" class="hidden absolute right-0 mt-1 w-44 rounded-md border border-gray-200 bg-white shadow-lg z-20">
            <button data-format="csv" class="rl-export-choice block w-full text-left px-3 py-2 text-xs text-gray-700 hover:bg-gray-100">Download CSV</button>
            <button data-format="json" class="rl-export-choice block w-full text-left px-3 py-2 text-xs text-gray-700 hover:bg-gray-100">Download JSON</button>
        </div>
    </div>
</div>
<div id="rl-scroll" class="flex-1 overflow-auto"></div>
`;

    // Wire the file input + drop zone.
    const input = mount.querySelector('#rl-file-input');
    input.addEventListener('change', async () => {
        if (!input.files?.length) return;
        const files = Array.from(input.files);
        input.value = '';
        await ingestAndRefresh(files);
    });

    const metadataInput = mount.querySelector('#rl-metadata-input');
    metadataInput.addEventListener('change', async () => {
        if (!metadataInput.files?.length) return;
        const files = Array.from(metadataInput.files);
        metadataInput.value = '';
        await ingestMetadataAndRefresh(files);
    });

    // Whole pane is drop-target. Prevent default on all four events so the
    // browser doesn't try to navigate to the file.
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
        const files = Array.from(ev.dataTransfer?.files || []);
        if (files.length) await ingestAndRefresh(files);
    });

    // Redraw the table when selection changes elsewhere (e.g., row deleted).
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

    await refresh();
}

/** Re-fetch documents from IDB and redraw the rows. */
export async function refresh() {
    currentDocs = await allDocuments();
    renderRows();
    refreshExportAffordance();
}

function refreshExportAffordance() {
    const btn = document.getElementById('rl-export');
    const count = document.getElementById('rl-export-count');
    if (!btn || !count) return;
    const eligible = currentDocs.filter((d) => d.status === 'confirmed' || d.status === 'exported').length;
    btn.disabled = eligible === 0;
    count.textContent = eligible > 0 ? `(${eligible})` : '';
}

async function handleExport(format) {
    const eligible = currentDocs.filter((d) => d.status === 'confirmed' || d.status === 'exported');
    if (!eligible.length) return;
    const rows = combineExtractedData(eligible);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    if (format === 'csv') {
        const csv = convertJsonToCsv(rows);
        triggerDownload(`extractions-${stamp}.csv`, 'text/csv', csv);
    } else {
        const json = JSON.stringify(rows, null, 2);
        triggerDownload(`extractions-${stamp}.json`, 'application/json', json);
    }
    // Mark each exported doc so the badge reflects the terminal state.
    // Not idempotent: re-exporting 'exported' docs is fine, this is a no-op.
    for (const d of eligible) {
        if (d.status === 'confirmed') {
            d.status = 'exported';
            d.exportedAt = Date.now();
            await putDocument(d);
        }
    }
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

async function ingestMetadataAndRefresh(files) {
    const progress = document.getElementById('rl-progress');
    const bar = document.getElementById('rl-progress-bar');
    const label = document.getElementById('rl-progress-label');
    progress?.classList.remove('hidden');
    try {
        const { docIds, missing, skipped } = await ingestFromMetadata(files, ({ stage, done, total, message }) => {
            const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 100;
            if (bar) bar.style.width = pct + '%';
            if (label) label.textContent = message ? `${stage}: ${message}` : stage;
        });
        await refresh();
        if (docIds.length && selectionRef) selectionRef.setSelected(docIds[0]);
        if (skipped || (missing && missing.length)) {
            const details = missing.map((m) => `${m.tcode} · ${m.docid}${m.pages?.length ? ` (pages ${m.pages.join(', ')})` : ''}`).join('\n');
            alert(`Loaded ${docIds.length} reports.` +
                (skipped ? ` ${skipped} row${skipped === 1 ? '' : 's'} skipped (no matching files).` : '') +
                (missing.length ? `\n\nMissing pages:\n${details}` : ''));
        }
    } catch (err) {
        console.error('[metadata-ingest] failed', err);
        alert(`Metadata ingest failed: ${err?.message || err}`);
    } finally {
        setTimeout(() => progress?.classList.add('hidden'), 300);
    }
}

async function ingestAndRefresh(files) {
    const progress = document.getElementById('rl-progress');
    const bar = document.getElementById('rl-progress-bar');
    const label = document.getElementById('rl-progress-label');
    progress?.classList.remove('hidden');

    try {
        const docIds = await ingestFiles(files, ({ stage, done, total, message }) => {
            const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 100;
            if (bar) bar.style.width = pct + '%';
            if (label) label.textContent = message ? `${stage}: ${message}` : stage;
        });
        await refresh();
        // Auto-select the first-ingested document so the left pane shows its pages.
        if (docIds.length && selectionRef) selectionRef.setSelected(docIds[0]);
    } catch (err) {
        console.error('[ingest] failed', err);
        alert(`Upload failed: ${err?.message || err}`);
    } finally {
        setTimeout(() => progress?.classList.add('hidden'), 300);
    }
}

function renderRows() {
    const scroll = document.getElementById('rl-scroll');
    if (!scroll) return;

    if (!currentDocs.length) {
        scroll.innerHTML = `
<div class="w-full h-full flex items-center justify-center text-gray-400">
    <div class="text-center px-4">
        <p class="text-sm">Upload a PDF or a set of images to get started.</p>
        <p class="text-xs mt-1">Every upload becomes one report; PDFs stay together, loose images group.</p>
    </div>
</div>`;
        return;
    }

    const selected = selectionRef?.getSelected();
    scroll.innerHTML = `
<table class="min-w-full text-sm">
    <thead class="sticky top-0 bg-gray-50 text-xs text-gray-600 uppercase">
        <tr>
            <th class="px-3 py-2 text-left font-medium">Report</th>
            <th class="px-3 py-2 text-left font-medium">Pages</th>
            <th class="px-3 py-2 text-left font-medium">Status</th>
            <th class="px-3 py-2 text-left font-medium">Added</th>
            <th class="px-3 py-2 text-right font-medium"></th>
        </tr>
    </thead>
    <tbody class="divide-y divide-gray-100">
        ${currentDocs.map((d) => rowHtml(d, d.id === selected)).join('')}
    </tbody>
</table>`;

    // Row click -> select.
    scroll.querySelectorAll('tr[data-doc-id]').forEach((tr) => {
        tr.addEventListener('click', (ev) => {
            if (ev.target.closest('button')) return; // don't select when clicking Delete
            const id = tr.dataset.docId;
            selectionRef?.setSelected(id);
        });
    });

    // Delete button.
    scroll.querySelectorAll('button[data-delete-id]').forEach((btn) => {
        btn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const id = btn.dataset.deleteId;
            if (!confirm('Delete this report?')) return;
            await deleteDocument(id);
            if (selectionRef?.getSelected() === id) selectionRef.setSelected(null);
            await refresh();
        });
    });
}

function rowHtml(doc, isSelected) {
    const status = STATUS_LABELS[doc.status] || STATUS_LABELS.queued;
    const added = new Date(doc.createdAt).toLocaleString();
    const rowCls = isSelected
        ? 'cursor-pointer bg-green-50 hover:bg-green-50'
        : 'cursor-pointer hover:bg-gray-50';
    // Metadata-ingested docs get a two-line label: TCode + "CB_DOCID · yearmonth".
    // Manually-uploaded docs still show their filename.
    const m = doc.metadata;
    const nameCell = m
        ? `<td class="px-3 py-2 max-w-[24rem]">
                <div class="text-gray-900 font-medium">${escapeHtml(m.tcode || doc.name)}</div>
                <div class="text-xs text-gray-500">${escapeHtml(m.docid || '')}${m.yearmonthLabel ? ` · ${escapeHtml(m.yearmonthLabel)}` : ''}</div>
            </td>`
        : `<td class="px-3 py-2 text-gray-900 truncate max-w-[24rem]" title="${escapeHtml(doc.name)}">${escapeHtml(doc.name)}</td>`;
    return `
<tr data-doc-id="${doc.id}" class="${rowCls}">
    ${nameCell}
    <td class="px-3 py-2 text-gray-600">${doc.pages?.length ?? 0}</td>
    <td class="px-3 py-2">
        <span class="inline-flex items-center rounded-md px-2 py-0.5 text-xs ring-1 ring-inset ${status.cls}">${status.label}</span>
    </td>
    <td class="px-3 py-2 text-gray-500 text-xs whitespace-nowrap">${added}</td>
    <td class="px-3 py-2 text-right">
        <button type="button" data-delete-id="${doc.id}"
                class="text-xs text-red-600 hover:text-red-800 hover:underline"
                title="Delete report">Delete</button>
    </td>
</tr>`;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}
