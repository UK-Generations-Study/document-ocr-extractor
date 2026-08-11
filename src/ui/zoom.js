/**
 * Magnification for the report-image pane.
 *
 * The page card KEEPS ITS SIZE at every zoom level; only the image inside it
 * scales, and the card gains scrollbars. That is not a stylistic choice - both
 * panes give each page card the page's aspect ratio so page N sits at the same
 * height in each, which is what makes the scroll link exact (see the layout
 * contract at the top of reportViewer.js and ocrView.js). Growing the card on
 * zoom would break that alignment and the link with it.
 *
 * The consequence, which is the whole design: a zoomed page is navigated
 * INSIDE its card - by dragging, or with the card's own scrollbars. The wheel
 * is deliberately left alone so it still scrolls the pane through pages and the
 * text pane still follows.
 *
 * One level for the whole pane rather than per page: pages of one report are
 * the same size, and a per-page level would mean re-zooming every page of a
 * long document. Persisted like the scroll-link toggle.
 */
import { getSettings, saveSettings } from '../core/settings.js';

/** 100% is fit-to-card. Zooming out below it would only add whitespace. */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
const STEP = 0.25;

let zoom = 1;
const listeners = new Set();

export async function initZoom() {
    const stored = Number((await getSettings()).reportZoom);
    zoom = clamp(Number.isFinite(stored) && stored > 0 ? stored : 1);
}

const clamp = (z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z / 0.05) * 0.05));

export function getZoom() {
    return zoom;
}

export function isZoomed() {
    return zoom > MIN_ZOOM;
}

/** Set the level and tell the viewer to repaint. Persists as the default. */
export function setZoom(next) {
    const z = clamp(next);
    if (z === zoom) return;
    zoom = z;
    listeners.forEach((fn) => fn(zoom));
    void saveSettings({ reportZoom: zoom });
}

export const zoomIn = () => setZoom(zoom + STEP);
export const zoomOut = () => setZoom(zoom - STEP);
export const resetZoom = () => setZoom(1);

export function onZoomChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/**
 * Zoom one step, keeping the point under the pointer where it is.
 *
 * Without this the view lurches to a different part of the page on every step
 * and has to be panned back - the thing that makes zoom feel unusable. The
 * scroll offsets are corrected in the same frame as the scale change.
 *
 * @param {HTMLElement} box the scrolling page card
 * @param {MouseEvent} ev   the wheel event, for the pointer position
 * @param {number} delta    signed step count
 */
export function zoomAtPointer(box, ev, delta) {
    const before = zoom;
    const after = clamp(before + delta * STEP);
    if (after === before) return;

    // Where the pointer sits in the CONTENT, at the current scale.
    const rect = box.getBoundingClientRect();
    const x = (box.scrollLeft + ev.clientX - rect.left) / before;
    const y = (box.scrollTop + ev.clientY - rect.top) / before;

    setZoom(after);

    // Put that same content point back under the pointer.
    box.scrollLeft = x * after - (ev.clientX - rect.left);
    box.scrollTop = y * after - (ev.clientY - rect.top);
}

/**
 * Make a zoomed page card draggable.
 *
 * Pointer events (not mouse events) so a trackpad drag and a stylus behave the
 * same, with capture so a drag that leaves the card still tracks. Returns a
 * teardown for when the card is replaced.
 */
export function makeDraggable(box) {
    let dragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    const down = (ev) => {
        // Only when there is somewhere to drag TO, and never with a modifier
        // held (ctrl+wheel zoom, and text selection, both still work).
        if (!isZoomed() || ev.button !== 0 || ev.ctrlKey || ev.metaKey) return;
        dragging = true;
        startX = ev.clientX; startY = ev.clientY;
        startLeft = box.scrollLeft; startTop = box.scrollTop;
        box.setPointerCapture(ev.pointerId);
        box.classList.add('cursor-grabbing');
        ev.preventDefault();
    };
    const move = (ev) => {
        if (!dragging) return;
        box.scrollLeft = startLeft - (ev.clientX - startX);
        box.scrollTop = startTop - (ev.clientY - startY);
    };
    const up = (ev) => {
        if (!dragging) return;
        dragging = false;
        box.releasePointerCapture?.(ev.pointerId);
        box.classList.remove('cursor-grabbing');
    };

    box.addEventListener('pointerdown', down);
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', up);
    return () => {
        box.removeEventListener('pointerdown', down);
        box.removeEventListener('pointermove', move);
        box.removeEventListener('pointerup', up);
        box.removeEventListener('pointercancel', up);
    };
}
