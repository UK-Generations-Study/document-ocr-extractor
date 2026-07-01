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

const MOUNT_ID = 'work-surface';
const LOW_CONF_THRESHOLD = 0.6;

let selectionRef = null;
let currentDocId = null;
let unsubQueue = null;

export function mountOcrView({ selection }) {
    selectionRef = selection;
    // Redraw whenever the queue emits an event for the currently-visible doc.
    unsubQueue = subscribeQueue((ev) => {
        if (!currentDocId) return;
        if (ev.docId && ev.docId !== currentDocId) return;
        // Full re-render on document lifecycle events; light re-render on progress.
        if (ev.type === 'doc-done' || ev.type === 'status' || ev.type === 'doc-start') {
            renderFor(currentDocId, { force: true });
        } else if (ev.type === 'page-done' || ev.type === 'page-start' || ev.type === 'load-progress') {
            renderFor(currentDocId, { force: true });
        }
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
}

function headerHtml(doc, ocrByKey) {
    const pages = doc.pages || [];
    const donePages = pages.filter((p) => ocrByKey.has(p.blobKey)).length;

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
</button>`;
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
<div class="sticky top-0 z-10 -mx-4 px-4 py-2 bg-white/90 backdrop-blur border-b border-gray-200 flex items-center justify-between">
    <div class="text-xs text-gray-500 truncate">
        ${escapeHtml(doc.name)}
    </div>
    <div class="flex items-center gap-2">
        ${statusLine}
        ${controls}
    </div>
</div>`;
}

function pageSectionEl(doc, pageIndex, page, ocr) {
    const wrap = document.createElement('div');
    wrap.className = 'border border-gray-200 rounded shadow-sm bg-white';

    const lowConf = countLowConfLines(ocr?.uncertainty);
    const lowConfBadge = lowConf > 0
        ? `<span class="ml-2 inline-flex items-center rounded bg-yellow-50 text-yellow-800 ring-1 ring-inset ring-yellow-300 px-1.5 py-0.5 text-[10px]">${lowConf} low-conf line${lowConf === 1 ? '' : 's'}</span>`
        : '';

    const readonly = ['ocr-confirmed', 'extraction-running', 'extraction-done', 'confirmed', 'exported'].includes(doc.status);
    const initial = ocr?.markdown ?? '';
    const placeholder = ocr ? '' : 'Waiting for OCR&hellip;';

    wrap.innerHTML = `
<div class="flex items-baseline justify-between px-3 py-1.5 border-b border-gray-100 text-xs text-gray-600">
    <div>Page ${pageIndex + 1}${lowConfBadge}</div>
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
