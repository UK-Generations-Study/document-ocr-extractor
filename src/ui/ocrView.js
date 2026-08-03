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
    countExceptions,
    countLiveMatches,
    countOccurrences,
    dismissSpans,
    dismissMatchingSpans,
    exceptNthOccurrenceInPage,
    hasOverrides,
    markComposition,
    normalizeDeid,
    occurrenceIndexInPage,
    reanchorAfterEdit,
    pageOutputText,
    redactInstance,
    redactNthOccurrenceInPage,
    redactionSummary,
    removeManualRedaction,
    resetOverrides,
    restoreSpans,
    sourceRangesFromRendered,
    textOccursInPage,
    unexceptMatching,
    unexceptSpans,
} from '../deid/deidentify.js';
import { decorateMarks, isDrawnVeil, markPageText } from '../deid/marks.js';
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

    // Any click elsewhere dismisses the floating redaction actions; the panes'
    // own mouseup re-offers them when the new caret or selection warrants it.
    // The bar itself is excluded - hiding it here would remove it before its
    // click could fire.
    document.addEventListener('mousedown', (ev) => {
        if (!spanActionBar?.contains(ev.target)) hideSpanAction();
    });
    // It is position-fixed, so a scroll would leave it pointing at nothing.
    document.getElementById(MOUNT_ID)?.addEventListener('scroll', hideSpanAction, { passive: true });

    // Hovering any part of a redaction lifts the whole of it. Delegated from
    // the mount so it survives the card rebuilds that follow every change.
    document.getElementById(MOUNT_ID)?.addEventListener('mouseover', (ev) => {
        const el = ev.target instanceof Element ? ev.target.closest('.ov-redaction') : null;
        highlightWholeMark(el);
    });
    document.getElementById(MOUNT_ID)?.addEventListener('mouseleave', () => highlightWholeMark(null));

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

/** Elements currently lit up together, so they can be put back. */
let hoveredVeil = [];

/**
 * Light up every element of the redaction under the pointer.
 *
 * A redaction covering several blocks is several elements, and a click acts on
 * all of them - so hovering has to show all of them, or the pane would suggest
 * each line was a redaction of its own. Scoped to the card the pointer is in:
 * mark ids number the redactions within a page, so the same id on another page
 * means something else entirely.
 */
