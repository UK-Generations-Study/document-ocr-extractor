/**
 * Header pipeline status strip.
 *
 * A compact, always-visible readout of the batch: how many documents are
 * being read / extracted, how many are waiting on the abstractor, and how
 * many failed. Subscribes to the app bus and recomputes (debounced) from the
 * documents store, so it stays honest regardless of which pane is showing.
 */
import { allDocuments } from '../db.js';
import { onAppEvent } from '../core/bus.js';

const MOUNT_ID = 'status-strip';
const REFRESH_EVENTS = new Set(['status', 'doc-start', 'doc-done', 'enqueued', 'page-done', 'doc-deleted']);

let timer = null;

export function initStatusStrip() {
    onAppEvent((ev) => {
        if (!REFRESH_EVENTS.has(ev.type)) return;
        if (timer) return;
        timer = setTimeout(() => { timer = null; render(); }, 250);
    });
    render();
}

async function render() {
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;
    const docs = await allDocuments();
    if (!docs.length) {
        mount.innerHTML = '';
        return;
    }

    const by = (statuses) => docs.filter((d) => statuses.includes(d.status)).length;
    const working = by(['queued', 'ocr-running', 'ocr-confirmed', 'extraction-running']);
    const review = by(['ocr-done', 'extraction-done']);
    const done = by(['confirmed', 'exported']);
    const failed = by(['ocr-failed', 'extraction-failed']);

    const chips = [];
    if (working) chips.push(chip(`${working} working`, 'bg-green-800 text-green-100', true));
    if (review) chips.push(chip(`${review} to review`, 'bg-amber-300/20 text-amber-100'));
    if (failed) chips.push(chip(`${failed} failed`, 'bg-red-400/20 text-red-100'));
    chips.push(chip(`${done}/${docs.length} done`, 'bg-green-800 text-green-100'));

    mount.innerHTML = chips.join('');
}

function chip(text, cls, pulse = false) {
    return `<span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 whitespace-nowrap ${cls}">
        ${pulse ? '<span class="w-1.5 h-1.5 rounded-full bg-green-300 animate-pulse"></span>' : ''}${text}
    </span>`;
}
