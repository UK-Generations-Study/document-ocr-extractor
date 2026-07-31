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
import {
    addManualRedaction,
    dismissRange,
    hasOverrides,
    isCurrentSchema,
    manualTextsInRange,
    reanchorAfterEdit,
    pageOutputText,
    redactionSummary,
    removeManualRedaction,
    resetOverrides,
    restoreRange,
    textOccursInPage,
} from '../deid/deidentify.js';
import { decorateMarks, markPageText } from '../deid/marks.js';
import { confirmOcr } from './reviewFlow.js';
import { confirmDialog, showToast } from './toast.js';
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
        // Entity selection / score threshold changed: which spans are redacted
        // is derived from settings, so a redraw is all that's needed - no
        // re-analysis, which is what makes those controls feel instant.
        if (ev.type === 'settings-changed') {
            requestRender();
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

    // Any click elsewhere dismisses the floating redaction action; the panes'
    // own mouseup re-offers it when the new caret or selection warrants one.
    // The button itself is excluded - hiding it here would remove it before
    // its click could fire.
    document.addEventListener('mousedown', (ev) => {
        if (ev.target !== spanActionButton) hideSpanAction();
    });
    // It is position-fixed, so a scroll would leave it pointing at nothing.
    document.getElementById(MOUNT_ID)?.addEventListener('scroll', hideSpanAction, { passive: true });

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

    hideRedactButton();
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

/**
 * One page card.
 *
 * `restore.mode` carries the active tab across a rebuild; without it, saving
 * an edit would silently bounce the abstractor back to the Rendered tab.
 * Scroll positions are restored by the caller AFTER insertion - see
 * refreshCard - because a detached element has no scrollable extent.
 */
function pageSectionEl(doc, pageIndex, page, ocr, restore = {}) {
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

    // Both editable views show the ORIGINAL text with a translucent veil over
    // every span that will be redacted on export, so the abstractor can read
    // what is being removed and correct it:
    //   Rendered  formatted, veiled, editable
    //   Raw       markdown source, veiled, editable
    //   Export    read-only preview of what actually leaves the app, with
    //             each veiled span replaced by [REDACTED]
    const deid = isCurrentSchema(ocr?.deid) ? ocr.deid : null;
    const originalText = ocr?.markdown ?? '';

    const summary = deid ? redactionSummary(ocr) : {};
    const redacted = Object.values(summary).reduce((a, b) => a + b, 0);
    const summaryText = Object.entries(summary).map(([t, n]) => `${n} ${t}`).join(' · ');
    const deidBadge = deid
        ? `<span class="ml-2 inline-flex items-center rounded bg-gray-900 text-gray-50 px-1.5 py-0.5 text-[10px]"
                 title="${escapeAttr(redacted ? `${summaryText} — replaced with [REDACTED] on export` : 'Nothing detected on this page')}">${redacted} redacted</span>`
        : '';
    const resetBtn = deid && hasOverrides(deid)
        ? `<button type="button" class="ov-deid-reset px-2 py-0.5 text-[11px] font-medium rounded ring-1 ring-gray-200 text-gray-600 hover:bg-gray-50"
                   title="Discard your redaction changes on this page and go back to what was detected automatically">Reset</button>`
        : '';

    const readonly = ['ocr-confirmed', 'extraction-running', 'extraction-done', 'confirmed', 'exported'].includes(doc.status);
    // Rendered view: marked-up original when redacting, plain text otherwise.
    const marked = deid ? markPageText(ocr) : { markdown: originalText, marks: [] };
    const initial = originalText;
    const placeholder = ocr ? '' : 'Waiting for OCR&hellip;';
    const renderedHtml = marked.markdown
        ? micromark(marked.markdown, { extensions: [gfm()], htmlExtensions: [gfmHtml()] })
        : '';

    // The body shares the page image's aspect ratio so this card's height
    // matches the viewer's page card exactly; longer text scrolls inside.
    wrap.innerHTML = `
<div class="h-8 flex items-center justify-between px-3 border-b border-gray-100 text-xs text-gray-600">
    <div>Page ${pageIndex + 1}${sourceBadge}${lowConfBadge}${deidBadge}</div>
    <div class="flex items-center gap-2">
        ${resetBtn}
        <div class="ov-toggle inline-flex rounded-md ring-1 ring-gray-200 overflow-hidden" role="group">
            <button type="button" data-mode="rendered" class="ov-mode px-2 py-0.5 text-[11px] font-medium"
                    title="${deid ? 'Formatted view - edit the text, and select it to redact' : 'Formatted view - editable'}">Rendered</button>
            <button type="button" data-mode="raw" class="ov-mode px-2 py-0.5 text-[11px] font-medium"
                    title="${deid ? 'Markdown source - edit the text, and select it to redact' : 'Markdown source - editable'}">Raw</button>
            ${deid ? `<button type="button" data-mode="export" class="ov-mode px-2 py-0.5 text-[11px] font-medium"
                    title="Read-only preview of the text that will be exported">Export</button>` : ''}
        </div>
    </div>
</div>
<div class="ov-body overflow-y-auto" style="aspect-ratio: ${page.width} / ${page.height};">
    <div class="ov-pane ov-rendered prose prose-sm max-w-none p-4 text-sm leading-relaxed focus:outline-none focus:bg-green-50/30"
         ${readonly ? '' : 'contenteditable="true" spellcheck="false"'}
         style="--tw-prose-headings: #111827;">${renderedHtml || `<p class="text-gray-400 italic">${placeholder || 'No OCR text yet.'}</p>`}</div>
    <!-- Markdown source. A contenteditable rather than a textarea because a
         textarea cannot contain the veil elements. plaintext-only keeps the
         browser from turning Enter into markup, so innerText round-trips the
         source exactly. -->
    <div data-page-key="${escapeAttr(page.blobKey)}"
         class="ov-pane ov-raw hidden p-3 text-sm font-mono whitespace-pre-wrap break-words focus:outline-none focus:bg-green-50/30"
         ${readonly ? '' : 'contenteditable="plaintext-only" spellcheck="false"'}></div>
    ${deid ? `<div class="ov-pane ov-export hidden p-3 text-sm font-mono whitespace-pre-wrap break-words text-gray-700"></div>` : ''}
</div>`;

    const rendered = wrap.querySelector('.ov-rendered');
    const rawEl = wrap.querySelector('.ov-raw');
    const exportEl = wrap.querySelector('.ov-export');
    const body = wrap.querySelector('.ov-body');

    // Raw pane: the same marked-up Markdown the rendered view is built from,
    // but shown as source instead of being run through micromark. decorateMarks
    // then converts the sentinels to veils exactly as it does there, so both
    // panes share one code path - and because the pane's text IS the source,
    // reading an edit back needs no Markdown round-trip.
    rawEl.textContent = marked.markdown || '';
    if (deid) decorateMarks(rawEl, marked.marks);
    if (!marked.markdown && placeholder) {
        rawEl.textContent = '';
        rawEl.dataset.placeholder = placeholder;
    }

    if (exportEl) exportEl.textContent = pageOutputText(ocr) || '(nothing to export)';

    let currentMode = restore.mode === 'raw' || restore.mode === 'export' ? restore.mode : 'rendered';
    const modeButtons = [...wrap.querySelectorAll('.ov-mode')];
    const applyMode = (mode) => {
        currentMode = mode;
        wrap.querySelectorAll('.ov-pane').forEach((p) => {
            p.classList.toggle('hidden', !p.classList.contains(`ov-${mode}`));
        });
        modeButtons.forEach((b) => {
            const on = b.dataset.mode === mode;
            b.classList.toggle('bg-gray-100', on);
            b.classList.toggle('text-gray-700', on);
            b.classList.toggle('text-gray-500', !on);
            b.classList.toggle('hover:bg-gray-50', !on);
        });
    };
    // Switch on mousedown, not click: mousedown fires BEFORE the editor loses
    // focus, so the mode is already recorded by the time the blur handler saves
    // the edit and rebuilds the card. Waiting for click loses the race - the
    // rebuild can land first and detach the button mid-gesture, swallowing it.
    // click is still wired for keyboard activation, and applyMode is idempotent.
    modeButtons.forEach((b) => {
        const pick = () => { hideSpanAction(); applyMode(b.dataset.mode); };
        b.addEventListener('mousedown', pick);
        b.addEventListener('click', pick);
    });
    applyMode(currentMode);

    const renderMd = (text) => (text
        ? micromark(text, { extensions: [gfm()], htmlExtensions: [gfmHtml()] })
        : `<p class="text-gray-400 italic">No OCR text yet.</p>`);

    // Turn the sentinels micromark passed through into veils / outlines.
    if (deid) decorateMarks(rendered, marked.marks);

    // Baseline for detecting a rendered-pane edit. Compared against the
    // turndown round-trip of what we just rendered, NOT the stored Markdown:
    // turndown never reproduces its input byte for byte (escaping, emphasis
    // markers), so comparing to the stored text would read as an edit on every
    // blur and needlessly re-anchor. Captured after decoration so the veil
    // elements are already in place.
    const renderedBaseline = turndown.turndown(rendered.innerHTML).trim();

    const baseRecord = () => ({
        pageBlobKey: page.blobKey,
        docId: doc.id,
        blocks: ocr?.blocks || [],
        uncertainty: ocr?.uncertainty || null,
        width: ocr?.width ?? page.width,
        height: ocr?.height ?? page.height,
        stageMs: ocr?.stageMs || {},
        totalMs: ocr?.totalMs || 0,
        updatedAt: Date.now(),
    });

    /** Rebuild just this card in place, so a redaction change doesn't reset
     *  the scroll position of the whole pane. The active tab and the body's
     *  scroll are carried over: a rebuild is triggered by saving an edit, and
     *  the click that caused the save is often the one switching tabs. */
    const refreshCard = () => {
        // The work pane's own scroll has to be restored too: swapping the card
        // out momentarily shortens the document, and the browser clamps
        // scrollTop while it is detached - which reads as the page jumping back
        // to the top the moment you redact something.
        const mount = document.getElementById(MOUNT_ID);
        const paneScroll = mount?.scrollTop ?? 0;
        const bodyScroll = body.scrollTop;
        const next = pageSectionEl(doc, pageIndex, page, ocr, { mode: currentMode });
        wrap.replaceWith(next);
        // Only after insertion: a detached element has no scrollable extent, so
        // assigning scrollTop while it is still out of the document silently
        // does nothing.
        const nextBody = next.querySelector('.ov-body');
        if (nextBody) nextBody.scrollTop = bodyScroll;
        if (mount) mount.scrollTop = paneScroll;
    };

    /**
     * The text currently in the editor if it differs from what was rendered,
     * else null. Needed because the floating redaction button suppresses
     * mousedown so it survives its own click - which also means the editor
     * never blurs, so an in-progress edit has NOT been saved by the time a
     * redaction is applied. Writing the redaction without flushing it first
     * would persist the stale text and silently discard the edit.
     */
    const pendingText = () => {
        if (readonly) return null;
        if (currentMode === 'raw') {
            const next = rawEl.innerText.replace(/\n$/, '');
            return next === initial ? null : next;
        }
        const next = turndown.turndown(rendered.innerHTML).trim();
        return next === renderedBaseline ? null : next;
    };

    /** Persist the page's redaction decisions, flushing any unsaved edit. */
    const saveDeid = async ({ redraw = true } = {}) => {
        const edited = pendingText();
        if (edited === null) {
            ocr.deid = deid;
            await putOcrPage({ ...baseRecord(), markdown: originalText, source: ocr?.source || 'quick', deid });
        } else {
            // Fold the edit and the redaction change into one write: re-anchor
            // the (already-updated) overrides onto the edited text.
            const { deid: next, lost } = reanchorAfterEdit(deid, edited);
            ocr.markdown = edited;
            ocr.deid = next;
            ocr.source = 'edit';
            await putOcrPage({ ...baseRecord(), markdown: edited, source: 'edit', deid: next });
            if (lost) {
                showToast(
                    `${lost} redaction${lost === 1 ? '' : 's'} could not be re-applied after your edit - that text has changed.`,
                    { tone: 'error', duration: 9000 },
                );
            }
        }
        if (redraw) refreshCard();
    };

    /**
     * Apply or lift a manual redaction across EVERY page of the document.
     * "Redact this" means the string identifies someone, which does not stop
     * being true on the next line or the next page.
     */
    const saveManualAcrossDoc = async (texts, { remove = false } = {}) => {
        await saveDeid({ redraw: false });   // flush any edit on this page first
        const pages = await getOcrPagesByDoc(doc.id);
        for (const rec of pages) {
            if (!isCurrentSchema(rec.deid)) continue;
            // The page we are on is represented by the live `ocr` object, whose
            // deid we just wrote; use it rather than the copy read back.
            const target = rec.pageBlobKey === page.blobKey ? ocr : rec;
            for (const text of texts) {
                if (remove) removeManualRedaction(target.deid, text);
                else addManualRedaction(target.deid, text);
            }
            await putOcrPage(target);
        }
        // Other pages changed too, so redraw the whole pane rather than a card.
        if (currentDocId) await renderFor(currentDocId, { force: true });
    };

    /** Save edited page text, carrying redactions across (see reanchorAfterEdit).
     *
     *  The in-memory record is updated as well as the stored one: the card is
     *  rebuilt from `ocr`, so leaving `ocr.markdown` stale here would redraw
     *  the pre-edit text over a correctly-saved edit. */
    const persistEditedText = async (nextText) => {
        if (!deid) {
            ocr.markdown = nextText;
            await putOcrPage({ ...baseRecord(), markdown: nextText, source: 'edit' });
            return;
        }
        const { deid: next, lost } = reanchorAfterEdit(deid, nextText);
        ocr.markdown = nextText;
        ocr.deid = next;
        ocr.source = 'edit';
        await putOcrPage({ ...baseRecord(), markdown: nextText, source: 'edit', deid: next });
        if (lost) {
            showToast(
                `${lost} redaction${lost === 1 ? '' : 's'} could not be re-applied after your edit - that text has changed. Check the page and redact by hand if needed.`,
                { tone: 'error', duration: 9000 },
            );
        }
        refreshCard();
    };

    // The rendered pane is editable in both modes: click in, type, delete.
    // Veils are display-only decoration, so turndown drops the wrapper elements
    // and gives back the plain text.
    //
    // The comparison baseline is the round-trip of what we just rendered, NOT
    // the stored Markdown: turndown never reproduces its input byte for byte
    // (escaping, emphasis markers), so comparing against the stored text would
    // read as an edit on every blur and needlessly re-anchor.
    // Persist on blur so we don't hammer IndexedDB on every keystroke.
    if (!readonly) {
        rendered.addEventListener('blur', async () => {
            const nextMd = turndown.turndown(rendered.innerHTML).trim();
            if (nextMd === renderedBaseline) return;
            await persistEditedText(nextMd);
        });

        // The raw pane's own text is the Markdown, so no round-trip is needed:
        // innerText (not textContent) because it reflects the line breaks the
        // browser actually rendered.
        rawEl.addEventListener('blur', async () => {
            const nextText = rawEl.innerText.replace(/\n$/, '');
            if (nextText === initial) return;
            await persistEditedText(nextText);
            if (!deid) rendered.innerHTML = renderMd(nextText);
        });
    }

    if (deid) {
        // Both redaction actions are offered as a floating button rather than
        // bound to a plain click, because a plain click has to place the text
        // cursor: select text to redact it, click inside a veil to keep it.
        // Wired on both editable panes so redacting works wherever you are.
        const spanHandlers = {
            /** Redact a selected string, everywhere in the document. */
            redactText: async (text) => {
                if (!textOccursInPage(deid, text)) {
                    // The selection ran across unit boundaries or over Markdown
                    // syntax, so it matches no analyzed text and redacting it
                    // would do nothing at all. Say so rather than no-op.
                    showToast(
                        'That selection spans more than one piece of text (or includes Markdown syntax), so it cannot be redacted as one. Select within a single line or value.',
                        { tone: 'error', duration: 9000 },
                    );
                    return;
                }
                await saveManualAcrossDoc([text]);
            },
            /** Flip an existing veil or dismissed outline. */
            toggleMark: async (mark, dismissed) => {
                if (dismissed) {
                    restoreRange(deid, mark.key, mark.start, mark.end);
                    await saveDeid();
                    return;
                }
                // A veil can be automatic, manual, or both merged together.
                // Automatic spans are dismissed for this page only; manual ones
                // are lifted document-wide, matching how they were applied.
                const manual = manualTextsInRange(deid, mark.key, mark.start, mark.end);
                dismissRange(deid, mark.key, mark.start, mark.end);
                if (manual.length) await saveManualAcrossDoc(manual, { remove: true });
                else await saveDeid();
            },
        };
        for (const pane of [rendered, rawEl]) {
            // Deferred a tick: clicking ON an existing selection does not
            // collapse it until after mouseup, so reading the selection
            // synchronously would still see the old range and leave the button
            // showing over text the caret has already left.
            pane.addEventListener('mouseup', () => {
                setTimeout(() => showSpanAction(pane, marked.marks, spanHandlers), 0);
            });
            pane.addEventListener('keyup', hideSpanAction);
        }

        wrap.querySelector('.ov-deid-reset')?.addEventListener('click', async () => {
            resetOverrides(deid);
            await saveDeid();
        });
    }

    return wrap;
}

// ---------------------------------------------------------------- manual redaction

/** Shared floating action button, created once. */
let spanActionButton = null;

function hideSpanAction() {
    if (spanActionButton) spanActionButton.style.display = 'none';
}
// Exposed under the old name for the render path.
const hideRedactButton = hideSpanAction;

function spanActionEl() {
    if (!spanActionButton) {
        spanActionButton = document.createElement('button');
        spanActionButton.type = 'button';
        spanActionButton.className =
            'fixed z-50 rounded-md bg-gray-900 px-2.5 py-1 text-[11px] font-medium text-white shadow-lg hover:bg-gray-700';
        // Keep focus in the editor: taking it would fire the pane's blur
        // handler, re-render the card, and destroy this button mid-click.
        spanActionButton.addEventListener('mousedown', (e) => e.preventDefault());
        document.body.appendChild(spanActionButton);
    }
    return spanActionButton;
}

function placeSpanAction(rect, label, onClick) {
    const btn = spanActionEl();
    btn.textContent = label;
    btn.style.display = 'block';
    btn.style.left = `${Math.max(8, rect.left)}px`;
    btn.style.top = `${Math.max(8, rect.top - 30)}px`;
    btn.onclick = onClick;
}

/**
 * Offer the redaction action that fits what the caret or selection is on:
 *
 *   any selection         ->  Redact just what is selected
 *   caret inside a veil   ->  Unredact that span
 *   caret inside an outline -> Redact that span again
 *
 * A SELECTION always wins over the span it sits in. Selecting part of an
 * existing span means narrowing it - "redact only these three digits" - so
 * treating that as a click on the whole span would redact far more than was
 * asked for.
 *
 * The selection is anchored to the analyzed unit it sits in - the enclosing
 * .ov-unit wrapper, or the single whole-page unit when there is no wrapper.
 */
function showSpanAction(pane, marks, handlers) {
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode || !pane.contains(sel.anchorNode)) { hideSpanAction(); return; }
    const text = sel.isCollapsed ? '' : sel.toString().trim();

    // A selection needs no unit: manual redactions are matched by text across
    // the whole document, so a selection that runs over a veil or across
    // Markdown syntax still produces an actionable string.
    if (text) {
        placeSpanAction(sel.getRangeAt(0).getBoundingClientRect(), 'Redact', async () => {
            hideSpanAction();
            window.getSelection()?.removeAllRanges();
            await handlers.redactText(text);
        });
        return;
    }

    const markEl = markAtCaret(sel);
    if (!markEl) { hideSpanAction(); return; }
    const mark = marks[Number(markEl.dataset.markId)];
    if (!mark) { hideSpanAction(); return; }
    const dismissed = mark.kind === 'off';
    placeSpanAction(markEl.getBoundingClientRect(), dismissed ? 'Redact' : 'Unredact', async () => {
        hideSpanAction();
        await handlers.toggleMark(mark, dismissed);
    });
}

/**
 * The veil the collapsed caret is on, including when it sits against either
 * edge of one.
 *
 * Clicking just after a span's last character leaves the caret inside that
 * span's text node, but clicking just before its first character leaves it at
 * the END of the preceding text node - outside the element. Without the
 * adjacency checks the two edges behave differently, which is invisible to the
 * user and reads as the click simply not working on the left-hand side.
 */
function markAtCaret(sel) {
    const node = sel.anchorNode;
    const direct = node.parentElement?.closest('.ov-redaction');
    if (direct) return direct;
    if (node.nodeType !== Node.TEXT_NODE) return null;
    const isMark = (n) => (n?.nodeType === Node.ELEMENT_NODE && n.classList.contains('ov-redaction') ? n : null);
    if (sel.anchorOffset === node.data.length) return isMark(node.nextSibling);
    if (sel.anchorOffset === 0) return isMark(node.previousSibling);
    return null;
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
