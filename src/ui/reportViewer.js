/**
 * Left-pane report viewer.
 *
 * On report selection, load the document's page blobs and render them
 * stacked vertically, scrollable. Object URLs are revoked when the viewer
 * switches to a different document so we don't leak blobs.
 *
 * `mountReportViewer({selection})` wires the pane and subscribes to
 * selection changes; pass a selection facade compatible with report list.
 */
import { getBlob, getDocument } from '../db.js';

const MOUNT_ID = 'report-viewer';

let currentDocId = null;      // what we last drew (or null for empty state)
let liveObjectUrls = [];      // to revoke when we switch documents

export function mountReportViewer({ selection }) {
    // First paint - either empty state or (if selection already exists) the doc.
    renderFor(selection.getSelected());
    selection.subscribe((id) => renderFor(id));
}

async function renderFor(docId) {
    if (docId === currentDocId) return;
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

    // Loading skeleton while we fetch the document + blobs.
    mount.classList.remove('flex', 'items-center', 'justify-center');
    mount.innerHTML = `<div class="text-center text-gray-400 text-sm py-10">Loading pages…</div>`;

    const doc = await getDocument(docId);
    // Guard: the user may have clicked another row while this awaited.
    if (docId !== currentDocId) return;
    if (!doc) { renderEmpty(mount); return; }

    // Fetch every page blob in parallel; keep order.
    const pageEntries = doc.pages || [];
    const blobs = await Promise.all(pageEntries.map((p) => getBlob(p.blobKey)));
    if (docId !== currentDocId) return;

    if (!pageEntries.length) {
        mount.innerHTML = `<div class="text-center text-gray-400 text-sm py-10">This report has no pages.</div>`;
        return;
    }

    // Continuous vertical scroll.
    mount.innerHTML = `
<div class="max-w-3xl mx-auto space-y-4">
    <div class="text-xs text-gray-500 sticky top-0 bg-white/80 backdrop-blur py-1 z-10">
        ${escapeHtml(doc.name)} - ${pageEntries.length} page${pageEntries.length === 1 ? '' : 's'}
    </div>
    <div id="rv-pages" class="space-y-4"></div>
</div>`;

    const pagesRoot = mount.querySelector('#rv-pages');
    for (let i = 0; i < pageEntries.length; i++) {
        const blob = blobs[i];
        if (!blob) continue; // shouldn't happen, but be defensive
        const url = URL.createObjectURL(blob);
        liveObjectUrls.push(url);

        const wrap = document.createElement('div');
        wrap.className = 'bg-gray-50 border border-gray-200 rounded shadow-sm';
        wrap.innerHTML = `
<div class="flex items-baseline justify-between px-2 py-1 text-xs text-gray-500 border-b border-gray-200">
    <span>Page ${i + 1}</span>
    <span>${pageEntries[i].width} x ${pageEntries[i].height}</span>
</div>
<img alt="Page ${i + 1}" src="${url}"
     class="block w-full h-auto rounded-b"
     style="aspect-ratio: ${pageEntries[i].width} / ${pageEntries[i].height};" />`;
        pagesRoot.appendChild(wrap);
    }
}

function renderEmpty(mount) {
    mount.classList.add('flex', 'items-center', 'justify-center');
    mount.innerHTML = `
<div class="text-center text-gray-400">
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1" class="w-10 h-10 mb-2 opacity-40 mx-auto">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
    </svg>
    <p class="text-sm">Select a report from the list below to view its pages.</p>
</div>`;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}
