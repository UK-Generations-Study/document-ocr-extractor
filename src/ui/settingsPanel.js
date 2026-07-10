/**
 * Settings panel (gear icon). A single modal summarizing the current
 * configuration with "Change…" shortcuts into the setup wizard, plus the
 * processing-mode choice that governs how much of the pipeline runs without
 * a human stop, and view preferences.
 *
 * Mounted into #settings-mount. The wizard remains the first-run experience;
 * this panel is for day-to-day adjustments so changing (say) the model no
 * longer means re-walking schema + credentials.
 */
import { getSettings, saveSettings, REVIEW_MODES } from '../core/settings.js';
import { isSyncEnabled, setSyncEnabled } from './syncScroll.js';
import { showToast } from './toast.js';

const MOUNT_ID = 'settings-mount';

const MODE_COPY = [
    {
        id: REVIEW_MODES.MANUAL,
        title: 'Review everything',
        desc: 'Every report stops for a text check after OCR. Safest; slowest for large batches.',
    },
    {
        id: REVIEW_MODES.FLAGGED,
        title: 'Review flagged text only',
        desc: 'Reports whose OCR looks clean skip the text check and go straight to extraction. Only pages with low-confidence lines stop for review.',
    },
    {
        id: REVIEW_MODES.AUTO,
        title: 'Fully automatic',
        desc: 'No text check at all - every report flows from OCR into extraction. Best for large, clean batches.',
    },
];

/**
 * @param {object} deps
 * @param {() => Promise<object>} deps.readSetupStatus  Same shape app.js gives the wizard.
 * @param {(startStep: number) => void} deps.openWizardAt  Close this panel, open the wizard at a step.
 */
export async function openSettingsPanel(deps) {
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;

    const [status, settings] = await Promise.all([deps.readSetupStatus(), getSettings()]);

    const providerLabel = { openai: 'OpenAI / compatible', gemini: 'Google Gemini', webllm: 'In-browser (WebLLM)' }[status.provider] || '—';
    const schemaLabel = status.currentSchemaUrl ? prettySchemaLabel(status.currentSchemaUrl) : '—';

    mount.innerHTML = `
<div id="sp-overlay" class="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4">
    <div class="w-full max-w-lg max-h-[85vh] rounded-lg bg-white shadow-xl border border-gray-200 flex flex-col" role="dialog" aria-modal="true">
        <div class="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 class="text-base font-semibold text-gray-900">Settings</h2>
            <button id="sp-close" type="button" class="text-gray-400 hover:text-gray-700" aria-label="Close">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
                </svg>
            </button>
        </div>
        <div class="p-5 space-y-6 overflow-y-auto">
            <!-- Configuration summary -->
            <section>
                <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500">Configuration</h3>
                <dl class="mt-2 divide-y divide-gray-100 border border-gray-200 rounded-md">
                    ${configRowHtml('Schema', schemaLabel, 1)}
                    ${configRowHtml('LLM provider', providerLabel, 2)}
                    ${configRowHtml('Model', status.model || '—', 3)}
                </dl>
            </section>

            <!-- Processing mode -->
            <section>
                <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500">Processing</h3>
                <p class="mt-1 text-xs text-gray-500">
                    How much of the batch runs without stopping for you. Extracted fields always wait for
                    your confirmation - singly, or via "Confirm all" in the sidebar.
                </p>
                <div class="mt-2 space-y-2">
                    ${MODE_COPY.map((m) => `
                    <label class="flex items-start gap-3 rounded-md border p-3 cursor-pointer hover:border-green-500 has-[:checked]:border-green-600 has-[:checked]:bg-green-50 border-gray-300">
                        <input type="radio" name="sp-mode" value="${m.id}" ${settings.reviewMode === m.id ? 'checked' : ''}
                               class="mt-0.5 h-4 w-4 text-green-600 focus:ring-green-500 border-gray-300"/>
                        <span>
                            <span class="block text-sm font-medium text-gray-900">${m.title}</span>
                            <span class="block text-xs text-gray-600 mt-0.5">${m.desc}</span>
                        </span>
                    </label>`).join('')}
                </div>
            </section>

            <!-- View -->
            <section>
                <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500">View</h3>
                <label class="mt-2 flex items-center gap-2 text-sm text-gray-800 cursor-pointer">
                    <input id="sp-sync" type="checkbox" ${isSyncEnabled() ? 'checked' : ''}
                           class="h-4 w-4 rounded text-green-600 focus:ring-green-500"/>
                    Link scrolling between page images and OCR text
                </label>
            </section>
        </div>
    </div>
</div>`;

    const close = () => {
        mount.innerHTML = '';
        document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    mount.querySelector('#sp-close').addEventListener('click', close);
    mount.querySelector('#sp-overlay').addEventListener('click', (e) => {
        if (e.target === mount.querySelector('#sp-overlay')) close();
    });

    mount.querySelectorAll('button[data-step]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const step = Number(btn.dataset.step);
            close();
            deps.openWizardAt(step);
        });
    });

    mount.querySelectorAll('input[name="sp-mode"]').forEach((radio) => {
        radio.addEventListener('change', async () => {
            await saveSettings({ reviewMode: radio.value });
            const mode = MODE_COPY.find((m) => m.id === radio.value);
            showToast(`Processing mode: ${mode?.title || radio.value}.`, { tone: 'success' });
        });
    });

    mount.querySelector('#sp-sync').addEventListener('change', (e) => {
        setSyncEnabled(e.target.checked);
    });
}

function configRowHtml(label, value, step) {
    return `
<div class="flex items-center justify-between gap-3 px-3 py-2">
    <div class="min-w-0">
        <dt class="text-xs text-gray-500">${label}</dt>
        <dd class="text-sm text-gray-900 truncate" title="${escapeAttr(value)}">${escapeHtml(value)}</dd>
    </div>
    <button type="button" data-step="${step}"
            class="shrink-0 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50">
        Change…
    </button>
</div>`;
}

/** Compress a config URL to something readable ("…/schemas/bbd/config.json"). */
function prettySchemaLabel(url) {
    try {
        const path = new URL(url, window.location.href).pathname;
        const parts = path.split('/').filter(Boolean);
        return parts.slice(-3).join('/');
    } catch {
        return url;
    }
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