function highlightWholeMark(el) {
    for (const node of hoveredVeil) node.classList.remove('ov-redaction--hover');
    hoveredVeil = [];
    const card = el?.closest('[data-page-index]');
    if (!el || !card) return;
    hoveredVeil = [...card.querySelectorAll(`.ov-redaction[data-mark-id="${el.dataset.markId}"]`)];
    for (const node of hoveredVeil) node.classList.add('ov-redaction--hover');
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
    // Redrawing the SAME report keeps the reader where they were. Rebuilding
    // the pane resets its scroll, which is right when a different report is
    // being shown and wrong every other time - redacting something on page
    // four should not throw you back to page one, and neither should an OCR
    // progress event landing while you read.
    const sameDoc = !!docId && docId === currentDocId;
    const keepScroll = sameDoc ? (document.getElementById(MOUNT_ID)?.scrollTop ?? 0) : 0;
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
    const reportCounts = reportWideCounts(ocrPages);
    const pagesRoot = mount.querySelector('#ov-pages');
    for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const ocr = ocrByKey.get(page.blobKey);
        pagesRoot.appendChild(pageSectionEl(doc, i, page, ocr, {}, reportCounts));
    }
    // Only now: until every card is in the document the pane has nothing like
    // its full height, and the browser silently clamps scrollTop to what fits.
    if (keepScroll) mount.scrollTop = keepScroll;

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
    mount.querySelector('#ov-reset')?.addEventListener('click', async () => {
        const ok = await confirmDialog({
            title: 'Reset this report',
            bodyHtml: 'Discards your text edits <em>and</em> your redaction changes on every page, back to what was read and detected automatically. The report itself is kept.',
            confirmLabel: 'Reset',
            danger: true,
        });
        if (!ok) return;
        for (const rec of await getOcrPagesByDoc(docId)) {
            await putOcrPage(resetPageRecord(rec));
        }
        await renderFor(docId, { force: true });
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
${deepButtonHtml(anyDeep, deep)}
${resetButtonHtml(ocrByKey)}`;
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

/**
 * Undo everything the abstractor has done to this report - text edits and
 * redaction decisions alike.
 *
 * One button for both, because from the reader's side they are one thing: the
 * changes they made to this report. Offered only when there is something to
 * undo, so it cannot be mistaken for an action that does something else.
 */
function resetButtonHtml(ocrByKey) {
    return `
<button id="ov-reset" type="button"
    title="Discard your edits and redaction changes across this report, back to what was read and detected automatically"
    class="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 ${anythingToReset(Array.from(ocrByKey.values())) ? '' : 'hidden'}">
    Reset
</button>`;
}

/** The snapshot outlives a reset, so that a second one still works - which
 *  means its mere presence says nothing. What counts is whether the page still
 *  differs from it. */
const anythingToReset = (ocrPages) => ocrPages.some((rec) =>
    (rec.original && rec.original.markdown !== rec.markdown) || hasOverrides(rec.deid));

/**
 * Show Reset exactly when there is something to reset.
 *
 * Redacting and editing go through a card refresh, which deliberately leaves
 * the header alone - so the header would otherwise still be describing the
 * report as untouched long after the first change to it.
 */
function syncResetButton(ocrPages) {
    document.getElementById('ov-reset')?.classList.toggle('hidden', !anythingToReset(ocrPages));
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
    // Nothing is offered once it has been run: the same model over the same
    // page images produces the same reading, so a second pass would spend
    // minutes to arrive back where it started - and would discard the
    // redaction decisions made since, for nothing. The per-page "deep" badge
    // is what says it has been done.
    if (anyDeep) return '';
    return `
<button id="ov-deep" type="button"
    class="rounded-md border border-purple-300 bg-purple-50 px-3 py-1.5 text-xs font-medium text-purple-800 hover:bg-purple-100"
    title="Run the higher-quality VLM (~1.4 GB one-time download, cached after)">
    Improve with Deep OCR
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
 * How many times each report-wide manual redaction's text actually occurs.
 *
 * Only the reader's question is worth answering here - "does this veil reach
 * anywhere I cannot see?" - and that is a property of the whole report, not of
 * one page, so it is counted once per render and handed down. A redaction
 * stored as report-wide whose string appears exactly once is indistinguishable
 * in effect from a one-off, and is presented as one.
 */
function reportWideCounts(ocrPages) {
    const texts = new Set();
    for (const rec of ocrPages) {
        for (const o of normalizeDeid(rec.deid)?.overrides?.on || []) {
            if (o.text) texts.add(o.text);
        }
    }
    const counts = new Map();
    for (const text of texts) {
        counts.set(text, ocrPages.reduce((n, rec) => n + countOccurrences(rec.deid, text), 0));
    }
    return counts;
}

/**
 * Rebuild every page card in place, after a change that reached other pages.
 *
 * The alternative - re-rendering the pane - throws away three things the
 * reader owns and the change did not touch: which tab each card is on, how far
 * each card's text is scrolled, and where the pane itself sits. Replacing the
 * cards one by one keeps all three, and avoids emptying the scroll container
 * at all, so there is no moment when the browser can clamp the scroll position
 * to a height that is briefly zero.
 */
async function refreshAllCards(doc) {
    const mount = document.getElementById(MOUNT_ID);
    const pagesRoot = mount?.querySelector('#ov-pages');
    if (!pagesRoot) return;

    const paneScroll = mount.scrollTop;
    const ocrPages = await getOcrPagesByDoc(doc.id);
    if (currentDocId !== doc.id) return;
    const ocrByKey = new Map(ocrPages.map((r) => [r.pageBlobKey, r]));
    const counts = reportWideCounts(ocrPages);
    syncResetButton(ocrPages);

    const pages = doc.pages || [];
    const cards = [...pagesRoot.children];
    for (let i = 0; i < pages.length && i < cards.length; i++) {
        const card = cards[i];
        const bodyScroll = card.querySelector('.ov-body')?.scrollTop ?? 0;
        const next = pageSectionEl(
            doc, i, pages[i], ocrByKey.get(pages[i].blobKey),
            { mode: card.dataset.mode }, counts,
        );
        card.replaceWith(next);
        // After insertion only: a detached card has no scrollable extent, so
        // assigning to it silently does nothing.
        const nextBody = next.querySelector('.ov-body');
        if (nextBody) nextBody.scrollTop = bodyScroll;
    }
    mount.scrollTop = paneScroll;
}

/** Whether two count maps would mark veils differently. Only the crossing of
 *  "more than one place" matters, so going from 3 occurrences to 4 is not a
 *  change worth redrawing the pane for. */
function markingDiffers(before, after) {
    for (const key of new Set([...before.keys(), ...after.keys()])) {
        if (((before.get(key) ?? 0) > 1) !== ((after.get(key) ?? 0) > 1)) return true;
    }
    return false;
}

/**
 * One page card.
 *
 * `restore.mode` carries the active tab across a rebuild; without it, saving
 * an edit would silently bounce the abstractor back to the Rendered tab.
 * Scroll positions are restored by the caller AFTER insertion - see
 * refreshCard - because a detached element has no scrollable extent.
 */
function pageSectionEl(doc, pageIndex, page, ocr, restore = {}, reportCounts = new Map()) {
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
    // Upgrade an older record once, here, and keep the upgraded object on the
    // in-memory page: every save below writes `ocr`, so the new shape is
    // persisted the first time the abstractor touches the page rather than
    // being re-derived on every render.
    // Reassigned whenever an edit is flushed: carrying redactions across an
    // edit produces a NEW record, and a handler still holding the old one would
    // act on a version of the page that no longer exists.
    let deid = normalizeDeid(ocr?.deid);
    if (ocr && deid) ocr.deid = deid;
    const originalText = ocr?.markdown ?? '';

    const summary = deid ? redactionSummary(ocr) : {};
    const redacted = Object.values(summary).reduce((a, b) => a + b, 0);
    const summaryText = Object.entries(summary).map(([t, n]) => `${n} ${t}`).join(' · ');
    const deidBadge = deid
        ? `<span class="ml-2 inline-flex items-center rounded bg-gray-900 text-gray-50 px-1.5 py-0.5 text-[10px]"
                 title="${escapeAttr(redacted ? `${summaryText} — replaced with [REDACTED] on export` : 'Nothing detected on this page')}">${redacted} redacted</span>`
        : '';

    const readonly = ['ocr-confirmed', 'extraction-running', 'extraction-done', 'confirmed', 'exported'].includes(doc.status);
    // Rendered view: marked-up original when redacting, plain text otherwise.
    const marked = deid ? markPageText(ocr, reportCounts) : { markdown: originalText, marks: [] };
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
        // Published on the element so a rebuild driven from outside this
        // closure - refreshAllCards - can put the card back on the same tab.
        wrap.dataset.mode = mode;
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
        original: ocr?.original,
    });

    /**
     * Remember what OCR produced, once, before the first edit overwrites it.
     *
     * An edit replaces `markdown` outright and collapses the per-field units it
     * was analyzed as, so without this the machine's own reading of the page is
     * gone for good and Reset would have nothing to go back to. Taken here
     * rather than in the OCR pipeline so no page written before today is left
     * without one - and only once, so a second edit cannot overwrite the
     * snapshot with already-edited text.
     */
    const rememberOriginal = () => {
        if (ocr.original) return;
        ocr.original = {
            markdown: originalText,
            deid: deid ? structuredClone(deid) : null,
            source: ocr.source || 'quick',
        };
    };

    /** Rebuild just this card in place, so a redaction change doesn't reset
     *  the scroll position of the whole pane. The active tab and the body's
     *  scroll are carried over: a rebuild is triggered by saving an edit, and
     *  the click that caused the save is often the one switching tabs. */
    const refreshCard = async () => {
        // The work pane's own scroll has to be restored too: swapping the card
        // out momentarily shortens the document, and the browser clamps
        // scrollTop while it is detached - which reads as the page jumping back
        // to the top the moment you redact something.
        const mount = document.getElementById(MOUNT_ID);
        const paneScroll = mount?.scrollTop ?? 0;
        const bodyScroll = body.scrollTop;
        // Recounted rather than carried over. A card-local save cannot add a
        // report-wide redaction, but editing this page's TEXT changes how many
        // times an existing one occurs - which is exactly what decides whether
        // its veils are marked as reaching across the report.
        const ocrPages = await getOcrPagesByDoc(doc.id);
        const counts = reportWideCounts(ocrPages);
        if (!wrap.isConnected) return;   // a full re-render got there first
        syncResetButton(ocrPages);
        // Whether a string reaches beyond one place is a fact about the report,
        // so when the answer changes it changes on every page at once. Rebuild
        // them all rather than leave the same string marked here and unmarked
        // overleaf - which would say the two behave differently, and they do
        // not. Rare enough to be worth the full redraw; the scroll is kept.
        // Whether a string reaches beyond one place is a fact about the report,
        // so when the answer changes it changes on every page at once - rebuild
        // them all rather than leave the same string marked here and unmarked
        // overleaf, which would say the two behave differently when they do not.
        if (markingDiffers(reportCounts, counts)) {
            await refreshAllCards(doc);
            return;
        }
        const next = pageSectionEl(doc, pageIndex, page, ocr, { mode: currentMode }, counts);
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
            // Fold the edit and the redaction change into one write: carry the
            // (already-updated) redactions across onto the edited text.
            rememberOriginal();
            const next = reanchorAfterEdit(ocr, deid, edited);
            ocr.markdown = edited;
            ocr.deid = next;
            deid = next;
            ocr.source = 'edit';
            await putOcrPage({ ...baseRecord(), markdown: edited, source: 'edit', deid: next });
        }
        if (redraw) await refreshCard();
    };

    /**
     * Apply a redaction decision to EVERY page of the document - the reach of
     * the "everywhere" half of each action. Anything anchored by text belongs
     * here: the string identifies someone, which does not stop being true on
     * the next line or the next page.
     */
    const applyAcrossDoc = async (mutate) => {
        await saveDeid({ redraw: false });   // flush any edit on this page first
        const pages = await getOcrPagesByDoc(doc.id);
        for (const rec of pages) {
            // The page we are on is represented by the live `ocr` object, whose
            // deid we just wrote; use it rather than the copy read back. It is
            // also the only one an action may place a span on, so `mutate` is
            // told which page it has in hand.
            const here = rec.pageBlobKey === page.blobKey;
            const target = here ? ocr : rec;
            const normalized = normalizeDeid(target.deid);
            if (!normalized) continue;
            target.deid = normalized;
            mutate(normalized, here);
            await putOcrPage(target);
        }
        // Other pages changed too, so every card is rebuilt - in place, so the
        // reader keeps their tab, their scroll, and their place in the report.
        await refreshAllCards(doc);
    };

    /** What an action's reach would actually be: how many times the string
     *  occurs across the report, and how many of those are currently held out
     *  of a report-wide redaction. Counted from the stored pages, so an unsaved
     *  edit in this card is not reflected - close enough for a label offering a
     *  choice, and every action re-reads before it writes. */
    const countAcrossDoc = async (text) => {
        const pages = await getOcrPagesByDoc(doc.id);
        return {
            total: pages.reduce((n, rec) => n + countOccurrences(rec.deid, text), 0),
            exceptions: pages.reduce((n, rec) => n + countExceptions(rec.deid, text), 0),
        };
    };

    /** Save edited page text, carrying redactions across (see reanchorAfterEdit).
     *
     *  The in-memory record is updated as well as the stored one: the card is
     *  rebuilt from `ocr`, so leaving `ocr.markdown` stale here would redraw
     *  the pre-edit text over a correctly-saved edit. */
    const persistEditedText = async (nextText) => {
        if (!deid) {
            rememberOriginal();
            ocr.markdown = nextText;
            await putOcrPage({ ...baseRecord(), markdown: nextText, source: 'edit' });
            // This branch does not rebuild the card, so the header would not
            // otherwise notice the report now has something to reset.
            syncResetButton(await getOcrPagesByDoc(doc.id));
            return;
        }
        rememberOriginal();
        const next = reanchorAfterEdit(ocr, deid, nextText);
        ocr.markdown = nextText;
        ocr.deid = next;
        deid = next;
        ocr.source = 'edit';
        await putOcrPage({ ...baseRecord(), markdown: nextText, source: 'edit', deid: next });
        await refreshCard();
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

        /**
         * Turn text typed against the edge of a veil back into ordinary text.
     *
         * The caret at a veil's trailing edge is INSIDE its element, so that is
         * where the browser puts what you type next - and the new words come
         * out blacked out, as though the redaction had swallowed them. It has
         * not: the stored span still covers exactly what it did before. But in
         * a tool whose whole job is showing what will be removed, text that is
         * not redacted must never look as though it is.
         *
         * Only the added characters move; the veil itself stays put over the
         * words it belongs to. That keeps the pane showing what the SAVE will
         * conclude, because the two rules agree: text appended at either edge
         * falls outside the span once offsets are mapped through the edit,
         * while a change made INSIDE the redacted words is absorbed into it
         * (see mapSpan). So an edit in the middle is left alone, veil and all.
         */
        const detachTypedText = (root) => {
            for (const el of root.querySelectorAll('.ov-redaction')) {
                // A redaction is an element this pane drew. Anything else
                // wearing the class was copied here by the browser - pasted
                // from the clipboard, or left behind when a block was split
                // around the caret - and covers nothing at all, whatever its
                // attributes say. Losing the decoration is the whole point:
                // text that is not redacted must not look as though it is.
                if (!isDrawnVeil(el)) { discardVeilCopy(el); continue; }

                // Compared against what THIS element was drawn over, not the
                // redaction as a whole: one spanning several blocks is several
                // elements, each holding its own piece.
                const was = el.dataset.veilText;
                if (was === undefined) continue;
                el.normalize();
                const node = el.firstChild;
                if (node?.data === was && el.childNodes.length === 1) continue;

                // Anything but plain text inside means the edit restructured
                // the element rather than added to it. Rather than reason about
                // it, give up the decoration: the save re-derives the veil, and
                // until then nothing claims to be redacted that is not.
                if (!el.textContent
                    || el.childNodes.length !== 1
                    || node.nodeType !== Node.TEXT_NODE) {
                    discardVeilCopy(el);
                    continue;
                }

                // Moving the caret is only right if it is the thing that put
                // the text there; a redraw elsewhere must not steal it.
                const typing = el.contains(window.getSelection()?.anchorNode);
                if (node.data.startsWith(was)) {
                    const tail = document.createTextNode(node.data.slice(was.length));
                    node.data = was;
                    el.after(tail);
                    if (typing) placeCaret(tail, tail.length);
                } else if (node.data.endsWith(was)) {
                    const head = document.createTextNode(node.data.slice(0, node.data.length - was.length));
                    node.data = was;
                    el.before(head);
                    if (typing) placeCaret(head, head.length);
                }
                // Otherwise the redacted words themselves are being edited. The
                // span grows to cover the change on save (see mapSpan), so the
                // veil is left where it is and already shows that.
            }
        };

        // Typing counts as having something to reset from the moment it is
        // typed, not from the blur that eventually saves it - the abstractor
        // has changed the report either way, and a Reset that only appears once
        // they happen to click elsewhere reads as arbitrary. Only ever revealed
        // here; hiding it again is for syncResetButton, which knows whether
        // anything was actually kept.
        for (const pane of [rendered, rawEl]) {
            pane.addEventListener('input', () => {
                detachTypedText(pane);
                document.getElementById('ov-reset')?.classList.remove('hidden');
            });

            // Paste arrives as plain text. What is stored for a page is
            // Markdown, so formatting that comes in with a copy has nowhere to
            // be kept and vanishes at the next redraw - harmless for a colour,
            // except that copying a redaction copies the black veil over it.
            // Pasted text would land looking as though it were being removed
            // when nothing of the sort is stored, which is the one thing this
            // pane must never show. Dropping the formatting keeps what is on
            // screen equal to what will be exported.
            pane.addEventListener('paste', (ev) => {
                const text = ev.clipboardData?.getData('text/plain');
                if (typeof text !== 'string') return;
                ev.preventDefault();
                document.execCommand('insertText', false, text);
            });
        }
    }

    if (deid) {
        // Redaction actions are offered as a floating bar rather than bound to
        // a plain click, because a plain click has to place the text cursor:
        // select text to redact it, click inside a veil to change it. Wired on
        // both editable panes so redacting works wherever you are.
        //
        // Every action comes in a "here" / "everywhere in this report" pair,
        // and the second is only offered when the string actually occurs more
        // than once - there is no choice to make otherwise, and an extra button
        // would only imply there was one.
        const spanHandlers = {
            countAcrossDoc,

            /** Redact a selected string everywhere in the report. */
            redactEverywhere: async (text) => {
                // The selection can be in text the abstractor has only just
                // typed. Nothing has saved it - the panes persist on blur, and
                // this bar suppresses blur so its own click survives - so the
                // check below would be asking whether the string appears in a
                // version of the page written before it was typed.
                await saveDeid({ redraw: false });
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
                await applyAcrossDoc((d) => addManualRedaction(d, text));
            },

            /**
             * Redact a selection that matches no single piece of stored text -
             * one running across blocks, or over Markdown syntax the rendered
             * view has dropped.
             *
             * Anchored by position rather than by string. A stretch of several
             * paragraphs is a one-off by nature: the same run of blocks will not
             * turn up again elsewhere, and redacting it by text would mean
             * matching a long multi-line string that can only ever hit once.
             * Splitting it into one redaction per line would be worse still -
             * a line like "No atypia." would then be redacted report-wide.
             */
            redactRegion: async (region) => {
                await saveDeid({ redraw: false });   // it may include unsaved text
                const ranges = region
                    ? sourceRangesFromRendered(ocr, deid, region.text, region.start, region.end)
                    : [];
                if (!ranges.length) {
                    showToast(
                        'That selection could not be matched to the text of this page, so it was not redacted.',
                        { tone: 'error', duration: 9000 },
                    );
                    return;
                }
                for (const at of ranges) redactInstance(deid, at.key, at.start, at.end);
                await saveDeid();
            },

            /** Redact only the occurrence that was selected. */
            redactOnce: async (text, index) => {
                await saveDeid({ redraw: false });   // as above: it may be unsaved text
                if (!redactNthOccurrenceInPage(deid, index, text)) {
                    showToast(
                        'That selection could not be pinned to one place. Nothing was redacted - select the text again, or redact it everywhere.',
                        { tone: 'error', duration: 9000 },
                    );
                    return;
                }
                await saveDeid();
            },

            /**
             * Stop redacting everything under one veil. A veil can be several
             * redactions merged together, each with its own reach, so each part
             * is lifted the way it was applied - the alternative is a click
             * that appears to work and leaves half the veil behind.
             */
            liftMark: async (mark) => {
                const parts = markComposition(deid, mark.key, mark.start, mark.end);
                dismissSpans(deid, [...parts.autoIds, ...parts.instanceIds]);
                if (!parts.docTexts.length) { await saveDeid(); return; }
                await applyAcrossDoc((d) => {
                    for (const text of parts.docTexts) removeManualRedaction(d, text);
                });
            },

            /**
             * Keep this one occurrence, leaving the report-wide redaction in
             * force everywhere else. Page-local: an exception is a fact about
             * one place, so no other page needs rewriting.
             *
             * Pinned to an occurrence index before anything is written, because
             * the write itself can re-flow the page when there is an unsaved
             * edit to flush.
             */
            exceptHere: async (mark) => {
                const index = occurrenceIndexInPage(deid, mark.key, mark.start, mark.end, mark.text);
                if (index < 0 || !exceptNthOccurrenceInPage(deid, index, mark.text)) {
                    showToast(
                        'Could not pin that to a single place, so it is still redacted everywhere.',
                        { tone: 'error', duration: 9000 },
                    );
                    return;
                }
                // The same veil can be an automatic detection as well; leaving
                // that half in force would make the click appear to do nothing.
                const parts = markComposition(deid, mark.key, mark.start, mark.end);
                dismissSpans(deid, [...parts.autoIds, ...parts.instanceIds]);
                await saveDeid({ redraw: false });

                // Excepting the last occurrence it still covered leaves a
                // redaction that redacts nothing. Rather than keep it - marking
                // every occurrence as report-wide while redacting none of them,
                // and silently catching that string again if it were typed
                // later - it is taken away, along with the exceptions that only
                // existed to hold it off.
                const pages = await getOcrPagesByDoc(doc.id);
                const live = pages.reduce((n, rec) => n + countLiveMatches(rec.deid, mark.text), 0);
                if (live > 0) { await refreshCard(); return; }
                await applyAcrossDoc((d) => removeManualRedaction(d, mark.text));
            },

            /** Put an excepted occurrence back under the report-wide redaction. */
            unexceptMark: async (mark) => {
                unexceptSpans(deid, mark.ids);
                await saveDeid();
            },

            /** Put every occurrence being held out back under it. */
            unexceptEverywhere: async (mark) => {
                await applyAcrossDoc((d) => unexceptMatching(d, mark.text));
            },

            /** Stop redacting this string anywhere in the report. */
            liftEverywhere: async (mark) => {
                const parts = markComposition(deid, mark.key, mark.start, mark.end);
                await applyAcrossDoc((d) => {
                    for (const text of parts.docTexts) removeManualRedaction(d, text);
                    // Detections have to be dismissed one by one; a manual
                    // redaction just goes away with its entry.
                    if (parts.autoIds.length) dismissMatchingSpans(d, mark.text);
                });
            },

            /** Put a dismissed span back into effect - this one, and only this
             *  one, however many were lifted together to get here. */
            restoreMark: async (mark) => {
                restoreSpans(deid, mark.ids);
                await saveDeid();
            },

            /** Widen a one-off redaction to the whole report. */
            widenToDoc: async (mark) => {
                await applyAcrossDoc((d, here) => {
                    if (here) dismissSpans(d, mark.ids);
                    addManualRedaction(d, mark.text);
                });
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
    }

    return wrap;
}

/**
 * Put one page back to what the machine produced: the text OCR read, and the
 * redactions Presidio proposed, with every human change on top of both
 * discarded. `original` is only present once a page has been edited - before
 * that the stored text IS the original.
 *
 * The snapshot is cloned rather than handed over, so resetting twice works and
 * the second reset does not find its source already stripped.
 */
function resetPageRecord(rec) {
    const next = { ...rec };
    const snap = rec.original;
    if (snap) {
        next.markdown = snap.markdown;
        next.deid = snap.deid ? structuredClone(snap.deid) : null;
        next.source = snap.source || 'quick';
    } else if (next.deid) {
        next.deid = structuredClone(next.deid);
    }
    // The snapshot can carry redaction decisions of its own - it is taken at
    // the first edit, which may come after a redaction - so clear them here
    // rather than trusting it to be pristine.
    if (next.deid) resetOverrides(next.deid);
    next.updatedAt = Date.now();
    return next;
}

// ---------------------------------------------------------------- manual redaction

/**
 * Strip the decoration from something wearing a veil's markup that is not one,
 * leaving its text exactly where it is.
 *
 * A block split around the caret leaves its line BREAK inside the copy, so the
 * copy is unwrapped rather than deleted - taking the break away with it left a
 * block with nothing in it at all, which has nowhere to put the caret and
 * collapses to no height, making Enter look as though it did nothing. If a
 * block still ends up empty, it is given a break of its own.
 */
function discardVeilCopy(el) {
    const sel = window.getSelection();
    const hadCaret = !!sel?.anchorNode && el.contains(sel.anchorNode);
    const block = el.parentElement;
    unwrap(el);
    if (hadCaret && block && !block.textContent && !block.querySelector('br')) {
        block.appendChild(document.createElement('br'));
        placeCaret(block, 0);
    }
}

/**
 * Replace an element with its own children, keeping the caret where it was.
 *
 * replaceWith detaches the element BEFORE inserting them, and removing the node
 * a caret sits in collapses the selection to the parent at that index - which
 * reads as the cursor jumping backwards past the words just typed. The child
 * nodes are moved rather than copied, so the one the caret is in survives and
 * can simply be pointed at again.
 */
function unwrap(el) {
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    const offset = sel?.anchorOffset ?? 0;
    const held = node && el.contains(node) ? node : null;
    el.replaceWith(...el.childNodes);
    if (held?.isConnected && held.nodeType === Node.TEXT_NODE) {
        placeCaret(held, Math.min(offset, held.data.length));
    }
}

/** Drop the caret at a point in a node, discarding any selection. The node may
 *  be text (offset in characters) or an element (offset in child nodes). */
function placeCaret(node, offset) {
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
}

/** Shared floating action bar, created once. Holds one or two buttons: the
 *  action itself, and where the choice is real, the same action at the other
 *  reach. */
let spanActionBar = null;

function hideSpanAction() {
    actionToken++;   // any in-flight offer is now stale
    if (spanActionBar) spanActionBar.style.display = 'none';
}
// Exposed under the old name for the render path.
const hideRedactButton = hideSpanAction;

/** Bumped whenever the offer changes. An action's reach has to be counted
 *  across the document before it can be labelled, and the caret can move while
 *  that read is in flight - so a bar is only shown if its token is still the
 *  current one. */
let actionToken = 0;

function spanActionBarEl() {
    if (!spanActionBar) {
        spanActionBar = document.createElement('div');
        spanActionBar.className = 'fixed z-50 flex items-stretch rounded-md shadow-lg overflow-hidden text-[11px] font-medium';
        // Keep focus in the editor: taking it would fire the pane's blur
        // handler, re-render the card, and destroy this bar mid-click.
        spanActionBar.addEventListener('mousedown', (e) => e.preventDefault());
        document.body.appendChild(spanActionBar);
    }
    return spanActionBar;
}

/** @param {Array<{label: string, title?: string, run: Function}>} actions */
function placeSpanActions(rect, actions) {
    const bar = spanActionBarEl();
    bar.textContent = '';
    actions.forEach((action, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        // The first action is the plain one - what the click would have done
        // before there was a choice - so it keeps the solid weight and the
        // alternative reads as the alternative.
        btn.className = i === 0
            ? 'bg-gray-900 px-2.5 py-1 text-white hover:bg-gray-700'
            : 'bg-gray-700 px-2.5 py-1 text-gray-100 border-l border-gray-600 hover:bg-gray-600';
        btn.textContent = action.label;
        if (action.title) btn.title = action.title;
        btn.onclick = async () => {
            hideSpanAction();
            window.getSelection()?.removeAllRanges();
            await action.run();
        };
        bar.appendChild(btn);
    });
    bar.style.display = 'flex';
    bar.style.left = `${Math.max(8, rect.left)}px`;
    bar.style.top = `${Math.max(8, rect.top - 30)}px`;
}

/**
 * Offer the redaction actions that fit what the caret or selection is on.
 *
 *   selection                  Redact  |  Only this one
 *   caret in an auto veil      Unredact  |  Unredact all N
 *   caret in a report-wide veil Unredact  |  Only here
 *   caret in a one-off veil    Unredact  |  Redact all N
 *   caret in a dismissed span  Redact  |  Redact all N
 *
 * The second button appears only when the string occurs more than once in the
 * report, so the two reaches actually differ. When they don't, one button says
 * everything there is to say.
 *
 * A SELECTION always wins over the span it sits in. Selecting part of an
 * existing span means narrowing it - "redact only these three digits" - so
 * treating that as a click on the whole span would redact far more than was
 * asked for.
 */
async function showSpanAction(pane, marks, handlers) {
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode || !pane.contains(sel.anchorNode)) { hideSpanAction(); return; }
    const text = sel.isCollapsed ? '' : sel.toString().trim();
    const token = ++actionToken;

    if (text) {
        // A selection needs no unit: a report-wide redaction is matched by text,
        // so a selection that runs over a veil or across Markdown syntax still
        // produces an actionable string. Only the "just this one" half needs to
        // know which occurrence it is.
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        const index = selectionOccurrenceIndex(pane, sel, text);
        const region = selectionRegion(pane, sel);
        const { total } = await handlers.countAcrossDoc(text);
        if (token !== actionToken) return;

        // Nowhere in the report does this string appear as stored text - it
        // runs across blocks, or over Markdown syntax the rendered view has
        // dropped. It is still a real stretch of the page, so it is redacted by
        // position instead, and the reach question does not arise.
        if (total === 0) {
            placeSpanActions(rect, [{
                label: 'Redact',
                title: 'Redact the selected text',
                run: () => handlers.redactRegion(region),
            }]);
            return;
        }

        const actions = [{
            label: total > 1 ? `Redact all ${total}` : 'Redact',
            title: total > 1
                ? `Redact every "${text}" in this report`
                : 'Redact this text wherever it appears in this report',
            run: () => handlers.redactEverywhere(text),
        }];
        if (total > 1 && index >= 0) {
            actions.push({
                label: 'Only this one',
                title: 'Redact just this occurrence and leave the others alone',
                run: () => handlers.redactOnce(text, index),
            });
        }
        placeSpanActions(rect, actions);
        return;
    }

    const markEl = markAtCaret(sel);
    if (!markEl) { hideSpanAction(); return; }
    const mark = marks[Number(markEl.dataset.markId)];
    if (!mark) { hideSpanAction(); return; }

    const rect = markEl.getBoundingClientRect();
    const counts = await handlers.countAcrossDoc(mark.text);
    if (token !== actionToken) return;
    placeSpanActions(rect, veilActions(mark, counts, handlers));
}

