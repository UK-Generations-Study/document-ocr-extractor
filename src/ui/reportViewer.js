/**
 * Center-pane report viewer.
 *
 * On report selection, load the document's page blobs and render them
 * stacked vertically, scrollable. Object URLs are revoked when the viewer
 * switches to a different document so we don't leak blobs. Images load
 * lazily - page dimensions are known up front, so layout is stable and the
 * browser only decodes pages as they approach the viewport.
 *
 * Low-confidence OCR lines are drawn as amber boxes over the page image
 * (page-pixel coords scaled to percentages), so the abstractor can see
 * exactly where to look for OCR errors. Overlays refresh as OCR pages land.
 *
 * Layout contract with ocrView.js: the sticky pane header is min-h-16, page
 * card headers are h-8, and card bodies share the page's aspect ratio - so
 * page N here and page N in the OCR pane have identical heights and line up
 * (which also makes the scroll link exact). Keep the two in sync if you
 * change one.
 *
 * The sticky header hosts the scroll-link toggle (sync page images with the
 * OCR text pane, or scroll independently); state lives in syncScroll.js.
 */
import { getBlob, getDocument, getOcrPagesByDoc } from '../db.js';
import { onAppEvent } from '../core/bus.js';
import { attentionRegions } from '../ocr/confidence.js';
import { isSyncEnabled, setSyncEnabled, onSyncToggle } from './syncScroll.js';

const MOUNT_ID = 'report-viewer';

let currentDocId = null;      // what we last drew (or null for empty state)
let liveObjectUrls = [];      // to revoke when we switch documents

export function mountReportViewer({ selection }) {
    // First paint - either empty state or (if selection already exists) the doc.
    renderFor(selection.getSelected());
    selection.subscribe((id) => renderFor(id));
    onSyncToggle(() => paintSyncButton());
    // Redraw when OCR results land for the current doc so the low-confidence
    // overlays appear/refresh without re-selecting.
    onAppEvent((ev) => {
        if ((ev.source === 'ocr' || ev.source === 'deep')
            && (ev.type === 'page-done' || ev.type === 'doc-done')
            && ev.docId && ev.docId === currentDocId) {
            renderFor(currentDocId, { force: true });
        }
    });
}

async function renderFor(docId, { force } = {}) {
    if (!force && docId === currentDocId) return;
    // Revoke any object URLs from the previous doc before dropping the DOM.
    liveObjectUrls.forEach((u) => URL.revokeObjectURL(u));
    liveObjectUrls = [];
    currentDocId = docId;

    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;

    if (!docId) {
        renderEmpty(mount);
        return;
    }

    const keepScroll = force ? mount.scrollTop : 0;

    // Loading skeleton while we fetch the document + blobs.
    mount.classList.remove('flex', 'items-center', 'justify-center');
    if (!force) mount.innerHTML = `<div class="text-center text-gray-400 text-sm py-10">Loading pages…</div>`;

    const doc = await getDocument(docId);
    // Guard: the user may have clicked another row while this awaited.
    if (docId !== currentDocId) return;
    if (!doc) { renderEmpty(mount); return; }

    // Fetch every page blob (and any OCR results, for overlays) in parallel.
    const pageEntries = doc.pages || [];
    const [blobs, ocrPages] = await Promise.all([
        Promise.all(pageEntries.map((p) => getBlob(p.blobKey))),
        getOcrPagesByDoc(docId),
    ]);
    if (docId !== currentDocId) return;
    const ocrByKey = new Map(ocrPages.map((r) => [r.pageBlobKey, r]));

    if (!pageEntries.length) {
        mount.innerHTML = `<div class="text-center text-gray-400 text-sm py-10">This report has no pages.</div>`;
        return;
    }

    const title = doc.metadata?.tcode || doc.name;
    mount.innerHTML = `
<div class="max-w-3xl mx-auto space-y-4">
    <div class="sticky top-0 z-10 -mx-4 px-4 h-16 bg-white/90 backdrop-blur border-b border-gray-200 flex items-center justify-between gap-2">
        <span class="text-xs text-gray-500 truncate">
            ${escapeHtml(title)} · ${pageEntries.length} page${pageEntries.length === 1 ? '' : 's'}
        </span>
        <button id="rv-sync-toggle" type="button"
                title="When linked, the OCR text pane follows this pane page-by-page (and vice versa)."
                class="shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium ring-1 ring-inset"></button>
    </div>
    <div id="rv-pages" class="space-y-4"></div>
</div>`;

    const pagesRoot = mount.querySelector('#rv-pages');
    for (let i = 0; i < pageEntries.length; i++) {
        const blob = blobs[i];
        if (!blob) continue; // shouldn't happen, but be defensive
        const url = URL.createObjectURL(blob);
        liveObjectUrls.push(url);

        const page = pageEntries[i];
        const ocr = ocrByKey.get(page.blobKey);
        const wrap = document.createElement('div');
        wrap.className = 'bg-gray-50 border border-gray-200 rounded shadow-sm';
        wrap.dataset.pageIndex = String(i);
        wrap.innerHTML = `
<div class="h-8 flex items-center justify-between px-3 text-xs text-gray-500 border-b border-gray-200">
    <span>Page ${i + 1}</span>
    <span>${page.width} x ${page.height}</span>
</div>
<div class="relative">
    <img alt="Page ${i + 1}" src="${url}" loading="lazy" decoding="async"
         class="block w-full h-auto rounded-b"
         style="aspect-ratio: ${page.width} / ${page.height};" />
    ${overlaysHtml(page, ocr)}
</div>`;
        pagesRoot.appendChild(wrap);
    }

    mount.querySelector('#rv-sync-toggle')?.addEventListener('click', () => {
        setSyncEnabled(!isSyncEnabled());
    });
    paintSyncButton();
    if (force && keepScroll) mount.scrollTop = keepScroll;
}

