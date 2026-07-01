/**
 * Right-pane OCR review view (Phase 4a).
 *
 * Renders one section per page of the currently-selected document. Waits
 * quietly while OCR is queued or running (a summary banner tracks the queue
 * events), then shows the extracted text as a set of per-page editable
 * textareas. A "Confirm OCR" button at the top transitions the document
 * status to 'ocr-confirmed' and disables editing.
 *
 * The confidence highlight in Phase 4a is deliberately conservative: we surface
 * a per-page "low-confidence tokens" count derived from the uncertainty layer,
 * not a character-level bg-yellow overlay. The private-eye codebase has
 * character-precise highlights; wiring them cleanly is a Phase 4b task after
 * Deep Read lands - they share the same uncertainty layer.
 */
import { getDocument, getOcrPagesByDoc, putDocument, putOcrPage } from '../db.js';
import { enqueueDocument, subscribeQueue } from '../ocr/queue.js';
import { cancelCurrentDeep, enqueueDeep, subscribeDeepQueue } from '../ocr/deepQueue.js';

const MOUNT_ID = 'work-surface';
const LOW_CONF_THRESHOLD = 0.6;

let selectionRef = null;
let currentDocId = null;
let unsubQueue = null;
let unsubDeep = null;
// Per-doc Deep Read UI progress state, keyed by docId. Not persisted - purely
// a rendering aid so the sticky bar can show weight download / phase.
const deepState = new Map();

export function mountOcrView({ selection }) {
    selectionRef = selection;
    unsubQueue = subscribeQueue((ev) => {
        if (!currentDocId) return;
        if (ev.docId && ev.docId !== currentDocId) return;
        if (ev.type === 'doc-done' || ev.type === 'status' || ev.type === 'doc-start') {
            renderFor(currentDocId, { force: true });
        } else if (ev.type === 'page-done' || ev.type === 'page-start' || ev.type === 'load-progress') {
            renderFor(currentDocId, { force: true });
        }
    });
    unsubDeep = subscribeDeepQueue((ev) => {
        // Track load-progress + phase for any doc so we can render on selection.
        if (ev.type === 'load-progress') {
            for (const st of deepState.values()) st.load = { loaded: ev.loaded, total: ev.total };
        }
        if (ev.docId) {
            const st = deepState.get(ev.docId) || {};
            if (ev.type === 'doc-start') st.running = true;
            if (ev.type === 'page-start') { st.pageIndex = ev.pageIndex; st.pageCount = ev.pageCount; }
            if (ev.type === 'phase') { st.phase = ev.phase; st.phaseIndex = ev.index; st.phaseTotal = ev.total; }
            if (ev.type === 'page-done') { /* pageIndex already tracked */ }
            if (ev.type === 'doc-done') { st.running = false; st.done = true; }
            if (ev.type === 'error' || ev.type === 'doc-error' || ev.type === 'page-error') {
                st.error = ev.error?.message || ev.error?.title || String(ev.error);
                st.running = false;
            }
            deepState.set(ev.docId, st);
        }
        if (currentDocId) renderFor(currentDocId, { force: true });
    });
    renderFor(selection.getSelected());
    selection.subscribe((id) => renderFor(id));
}

async function renderFor(docId, { force } = {}) {
    if (!force && docId === currentDocId) return;
    currentDocId = docId || null;
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;

    if (!docId) { renderEmpty(mount); return; }

    // Loosen the layout defaults from the shell so per-page cards can breathe.
    mount.classList.remove('items-center', 'justify-center');
    mount.classList.add('items-stretch');

    const doc = await getDocument(docId);
    if (!doc || currentDocId !== docId) return;

    const pages = doc.pages || [];
    const ocrPages = await getOcrPagesByDoc(docId);
    if (currentDocId !== docId) return;
    const ocrByKey = new Map(ocrPages.map((r) => [r.pageBlobKey, r]));

    mount.innerHTML = `
<div class="max-w-3xl mx-auto space-y-4">
    ${headerHtml(doc, ocrByKey)}
    <div id="ov-pages" class="space-y-4"></div>
</div>`;

    const pagesRoot = mount.querySelector('#ov-pages');
    for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const ocr = ocrByKey.get(page.blobKey);
        pagesRoot.appendChild(pageSectionEl(doc, i, page, ocr));
    }

    // Toolbar buttons.
    mount.querySelector('#ov-confirm')?.addEventListener('click', async () => {
        const d = await getDocument(docId);
        if (!d) return;
        d.status = 'ocr-confirmed';
        await putDocument(d);
        renderFor(docId, { force: true });
    });
    mount.querySelector('#ov-reopen')?.addEventListener('click', async () => {
        const d = await getDocument(docId);
        if (!d) return;
        d.status = 'ocr-done';
        await putDocument(d);
        renderFor(docId, { force: true });
    });
    mount.querySelector('#ov-retry')?.addEventListener('click', async () => {
        const d = await getDocument(docId);
        if (!d) return;
        d.status = 'queued';
        await putDocument(d);
        enqueueDocument(docId);
        renderFor(docId, { force: true });
    });
    mount.querySelector('#ov-deep')?.addEventListener('click', () => {
        // First-time click reveals a "downloading model (~1.4 GB)" warning
        // + Cancel button once weights actually start streaming.
        const st = deepState.get(docId) || {};
        st.starting = true;
        deepState.set(docId, st);
        enqueueDeep(docId);
        renderFor(docId, { force: true });
    });
    mount.querySelector('#ov-deep-cancel')?.addEventListener('click', () => {
        cancelCurrentDeep();
    });
}