/**
 * The two ways of acting on an existing veil, matched to how it was made.
 *
 * The primary always acts HERE and the second always acts across the report,
 * whatever the veil is - so the obvious button is never the far-reaching one.
 * A report-wide redaction reads no differently: clicking its fifth occurrence
 * offers to keep that one, not to undo all five.
 */
function veilActions(mark, counts, handlers) {
    const { total, exceptions } = counts;
    const many = total > 1;
    const also = (label, title, run) => (many ? [{ label, title, run }] : []);

    // An occurrence already kept out of a report-wide redaction. Putting all of
    // them back is a different act from putting this one back only once there
    // is more than one being held out - until then the two buttons would do the
    // same thing, and offering both would invent a choice.
    if (mark.sources?.includes('except')) {
        return [
            {
                label: 'Redact',
                title: 'Redact this occurrence too, like the rest of the report',
                run: () => handlers.unexceptMark(mark),
            },
            ...(exceptions > 1 ? [{
                label: `Redact all ${total}`,
                title: `Redact every "${mark.text}" in this report again`,
                run: () => handlers.unexceptEverywhere(mark),
            }] : []),
        ];
    }
    if (mark.kind === 'off') {
        return [
            { label: 'Redact', title: 'Redact this occurrence after all', run: () => handlers.restoreMark(mark) },
            ...also(`Redact all ${total}`, `Redact every "${mark.text}" in this report`,
                () => handlers.widenToDoc(mark)),
        ];
    }
    if (mark.sources?.includes('doc')) {
        // With nowhere else for the redaction to apply, keeping this one is the
        // same as withdrawing it - so do that, and leave nothing behind.
        if (!many) {
            return [{
                label: 'Unredact',
                title: 'Stop redacting this text',
                run: () => handlers.liftEverywhere(mark),
            }];
        }
        return [
            { label: 'Unredact', title: 'Keep this occurrence; the rest of the report stays redacted', run: () => handlers.exceptHere(mark) },
            { label: `Unredact all ${total}`, title: `Stop redacting "${mark.text}" anywhere in this report`, run: () => handlers.liftEverywhere(mark) },
        ];
    }
    if (mark.sources?.includes('instance')) {
        return [
            { label: 'Unredact', title: 'Stop redacting this occurrence', run: () => handlers.liftMark(mark) },
            ...also(`Redact all ${total}`, `Redact every "${mark.text}" in this report`,
                () => handlers.widenToDoc(mark)),
        ];
    }
    return [
        { label: 'Unredact', title: 'Keep this occurrence - it is not personal information', run: () => handlers.liftMark(mark) },
        ...also(`Unredact all ${total}`, `Keep every "${mark.text}" in this report`,
            () => handlers.liftEverywhere(mark)),
    ];
}

