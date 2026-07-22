/**
 * Right-pane OCR review view.
 *
 * Renders one section per page of the currently-selected document. Waits
 * quietly while OCR is queued or running (a summary banner tracks the queue
 * events), then shows the extracted text as a set of per-page editable
 * cards (rendered markdown or raw). "Confirm text" approves the document for
 * extraction; a failed OCR run surfaces the error with a Retry button.
 *
 * Edit safety: queue events request a re-render, but while the abstractor is
 * typing in any editor inside this pane the re-render is deferred until
 * focus leaves the pane - a mid-edit DOM rebuild used to throw away their
 * in-progress correction (edits only persist on blur).
 *
 * Page cards carry data-page-index so syncScroll.js can align them with the
 * viewer's page images.
 *
 * Layout contract with reportViewer.js: sticky pane header min-h-16, page
 * card headers h-8, card bodies sized to the page's aspect ratio (scrolling
 * internally when the text is longer) - so page N here and page N in the
 * viewer line up exactly. Keep the two in sync if you change one.
 */
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import TurndownService from 'turndown';
import { getDocument, getOcrPagesByDoc, putOcrPage } from '../db.js';
import { onAppEvent } from '../core/bus.js';
import { setDocumentStatus } from '../core/status.js';
import { attentionRegions } from '../ocr/confidence.js';
import { confirmOcr } from './reviewFlow.js';
import { confirmDialog } from './toast.js';
import { paneTabsHtml, wirePaneTabs } from './paneTabs.js';
import { cancelCurrentDeep, enqueueDeep } from '../ocr/deepQueue.js';

const MOUNT_ID = 'work-surface';

const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    bulletListMarker: '-',
});

let currentDocId = null;
// Per-doc Deep Read UI progress state, keyed by docId. Not persisted - purely
// a rendering aid so the sticky bar can show weight download / phase.
const deepState = new Map();
// Only redraw automatically on queue events when the workPane router hasn't
// switched us off. app.js sets this on OCR-family statuses.
let ownsPane = false;
// A queue event arrived while the user was editing; render when focus leaves.
let pendingRender = false;

export function initOcrView() {
    onAppEvent((ev) => {
        if (!ownsPane || !currentDocId) return;
        if (ev.source === 'ocr') {
            if (ev.docId && ev.docId !== currentDocId) return;
            if (['doc-done', 'status', 'doc-start', 'page-done', 'page-start', 'load-progress'].includes(ev.type)) {
                requestRender();
            }
            return;
        }
        if (ev.source === 'deep') {
            if (ev.type === 'load-progress') {
                // Global (no docId): only relevant if the current doc is waiting on it.
                for (const st of deepState.values()) st.load = { loaded: ev.loaded, total: ev.total };
                const cur = deepState.get(currentDocId);
                if (cur?.starting || cur?.running) requestRender();
                return;
            }
            if (!ev.docId || ev.docId !== currentDocId) return;
            const st = deepState.get(ev.docId) || {};
            if (ev.type === 'doc-start') st.running = true;
            if (ev.type === 'page-start') { st.pageIndex = ev.pageIndex; st.pageCount = ev.pageCount; }
            if (ev.type === 'phase') { st.phase = ev.phase; st.phaseIndex = ev.index; st.phaseTotal = ev.total; }
            if (ev.type === 'doc-done') { st.running = false; st.done = true; }
            if (ev.type === 'error' || ev.type === 'doc-error' || ev.type === 'page-error') {
                st.error = ev.error?.message || ev.error?.title || String(ev.error);
                st.running = false;
            }
            deepState.set(ev.docId, st);
            requestRender();
        }
    });

    // Deferred renders fire once the user tabs/clicks out of the editor they
    // were in. The small delay lets the editor's own blur-persist commit to
    // IndexedDB before we re-read it.
    document.getElementById(MOUNT_ID)?.addEventListener('focusout', () => {
        if (!ownsPane || !pendingRender) return;
        setTimeout(() => {
            if (!ownsPane || !pendingRender) return;
            const mount = document.getElementById(MOUNT_ID);
            if (mount && paneHasFocusedEditor(mount)) return; // moved to another field
            pendingRender = false;
            if (currentDocId) renderFor(currentDocId, { force: true });
        }, 200);
    });
}

function paneHasFocusedEditor(mount) {
    const ae = document.activeElement;
    return !!(ae && mount.contains(ae) &&
        (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.tagName === 'SELECT' || ae.isContentEditable));
}

