/**
 * Page-aligned scroll linking between the report viewer (page images) and
 * the OCR review pane (per-page text cards).
 *
 * Both panes mark their per-page elements with data-page-index. On scroll of
 * either container we find the page under a fixed anchor line, compute how
 * far through that page we are (0..1), and scroll the other container so its
 * matching page sits at the same fraction. Because pages have very different
 * heights in the two panes, this page+fraction mapping tracks far better
 * than proportional scrollTop syncing.
 *
 * The link only engages when BOTH containers currently contain page-indexed
 * elements, so it is naturally inert while the right pane shows the
 * extraction form or an empty state.
 *
 * A lock guards against feedback: while we programmatically scroll the
 * counterpart, its own scroll events are ignored for a short window.
 *
 * The toggle lives in the viewer header (reportViewer.js); the default comes
 * from settings.syncScroll.
 */
import { getSettings, saveSettings } from '../core/settings.js';

const ANCHOR_PX = 80;   // measure at this offset below the container top (past sticky headers)

let enabled = true;
let lockOwner = null;   // container currently driving a programmatic scroll
let lockTimer = null;
const toggleListeners = new Set();

export async function initSyncScroll() {
    enabled = (await getSettings()).syncScroll !== false;
    const viewer = document.getElementById('report-viewer');
    const work = document.getElementById('work-surface');
    if (!viewer || !work) return;
    viewer.addEventListener('scroll', () => mirror(viewer, work), { passive: true });
    work.addEventListener('scroll', () => mirror(work, viewer), { passive: true });
}

export function isSyncEnabled() {
    return enabled;
}

/** Flip the link on/off; persists as the default for future sessions. */
export function setSyncEnabled(on) {
    enabled = !!on;
    void saveSettings({ syncScroll: enabled });
    for (const fn of toggleListeners) {
        try { fn(enabled); } catch (err) { console.error(err); }
    }
}

/** Views subscribe to keep their toggle buttons in sync. */
export function onSyncToggle(fn) {
    toggleListeners.add(fn);
    return () => toggleListeners.delete(fn);
}

function mirror(src, dst) {
    if (!enabled) return;
    if (lockOwner && lockOwner !== src) return; // echo of our own programmatic scroll

    const srcPages = src.querySelectorAll('[data-page-index]');
    if (!srcPages.length) return;
    if (!dst.querySelector('[data-page-index]')) return;

    // Which src page crosses the anchor line, and how far through it are we?
    const srcTop = src.getBoundingClientRect().top;
    let idx = null;
    let frac = 0;
    for (const el of srcPages) {
        const r = el.getBoundingClientRect();
        const top = r.top - srcTop;
        if (top <= ANCHOR_PX && top + r.height > ANCHOR_PX) {
            idx = el.dataset.pageIndex;
            frac = r.height > 0 ? (ANCHOR_PX - top) / r.height : 0;
            break;
        }
    }
    if (idx === null) {
        // Above the first page (e.g. scrolled to very top): pin to page 0 start.
        const first = srcPages[0].getBoundingClientRect();
        if (first.top - srcTop > ANCHOR_PX) { idx = srcPages[0].dataset.pageIndex; frac = 0; }
        else return;
    }

    const target = dst.querySelector(`[data-page-index="${idx}"]`);
    if (!target) return;
    const dstRect = dst.getBoundingClientRect();
    const tRect = target.getBoundingClientRect();
    const targetTopInContent = tRect.top - dstRect.top + dst.scrollTop;
    const wanted = targetTopInContent + frac * tRect.height - ANCHOR_PX;
    if (Math.abs(dst.scrollTop - wanted) < 2) return;

    lockOwner = src;
    dst.scrollTop = wanted;
    clearTimeout(lockTimer);
    lockTimer = setTimeout(() => { lockOwner = null; }, 150);
}