/**
 * Which occurrence of `text` the selection is, counting those above it in the
 * pane. See occurrenceIndexInPage: an index is the only thing that survives
 * the trip from a rendered view back to the stored text, and the store checks
 * it rather than trusting it.
 */
/**
 * Where the selection sits in the pane's own text, for a redaction that has to
 * be placed by position rather than found by string.
 *
 * The pane's text is captured with it, because that is what the mapping onto
 * the source is measured against, and the caret may have moved on by the time
 * the button is clicked.
 */
function selectionRegion(pane, sel) {
    const before = document.createRange();
    before.selectNodeContents(pane);
    let range;
    try {
        range = sel.getRangeAt(0);
        before.setEnd(range.startContainer, range.startOffset);
    } catch {
        return null;   // selection starts outside the pane
    }
    const start = before.toString().length;
    return { text: pane.textContent, start, end: start + range.toString().length };
}

function selectionOccurrenceIndex(pane, sel, text) {
    if (!text) return -1;
    const before = document.createRange();
    before.selectNodeContents(pane);
    try {
        const range = sel.getRangeAt(0);
        before.setEnd(range.startContainer, range.startOffset);
    } catch {
        return -1;   // selection starts outside the pane
    }
    const prefix = before.toString();
    let index = 0;
    let i = prefix.indexOf(text);
    while (i !== -1) {
        index++;
        i = prefix.indexOf(text, i + text.length);
    }
    return index;
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