function headerHtml(doc, ocrByKey) {
    const pages = doc.pages || [];
    const donePages = pages.filter((p) => ocrByKey.has(p.blobKey)).length;
    const anyDeep = Array.from(ocrByKey.values()).some((r) => r.source === 'deep');
    const deep = deepState.get(doc.id);

    let statusLine;
    let controls = '';
    switch (doc.status) {
        case 'queued':
            statusLine = `<span class="text-gray-500">Queued for OCR&hellip;</span>`;
            break;
        case 'ocr-running':
            statusLine = `<span class="text-blue-700">Reading page ${donePages + 1} of ${pages.length}&hellip;</span>`;
            break;
        case 'ocr-done':
            statusLine = `<span class="text-blue-700">OCR complete &mdash; review and edit below.</span>`;
            controls = `
<button id="ov-confirm" type="button"
    class="rounded-md bg-green-800 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-green-700">
    Confirm OCR
</button>
<button id="ov-retry" type="button"
    class="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
    Re-run OCR
</button>
${deepButtonHtml(anyDeep, deep)}`;
            break;
        case 'ocr-confirmed':
        case 'extraction-running':
        case 'extraction-done':
        case 'confirmed':
        case 'exported':
            statusLine = `<span class="text-green-700">OCR confirmed. Extraction UI arrives in Phase 5.</span>`;
            controls = `
<button id="ov-reopen" type="button"
    class="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
    Reopen for edit
</button>`;
            break;
        default:
            statusLine = escapeHtml(String(doc.status));
    }

    return `
<div class="sticky top-0 z-10 -mx-4 px-4 py-2 bg-white/90 backdrop-blur border-b border-gray-200 flex flex-col gap-1">
    <div class="flex items-center justify-between">
        <div class="text-xs text-gray-500 truncate">
            ${escapeHtml(doc.name)}
        </div>
        <div class="flex items-center gap-2">
            ${statusLine}
            ${controls}
        </div>
    </div>
    ${deepProgressBarHtml(deep)}
</div>`;
}

function deepButtonHtml(anyDeep, st) {
    if (st?.running) {
        const label = st.phase === 'cross-examining' && st.phaseIndex
            ? `Deep OCR: region ${st.phaseIndex}/${st.phaseTotal}`
            : st.phase
                ? `Deep OCR: ${st.phase}${typeof st.pageIndex === 'number' ? ` (page ${st.pageIndex + 1}/${st.pageCount})` : ''}`
                : 'Deep OCR running&hellip;';
        return `
<span class="text-xs text-purple-700">${label}</span>
<button id="ov-deep-cancel" type="button"
    class="rounded-md border border-gray-300 bg-white px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-50">
    Cancel
</button>`;
    }
    if (st?.starting && !st?.done) {
        const p = st.load;
        const pct = p && p.total > 0 ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : 0;
        return `
<span class="text-xs text-purple-700">Downloading Deep OCR model${pct ? ` &middot; ${pct}%` : '&hellip;'}</span>`;
    }
    const label = anyDeep ? 'Re-run Deep OCR' : 'Improve with Deep OCR';
    return `
<button id="ov-deep" type="button"
    class="rounded-md border border-purple-300 bg-purple-50 px-3 py-1.5 text-xs font-medium text-purple-800 hover:bg-purple-100"
    title="Run the higher-quality VLM (~1.4 GB one-time download, cached after)">
    ${label}
</button>`;
}

