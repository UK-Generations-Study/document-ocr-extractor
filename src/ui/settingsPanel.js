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
import { OCR_ONLY } from '../core/flags.js';
import { DEFAULT_ENTITIES, checkHealth, supportedEntities } from '../deid/presidio.js';
import { allDocuments, getOcrPagesByDoc, putDocument } from '../db.js';
import { emitAppEvent } from '../core/bus.js';
import { countDocLowConfLines } from '../ocr/confidence.js';
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
        desc: OCR_ONLY
            ? 'Reports whose OCR looks clean are confirmed automatically. Only pages with low-confidence lines stop for review.'
            : 'Reports whose OCR looks clean skip the text check and go straight to extraction. Only pages with low-confidence lines stop for review.',
    },
    {
        id: REVIEW_MODES.AUTO,
        title: 'Fully automatic',
        desc: OCR_ONLY
            ? 'No text check at all - every report is confirmed as soon as OCR finishes. Best for large, clean batches.'
            : 'No text check at all - every report flows from OCR into extraction. Best for large, clean batches.',
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
            <!-- Configuration summary (LLM-only; hidden in OCR-only builds) -->
            ${OCR_ONLY ? '' : `
            <section>
                <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500">Configuration</h3>
                <dl class="mt-2 divide-y divide-gray-100 border border-gray-200 rounded-md">
                    ${configRowHtml('Schema', schemaLabel, 1)}
                    ${configRowHtml('LLM provider', providerLabel, 2)}
                    ${configRowHtml('Model', status.model || '—', 3)}
                </dl>
            </section>`}

            <!-- Processing mode -->
            <section>
                <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500">Processing</h3>
                <p class="mt-1 text-xs text-gray-500">
                    How much of the batch runs without stopping for you.${OCR_ONLY ? '' : `
                    Extracted fields always wait for your confirmation - singly, or via
                    "Confirm all" in the sidebar.`}
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
                <div class="mt-4">
                    <div class="flex items-center justify-between">
                        <label for="sp-threshold" class="text-sm font-medium text-gray-900">OCR confidence threshold</label>
                        <span id="sp-threshold-value" class="text-sm font-mono text-gray-700">${Math.round(settings.lowConfThreshold * 100)}%</span>
                    </div>
                    <input id="sp-threshold" type="range" min="0.3" max="0.9" step="0.05"
                           value="${settings.lowConfThreshold}"
                           class="mt-1 w-full accent-green-700"/>
                    <p class="mt-1 text-xs text-gray-500">
                        Text the OCR engine read with confidence below this is flagged for review
                        (boxed on the page, highlighted in the text, counted in "unsure").
                        Higher flags more; lower flags less. Also sets the bar for the
                        "review flagged only" mode.
                    </p>
                </div>
            </section>

            <!-- De-identification -->
            <section>
                <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500">De-identification</h3>
                <label class="mt-2 flex items-start gap-2 text-sm text-gray-800 cursor-pointer">
                    <input id="sp-deid" type="checkbox" ${settings.deidEnabled ? 'checked' : ''}
                           class="mt-0.5 h-4 w-4 rounded text-green-600 focus:ring-green-500"/>
                    <span>
                        <span class="block font-medium">Remove personal identifiers with Presidio</span>
                        <span class="block text-xs text-gray-600 mt-0.5">
                            After OCR, each recognized text region is analyzed and any detected
                            identifiers are replaced with <code>[REDACTED]</code>. Exports (and the
                            LLM, when extraction is enabled) only ever see the redacted text.
                        </span>
                    </span>
                </label>
                <div id="sp-deid-opts" class="mt-3 space-y-3 ${settings.deidEnabled ? '' : 'hidden'}">
                    <div>
                        <label for="sp-deid-url" class="block text-xs font-medium text-gray-700">Service path</label>
                        <div class="mt-1 flex gap-2">
                            <input id="sp-deid-url" type="text" value="${escapeAttr(settings.deidBaseUrl)}"
                                   class="flex-1 rounded-md border border-gray-300 px-2.5 py-1.5 text-sm text-gray-900 focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"/>
                            <button id="sp-deid-test" type="button"
                                    class="shrink-0 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
                                Test
                            </button>
                        </div>
                        <p id="sp-deid-status" class="mt-1 text-xs text-gray-500">
                            Same-origin path proxied to the Presidio analyzer and anonymizer
                            containers. The services cannot be called directly from the browser
                            (no CORS headers), so this must stay a same-origin path.
                        </p>
                    </div>
                    <div>
                        <div class="flex items-center justify-between">
                            <span class="text-xs font-medium text-gray-700">Identifier types</span>
                            <button id="sp-deid-load" type="button" class="text-[11px] text-green-800 hover:underline">
                                Load all from service
                            </button>
                        </div>
                        <div id="sp-deid-entities" class="mt-1.5 flex flex-wrap gap-1"></div>
                        <p class="mt-1 text-xs text-gray-500">
                            Unselecting everything detects every type the service supports.
                        </p>
                    </div>
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

    // Threshold slider: live % readout on input; persist + recompute the
    // stored per-doc "unsure" counts on release.
    const slider = mount.querySelector('#sp-threshold');
    const sliderValue = mount.querySelector('#sp-threshold-value');
    slider.addEventListener('input', () => {
        sliderValue.textContent = `${Math.round(Number(slider.value) * 100)}%`;
    });
    slider.addEventListener('change', async () => {
        const value = Number(slider.value);
        await saveSettings({ lowConfThreshold: value });
        const n = await recomputeDocFlags();
        emitAppEvent({ source: 'settings', type: 'flags-recomputed' });
        showToast(`Confidence threshold set to ${Math.round(value * 100)}%${n ? ` - re-flagged ${n} report${n === 1 ? '' : 's'}` : ''}.`, { tone: 'success' });
    });

    mount.querySelector('#sp-sync').addEventListener('change', (e) => {
        setSyncEnabled(e.target.checked);
    });

    wireDeidControls(mount, settings);
}