/** Re-render for a queue event - unless the user is mid-edit in this pane. */
function requestRender() {
    if (!currentDocId) return;
    const mount = document.getElementById(MOUNT_ID);
    if (mount && paneHasFocusedEditor(mount)) {
        pendingRender = true;
        return;
    }
    renderFor(currentDocId, { force: true });
}

/** Called by the workPane router when the OCR view should be visible. */
export function showOcrFor(docId) {
    ownsPane = true;
    pendingRender = false;
    return renderFor(docId, { force: true });
}

/** Called by the router when the extraction view takes over. */
export function releaseOcrPane() {
    ownsPane = false;
    pendingRender = false;
    currentDocId = null;
}

async function renderFor(docId, { force } = {}) {
    if (!force && docId === currentDocId) return;
    currentDocId = docId || null;
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;

    if (!docId) { renderEmpty(mount); return; }

    // Back to block layout: as a leftover flex container the max-w-3xl
    // wrapper would become a flex item and size to its content, breaking the
    // width (and thus page-height) match with the viewer pane.
    mount.classList.remove('flex', 'items-center', 'justify-center');

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

    // Toolbar buttons. Status changes go through setDocumentStatus so the
    // bus routing (queued -> OCR queue, ocr-confirmed -> extraction) fires.
    mount.querySelector('#ov-confirm')?.addEventListener('click', async () => {
        await confirmOcr(docId);
    });
    // Reopen scrubs the extraction: the report resets to its post-OCR state
    // (Fields tab greys out) and will be re-extracted after re-confirmation.
    mount.querySelector('#ov-reopen')?.addEventListener('click', async () => {
        const d = await getDocument(docId);
        const hasExtraction = !!d?.extractions?.length;
        if (hasExtraction) {
            const ok = await confirmDialog({
                title: 'Reopen text for editing',
                bodyHtml: 'This discards the extracted fields for this report (including any edits to them). After you confirm the text again, extraction runs fresh.',
                confirmLabel: 'Reopen and discard',
                danger: true,
            });
            if (!ok) return;
        }
        await setDocumentStatus(docId, 'ocr-done', { extractions: [], extractedAt: null, lastError: null });
        renderFor(docId, { force: true });
    });
    mount.querySelector('#ov-retry')?.addEventListener('click', async () => {
        await setDocumentStatus(docId, 'queued', { lastError: null });
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
    wirePaneTabs(mount, docId);
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
            statusLine = `<span class="text-gray-500">Waiting to be read&hellip;</span>`;
            break;
        case 'ocr-running':
            statusLine = `<span class="text-blue-700">Reading page ${Math.min(donePages + 1, pages.length)} of ${pages.length}&hellip;</span>`;
            break;
        case 'ocr-done':
            statusLine = `<span class="text-amber-700">Check the text below, then confirm.</span>`;
            controls = `
<button id="ov-confirm" type="button"
    title="Approve the text and queue this report for field extraction (Enter)"
    class="rounded-md bg-green-800 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-green-700">
    Confirm text
</button>
${deepButtonHtml(anyDeep, deep)}`;
            break;
        case 'ocr-failed':
            statusLine = `<span class="text-red-700" title="${escapeAttr(doc.lastError || '')}">OCR failed${doc.lastError ? `: ${escapeHtml(truncate(doc.lastError, 90))}` : ''}</span>`;
            controls = `
<button id="ov-retry" type="button"
    class="rounded-md bg-green-800 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-green-700">
    Retry OCR
</button>`;
            break;
        case 'ocr-confirmed':
        case 'extraction-running':
        case 'extraction-done':
        case 'confirmed':
        case 'exported':
            statusLine = `<span class="text-green-700">Text confirmed (read-only).</span>`;
            controls = `
<button id="ov-reopen" type="button"
    title="Discards the extracted fields and unlocks the text for editing; extraction re-runs after you re-confirm"
    class="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
    Reopen for edit
</button>`;
            break;
        default:
            statusLine = escapeHtml(String(doc.status));
    }

    // Exactly h-16 to match the viewer pane's header, so the first page in
    // both panes starts at the same offset. The controls row scrolls
    // horizontally rather than wrapping (wrapping would grow the header and
    // break the alignment). Text/Fields tabs sit top-right.
    return `
<div class="sticky top-0 z-10 -mx-4 px-4 h-16 bg-white/90 backdrop-blur border-b border-gray-200 flex items-center justify-between gap-3">
    <div class="min-w-0 flex-1 flex flex-col justify-center gap-1">
        <div class="flex items-baseline gap-2 min-w-0 text-xs">
            <span class="text-gray-500 truncate shrink-0 max-w-[40%]">${escapeHtml(doc.metadata?.tcode || doc.name)}</span>
            <span class="truncate">${statusLine}</span>
        </div>
        ${controls ? `<div class="flex items-center gap-2 flex-nowrap overflow-x-auto [&>button]:whitespace-nowrap [&>button]:shrink-0">${controls}</div>` : ''}
        ${deepProgressBarHtml(deep)}
    </div>
    <div class="shrink-0">${paneTabsHtml(doc, 'ocr')}</div>
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
    wrap.dataset.pageIndex = String(pageIndex);

    const regions = attentionRegions(ocr?.uncertainty);
    const lowConfBadge = regions.length > 0
        ? `<span class="ml-2 inline-flex items-center rounded bg-yellow-50 text-yellow-800 ring-1 ring-inset ring-yellow-300 px-1.5 py-0.5 text-[10px]"
                 title="Outlined on the page image in the report pane">${regions.length} to check</span>`
        : '';
    const sourceBadge = ocr?.source === 'deep'
        ? `<span class="ml-2 inline-flex items-center rounded bg-purple-50 text-purple-800 ring-1 ring-inset ring-purple-300 px-1.5 py-0.5 text-[10px]">deep</span>`
        : ocr?.source === 'edit'
            ? `<span class="ml-2 inline-flex items-center rounded bg-gray-100 text-gray-700 ring-1 ring-inset ring-gray-300 px-1.5 py-0.5 text-[10px]">edited</span>`
            : '';

    // When de-identification has run, the redacted copy is what we show and
    // what gets exported; the original is kept and viewable behind a toggle.
    // Editing therefore targets the redacted copy, so a correction never
    // rewrites the original text (and vice versa).
    const deid = ocr?.deid || null;
    const originalText = ocr?.markdown ?? '';
    let showOriginal = false;
    const currentText = () => (deid && !showOriginal ? (deid.markdown ?? '') : originalText);

    const deidBadge = deid
        ? `<span class="ml-2 inline-flex items-center rounded bg-gray-900 text-gray-50 px-1.5 py-0.5 text-[10px]"
                 title="Detected by Presidio and replaced in the exported text">${deid.findings.length} redacted</span>`
        : '';

    const readonly = ['ocr-confirmed', 'extraction-running', 'extraction-done', 'confirmed', 'exported'].includes(doc.status);
    const initial = currentText();
    const placeholder = ocr ? '' : 'Waiting for OCR&hellip;';
    const renderedHtml = initial ? micromark(initial, { extensions: [gfm()], htmlExtensions: [gfmHtml()] }) : '';

    // The body shares the page image's aspect ratio so this card's height
    // matches the viewer's page card exactly; longer text scrolls inside.
    wrap.innerHTML = `
<div class="h-8 flex items-center justify-between px-3 border-b border-gray-100 text-xs text-gray-600">
    <div>Page ${pageIndex + 1}${sourceBadge}${lowConfBadge}${deidBadge}</div>
    <div class="flex items-center gap-2">
        ${deid ? `<button type="button" class="ov-orig px-2 py-0.5 text-[11px] font-medium rounded ring-1 ring-gray-200 text-gray-600 hover:bg-gray-50"
            title="Reveal the un-redacted OCR text for this page (read-only)">Show original</button>` : ''}
        <div class="ov-toggle inline-flex rounded-md ring-1 ring-gray-200 overflow-hidden" role="group">
            <button type="button" data-mode="rendered" class="ov-mode ov-mode-rendered px-2 py-0.5 text-[11px] font-medium text-gray-700 bg-gray-100">Rendered</button>
            <button type="button" data-mode="raw" class="ov-mode ov-mode-raw px-2 py-0.5 text-[11px] font-medium text-gray-500 hover:bg-gray-50">Raw</button>
        </div>
    </div>
</div>
<div class="ov-body overflow-y-auto" style="aspect-ratio: ${page.width} / ${page.height};">
    <div class="ov-rendered prose prose-sm max-w-none p-4 text-sm leading-relaxed focus:outline-none focus:bg-green-50/30"
         ${readonly ? '' : 'contenteditable="true" spellcheck="false"'}
         style="--tw-prose-headings: #111827;">${renderedHtml || `<p class="text-gray-400 italic">${placeholder || 'No OCR text yet.'}</p>`}</div>
    <textarea
        data-page-key="${escapeAttr(page.blobKey)}"
        class="ov-raw w-full h-full p-3 text-sm font-mono resize-none focus:outline-none focus:ring-0 hidden"
        placeholder="${placeholder}"
        ${readonly ? 'readonly' : ''}
    >${escapeHtml(initial)}</textarea>
</div>`;

    // Wire mode toggle.
    const rendered = wrap.querySelector('.ov-rendered');
    const rawTa = wrap.querySelector('.ov-raw');
    const btnRendered = wrap.querySelector('.ov-mode-rendered');
    const btnRaw = wrap.querySelector('.ov-mode-raw');
    const applyMode = (mode) => {
        const isRaw = mode === 'raw';
        rendered.classList.toggle('hidden', isRaw);
        rawTa.classList.toggle('hidden', !isRaw);
        btnRaw.classList.toggle('bg-gray-100', isRaw);
        btnRaw.classList.toggle('text-gray-700', isRaw);
        btnRaw.classList.toggle('text-gray-500', !isRaw);
        btnRendered.classList.toggle('bg-gray-100', !isRaw);
        btnRendered.classList.toggle('text-gray-700', !isRaw);
        btnRendered.classList.toggle('text-gray-500', isRaw);
    };
    btnRendered.addEventListener('click', () => applyMode('rendered'));
    btnRaw.addEventListener('click', () => applyMode('raw'));

    const ta = rawTa;
    const renderMd = (text) => (text
        ? micromark(text, { extensions: [gfm()], htmlExtensions: [gfmHtml()] })
        : `<p class="text-gray-400 italic">No OCR text yet.</p>`);

    /**
     * Write an edit back to the right place: the redacted copy when that's
     * what's on screen, the raw OCR text otherwise. Editing is disabled while
     * the original is revealed, so this is never ambiguous.
     */
    const persist = async (nextText) => {
        const baseRecord = {
            pageBlobKey: page.blobKey,
            docId: doc.id,
            blocks: ocr?.blocks || [],
            uncertainty: ocr?.uncertainty || null,
            width: ocr?.width ?? page.width,
            height: ocr?.height ?? page.height,
            stageMs: ocr?.stageMs || {},
            totalMs: ocr?.totalMs || 0,
            updatedAt: Date.now(),
        };
        if (deid) {
            // Correcting a redaction: keep the original untouched.
            deid.markdown = nextText;
            await putOcrPage({ ...baseRecord, markdown: originalText, source: ocr?.source || 'quick', deid });
        } else {
            await putOcrPage({ ...baseRecord, markdown: nextText, source: 'edit' });
        }
    };

    const editable = () => !readonly && !showOriginal;

    // Rendered pane: on blur, convert the (possibly-edited) HTML back to
    // markdown, mirror it into the raw textarea, and persist.
    rendered.addEventListener('blur', async () => {
        if (!editable()) return;
        const nextMd = turndown.turndown(rendered.innerHTML).trim();
        if (nextMd === (rawTa.value || '').trim()) return;
        rawTa.value = nextMd;
        await persist(nextMd);
    });
    // Persist edits on blur so we don't hammer IDB on every keystroke.
    ta.addEventListener('blur', async () => {
        if (!editable()) return;
        const nextText = ta.value;
        // Only write if the user actually changed something.
        if (nextText === currentText()) return;
        await persist(nextText);
        // Keep the rendered view in sync with the edit so switching modes
        // shows current content.
        rendered.innerHTML = renderMd(nextText);
    });

    // Reveal / re-hide the un-redacted text. The original is always read-only:
    // it is the record of what the scan actually said.
    wrap.querySelector('.ov-orig')?.addEventListener('click', (ev) => {
        showOriginal = !showOriginal;
        const btn = ev.currentTarget;
        btn.textContent = showOriginal ? 'Show redacted' : 'Show original';
        btn.classList.toggle('bg-gray-900', showOriginal);
        btn.classList.toggle('text-gray-50', showOriginal);
        btn.classList.toggle('text-gray-600', !showOriginal);
        const text = currentText();
        rendered.innerHTML = renderMd(text);
        ta.value = text;
        const locked = !editable();
        ta.readOnly = locked;
        if (locked) rendered.removeAttribute('contenteditable');
        else rendered.setAttribute('contenteditable', 'true');
    });

    return wrap;
}

function renderEmpty(mount) {
    mount.classList.add('flex', 'items-center', 'justify-center');
    mount.innerHTML = `
<div class="text-center text-gray-400">
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1" class="w-10 h-10 mb-2 opacity-40 mx-auto">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
    </svg>
    <p class="text-sm">OCR text and extracted fields will appear here.</p>
</div>`;
}

function truncate(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}
function escapeAttr(s) {
    return escapeHtml(s);
}