function deepProgressBarHtml(st) {
    if (!st) return '';
    if (st.running && typeof st.pageIndex === 'number') {
        const pct = st.pageCount ? Math.round(((st.pageIndex + 0.5) / st.pageCount) * 100) : 0;
        return `<div class="w-full h-1 bg-gray-200 rounded overflow-hidden"><div class="h-full bg-purple-600 transition-all" style="width:${pct}%"></div></div>`;
    }
    if (st.starting && !st.done && st.load) {
        const pct = st.load.total > 0 ? Math.round((st.load.loaded / st.load.total) * 100) : 0;
        return `<div class="w-full h-1 bg-gray-200 rounded overflow-hidden"><div class="h-full bg-purple-500 transition-all" style="width:${pct}%"></div></div>`;
    }
    return '';
}

function pageSectionEl(doc, pageIndex, page, ocr) {
    const wrap = document.createElement('div');
    wrap.className = 'border border-gray-200 rounded shadow-sm bg-white';

    const lowConf = countLowConfLines(ocr?.uncertainty);
    const lowConfBadge = lowConf > 0
        ? `<span class="ml-2 inline-flex items-center rounded bg-yellow-50 text-yellow-800 ring-1 ring-inset ring-yellow-300 px-1.5 py-0.5 text-[10px]">${lowConf} low-conf line${lowConf === 1 ? '' : 's'}</span>`
        : '';
    const sourceBadge = ocr?.source === 'deep'
        ? `<span class="ml-2 inline-flex items-center rounded bg-purple-50 text-purple-800 ring-1 ring-inset ring-purple-300 px-1.5 py-0.5 text-[10px]">deep</span>`
        : ocr?.source === 'edit'
            ? `<span class="ml-2 inline-flex items-center rounded bg-gray-100 text-gray-700 ring-1 ring-inset ring-gray-300 px-1.5 py-0.5 text-[10px]">edited</span>`
            : '';

    const readonly = ['ocr-confirmed', 'extraction-running', 'extraction-done', 'confirmed', 'exported'].includes(doc.status);
    const initial = ocr?.markdown ?? '';
    const placeholder = ocr ? '' : 'Waiting for OCR&hellip;';

    wrap.innerHTML = `
<div class="flex items-baseline justify-between px-3 py-1.5 border-b border-gray-100 text-xs text-gray-600">
    <div>Page ${pageIndex + 1}${sourceBadge}${lowConfBadge}</div>
    <div class="text-gray-400">${page.width} x ${page.height}</div>
</div>
<textarea
    data-page-key="${escapeAttr(page.blobKey)}"
    class="w-full p-3 text-sm font-mono resize-y focus:outline-none focus:ring-0 min-h-[8rem]"
    rows="10"
    placeholder="${placeholder}"
    ${readonly ? 'readonly' : ''}
>${escapeHtml(initial)}</textarea>`;

    const ta = wrap.querySelector('textarea');
    // Persist edits on blur so we don't hammer IDB on every keystroke.
    ta.addEventListener('blur', async () => {
        if (readonly) return;
        const nextText = ta.value;
        // Only write if the user actually changed something.
        if (nextText === initial) return;
        await putOcrPage({
            pageBlobKey: page.blobKey,
            docId: doc.id,
            markdown: nextText,
            blocks: ocr?.blocks || [],
            uncertainty: ocr?.uncertainty || null,
            width: ocr?.width ?? page.width,
            height: ocr?.height ?? page.height,
            stageMs: ocr?.stageMs || {},
            totalMs: ocr?.totalMs || 0,
            source: 'edit',
            updatedAt: Date.now(),
        });
    });

    return wrap;
}

function countLowConfLines(uncertainty) {
    if (!uncertainty || !Array.isArray(uncertainty.lines)) return 0;
    let n = 0;
    for (const line of uncertainty.lines) {
        const conf = typeof line.avgConf === 'number' ? line.avgConf : line.conf;
        if (typeof conf === 'number' && conf < LOW_CONF_THRESHOLD) n++;
    }
    return n;
}

function renderEmpty(mount) {
    mount.classList.add('flex', 'items-center', 'justify-center');
    mount.classList.remove('items-stretch');
    mount.innerHTML = `
<div class="text-center text-gray-400">
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1" class="w-10 h-10 mb-2 opacity-40 mx-auto">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
    </svg>
    <p class="text-sm">OCR text and extracted fields will appear here.</p>
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