// ---------- de-identification controls ----------

function wireDeidControls(mount, settings) {
    const toggle = mount.querySelector('#sp-deid');
    const opts = mount.querySelector('#sp-deid-opts');
    const urlInput = mount.querySelector('#sp-deid-url');
    const statusEl = mount.querySelector('#sp-deid-status');
    const entitiesWrap = mount.querySelector('#sp-deid-entities');

    // Start from the configured selection; "Load all" widens the choices to
    // whatever the running analyzer build supports.
    let known = [...new Set([...DEFAULT_ENTITIES, ...(settings.deidEntities || [])])].sort();
    let selected = new Set(settings.deidEntities || []);

    const paintEntities = () => {
        entitiesWrap.innerHTML = known.map((e) => {
            const on = selected.has(e);
            return `<button type="button" data-entity="${escapeAttr(e)}"
                class="rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
                    on ? 'bg-green-800 text-white ring-green-800' : 'bg-white text-gray-600 ring-gray-300 hover:bg-gray-100'}">
                ${escapeHtml(e)}</button>`;
        }).join('');
        entitiesWrap.querySelectorAll('button[data-entity]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const e = btn.dataset.entity;
                if (selected.has(e)) selected.delete(e); else selected.add(e);
                paintEntities();
                await saveSettings({ deidEntities: [...selected] });
            });
        });
    };
    paintEntities();

    const setStatus = (msg, tone) => {
        statusEl.textContent = msg;
        statusEl.className = `mt-1 text-xs ${
            tone === 'ok' ? 'text-green-700' : tone === 'error' ? 'text-red-700' : 'text-gray-500'}`;
    };

    toggle.addEventListener('change', async () => {
        opts.classList.toggle('hidden', !toggle.checked);
        await saveSettings({ deidEnabled: toggle.checked });
        showToast(
            toggle.checked
                ? 'De-identification on. It runs after OCR; documents fail if the service is unreachable.'
                : 'De-identification off. New documents keep their original text.',
            { tone: toggle.checked ? 'success' : 'info' },
        );
    });

    urlInput.addEventListener('change', async () => {
        await saveSettings({ deidBaseUrl: urlInput.value.trim() || '/presidio' });
        setStatus('Service path saved. Use Test to check it.', null);
    });

    mount.querySelector('#sp-deid-test').addEventListener('click', async () => {
        setStatus('Contacting the Presidio services…', null);
        try {
            await checkHealth({ base: urlInput.value.trim() || '/presidio' });
            setStatus('Analyzer and anonymizer both reachable.', 'ok');
        } catch (err) {
            setStatus(err?.message || 'Could not reach the service.', 'error');
        }
    });

    mount.querySelector('#sp-deid-load').addEventListener('click', async () => {
        setStatus('Fetching supported identifier types…', null);
        try {
            const all = await supportedEntities({ base: urlInput.value.trim() || '/presidio' });
            if (!all.length) throw new Error('The service returned no entity types.');
            known = [...new Set([...known, ...all])].sort();
            paintEntities();
            setStatus(`Loaded ${all.length} identifier types from the service.`, 'ok');
        } catch (err) {
            setStatus(err?.message || 'Could not load entity types.', 'error');
        }
    });
}

/** Recount every OCR'd document's attention flags under the new threshold so
 *  the sidebar badges (doc.lowConfLines) stay truthful. Returns the number of
 *  documents whose count changed. */
async function recomputeDocFlags() {
    const docs = await allDocuments();
    let changed = 0;
    for (const d of docs) {
        if (d.status === 'queued' || d.status === 'ocr-running' || d.status === 'ocr-failed') continue;
        const pages = await getOcrPagesByDoc(d.id);
        if (!pages.length) continue;
        const n = countDocLowConfLines(pages);
        if (n !== d.lowConfLines) {
            d.lowConfLines = n;
            await putDocument(d);
            changed++;
        }
    }
    return changed;
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
