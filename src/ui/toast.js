/**
 * Lightweight toasts + promise-based dialogs, replacing window.alert()/
 * confirm(). Containers are created lazily on document.body so any module
 * can notify without depending on the shell markup.
 */

function toastRoot() {
    let el = document.getElementById('toast-root');
    if (!el) {
        el = document.createElement('div');
        el.id = 'toast-root';
        el.className = 'fixed bottom-4 right-4 z-[70] flex flex-col gap-2 items-end pointer-events-none';
        document.body.appendChild(el);
    }
    return el;
}

const TOAST_TONES = {
    info: 'bg-gray-900 text-gray-50',
    success: 'bg-green-800 text-green-50',
    error: 'bg-red-700 text-red-50',
};

/** Show a transient notification. */
export function showToast(message, { tone = 'info', duration = 4000 } = {}) {
    const root = toastRoot();
    const el = document.createElement('div');
    el.className = `pointer-events-auto max-w-sm rounded-md px-3.5 py-2.5 text-sm shadow-lg transition-opacity duration-300 ${TOAST_TONES[tone] || TOAST_TONES.info}`;
    el.textContent = message;
    root.appendChild(el);
    const remove = () => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 320);
    };
    el.addEventListener('click', remove);
    setTimeout(remove, duration);
}

/**
 * Modal dialog. Resolves true on the primary action, false on cancel /
 * backdrop / Escape. `bodyHtml` is trusted markup - callers must escape any
 * user-controlled strings they interpolate.
 */
let openDialogCount = 0;

function openDialog({ title, bodyHtml, confirmLabel, cancelLabel, danger }) {
    return new Promise((resolve) => {
        openDialogCount++;
        const overlay = document.createElement('div');
        overlay.className = 'fixed inset-0 z-[60] flex items-center justify-center bg-gray-900/40 p-4';
        overlay.innerHTML = `
<div class="w-full max-w-md rounded-lg bg-white shadow-xl border border-gray-200 flex flex-col max-h-[80vh]" role="dialog" aria-modal="true">
    <div class="px-4 py-3 border-b border-gray-100 text-sm font-semibold text-gray-900">${title}</div>
    <div class="px-4 py-3 text-sm text-gray-700 overflow-y-auto">${bodyHtml}</div>
    <div class="px-4 py-3 border-t border-gray-100 flex justify-end gap-2">
        ${cancelLabel ? `<button data-act="cancel" type="button"
            class="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50">${cancelLabel}</button>` : ''}
        <button data-act="ok" type="button"
            class="rounded-md px-3 py-1.5 text-sm font-medium text-white shadow-sm ${danger ? 'bg-red-600 hover:bg-red-500' : 'bg-green-800 hover:bg-green-700'}">${confirmLabel}</button>
    </div>
</div>`;
        const done = (result) => {
            openDialogCount--;
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            resolve(result);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); done(false); }
        };
        overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
        overlay.querySelector('[data-act="ok"]').addEventListener('click', () => done(true));
        overlay.querySelector('[data-act="cancel"]')?.addEventListener('click', () => done(false));
        document.addEventListener('keydown', onKey);
        document.body.appendChild(overlay);
        overlay.querySelector('[data-act="ok"]').focus();
    });
}

/** Yes/no question. Resolves boolean. */
export function confirmDialog({ title, bodyHtml, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
    return openDialog({ title, bodyHtml, confirmLabel, cancelLabel, danger });
}

/** Information with a single dismiss button. */
export function infoDialog({ title, bodyHtml, confirmLabel = 'Close' }) {
    return openDialog({ title, bodyHtml, confirmLabel, cancelLabel: null, danger: false });
}

/** True while a dialog or the wizard/settings overlay is open (keyboard shortcuts pause). */
export function isModalOpen() {
    if (openDialogCount > 0) return true;
    const wizard = document.getElementById('wizard-mount');
    const settings = document.getElementById('settings-mount');
    return !!(wizard?.childElementCount || settings?.childElementCount);
}