/** Per-kind box styling: amber = weak recognition, dashed sky = text outside
 *  the recognized layout (typical for scribbles/noise), red = model conflict. */
const OVERLAY_STYLES = {
    'low-conf': 'ring-2 ring-amber-400/90 bg-amber-300/20 hover:bg-amber-300/40',
    'coverage-gap': 'border-2 border-dashed border-sky-500/80 bg-sky-300/15 hover:bg-sky-300/30',
    'disagreement': 'ring-2 ring-red-500/90 bg-red-300/20 hover:bg-red-300/40',
};

/** Boxes over the page image marking every OCR region needing attention. */
function overlaysHtml(page, ocr) {
    if (!ocr) return '';
    const regions = attentionRegions(ocr.uncertainty);
    if (!regions.length) return '';
    // Boxes are page-pixel coords in the OCR raster's frame; scale to
    // percentages so they track the displayed image size.
    const W = ocr.width || page.width;
    const H = ocr.height || page.height;
    if (!W || !H) return '';
    return regions
        .filter((r) => r.box && r.box.x1 > r.box.x0 && r.box.y1 > r.box.y0)
        .map((r) => {
            const left = (r.box.x0 / W) * 100;
            const top = (r.box.y0 / H) * 100;
            const width = ((r.box.x1 - r.box.x0) / W) * 100;
            const height = ((r.box.y1 - r.box.y0) / H) * 100;
            return `<div class="absolute rounded-sm ${OVERLAY_STYLES[r.kind] || OVERLAY_STYLES['low-conf']}"
                title="${escapeAttr(r.tip)}"
                style="left:${left.toFixed(2)}%;top:${top.toFixed(2)}%;width:${width.toFixed(2)}%;height:${height.toFixed(2)}%;"></div>`;
        })
        .join('');
}

function paintSyncButton() {
    const btn = document.getElementById('rv-sync-toggle');
    if (!btn) return;
    const on = isSyncEnabled();
    btn.className = `shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium ring-1 ring-inset ${
        on ? 'bg-green-50 text-green-800 ring-green-300 hover:bg-green-100'
           : 'bg-white text-gray-500 ring-gray-300 hover:bg-gray-50'}`;
    btn.innerHTML = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5">
    <path d="M12.232 4.232a2.5 2.5 0 013.536 3.536l-1.225 1.224a.75.75 0 001.061 1.06l1.224-1.224a4 4 0 00-5.656-5.656l-3 3a4 4 0 00.225 5.865.75.75 0 00.977-1.138 2.5 2.5 0 01-.142-3.667l3-3z"/>
    <path d="M11.603 7.963a.75.75 0 00-.977 1.138 2.5 2.5 0 01.142 3.667l-3 3a2.5 2.5 0 01-3.536-3.536l1.225-1.224a.75.75 0 00-1.061-1.06l-1.224 1.224a4 4 0 105.656 5.656l3-3a4 4 0 00-.225-5.865z"/>
</svg>
${on ? 'Scroll linked' : 'Scroll independent'}`;
}

function renderEmpty(mount) {
    mount.classList.add('flex', 'items-center', 'justify-center');
    mount.innerHTML = `
<div class="text-center text-gray-400">
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1" class="w-10 h-10 mb-2 opacity-40 mx-auto">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
    </svg>
    <p class="text-sm">Select a report from the list to view its pages.</p>
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
