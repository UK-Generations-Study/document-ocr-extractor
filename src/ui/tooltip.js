/**
 * Small shared tooltip helper.
 *
 * One <div> is mounted on <body>; hovering any element with `[data-tooltip]`
 * (plain text) or `[data-tooltip-lines]` (JSON-encoded `[[key, desc], ...]`
 * for enum legends) reveals it. Structured tooltips render as a definition
 * list with the key in a monospace pill and the description alongside, so
 * enums like ("Y", "if the report explicitly says yes") read cleanly.
 *
 * Everything is delegated - no per-element listener setup, so newly-mounted
 * DOM (e.g. after a router swap) works without any re-init.
 */

let tip = null;

function ensureTip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.id = 'app-tooltip';
    tip.className = 'hidden fixed z-50 max-w-sm rounded-md border border-gray-200 bg-white text-gray-800 text-xs shadow-lg pointer-events-none';
    tip.style.padding = '6px 8px';
    document.body.appendChild(tip);
    return tip;
}

function showText(text) {
    const t = ensureTip();
    t.className = 'fixed z-50 max-w-sm rounded-md border border-gray-200 bg-white text-gray-800 text-xs shadow-lg pointer-events-none leading-snug';
    t.style.padding = '6px 8px';
    t.textContent = text;
}

function showLines(lines) {
    const t = ensureTip();
    t.className = 'fixed z-50 max-w-md rounded-md border border-gray-200 bg-white text-gray-800 text-xs shadow-lg pointer-events-none';
    t.style.padding = '4px 6px';
    t.innerHTML = '';
    const dl = document.createElement('dl');
    dl.className = 'grid gap-x-2 gap-y-1 items-baseline';
    dl.style.gridTemplateColumns = 'auto 1fr';
    for (const [key, desc] of lines) {
        const dt = document.createElement('dt');
        dt.className = 'font-mono text-[10.5px] font-semibold text-gray-900 bg-gray-100 rounded px-1 py-0.5 justify-self-start';
        dt.textContent = key;
        const dd = document.createElement('dd');
        dd.className = 'text-gray-700 leading-snug';
        dd.textContent = desc || '';
        dl.appendChild(dt);
        dl.appendChild(dd);
    }
    t.appendChild(dl);
}

function hide() {
    if (tip) tip.classList.add('hidden');
}

function position(target) {
    if (!tip || tip.classList.contains('hidden')) return;
    const r = target.getBoundingClientRect();
    tip.style.left = '0px'; tip.style.top = '0px';
    // Now measure.
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const padding = 6;
    // Prefer below; if it overflows viewport, go above.
    let top = r.bottom + padding;
    if (top + th > window.innerHeight - 4) top = Math.max(4, r.top - th - padding);
    // Horizontal: try to center on target, clamp to viewport.
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - tw - 4));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
}

let currentTarget = null;

function handleOver(ev) {
    const el = ev.target?.closest?.('[data-tooltip], [data-tooltip-lines]');
    if (!el) return;
    if (el === currentTarget) return;
    currentTarget = el;
    const t = ensureTip();
    if (el.hasAttribute('data-tooltip-lines')) {
        try { showLines(JSON.parse(el.getAttribute('data-tooltip-lines'))); }
        catch { showText(el.getAttribute('data-tooltip-lines')); }
    } else {
        showText(el.getAttribute('data-tooltip'));
    }
    t.classList.remove('hidden');
    position(el);
}

function handleOut(ev) {
    const from = ev.target?.closest?.('[data-tooltip], [data-tooltip-lines]');
    if (!from || from !== currentTarget) return;
    // Ignore transitions to a child of the same trigger.
    if (from.contains(ev.relatedTarget)) return;
    currentTarget = null;
    hide();
}

/** Wire the shared tooltip once at app boot. */
export function initTooltip() {
    ensureTip();
    document.addEventListener('mouseover', handleOver);
    document.addEventListener('mouseout', handleOut);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}
