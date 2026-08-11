/**
 * First-run setup wizard, also reopened via the gear icon.
 *
 * Three steps: (1) schema pick, (2) API credentials, (3) model select.
 * Each step persists as it advances so an interrupted setup resumes from
 * where the user left off. Reuses the extractor's existing config-load and
 * credential-validation flows (passed in from app.js so this file stays UI-
 * only and doesn't reach into the DB or the LLM SDKs directly).
 *
 * `openWizard(deps)` mounts the overlay into #wizard-mount. `closeWizard()`
 * removes it. On the last step's Finish, the deps.onComplete callback fires
 * so app.js can reveal the shell (first run) or just refresh state (settings
 * reopen).
 */
import { API_PROVIDERS } from '../core/constants.js';

// Bundled URLs point at public/schemas/{bbd,brca}/config.json which
// scripts/prepare-build.mjs stages on every build. The BASE_URL prefix is
// substituted at build time by Vite. Anyone who wants a remote-fetched
// schema (e.g. a centrally-curated version) can paste the URL into the
// Custom URL field.
const CONFIG_PRESETS = {
    bbd: {
        label: 'Benign Breast Disease',
        description: 'Single schema of 11 fields for BBD pathology reports.',
        url: import.meta.env.BASE_URL + 'schemas/bbd/config.json',
    },
    brca: {
        label: 'Breast Cancer',
        description: 'Twelve UK Generations Study schemas covering specimen, IHC, grading, staging, and more.',
        url: import.meta.env.BASE_URL + 'schemas/brca/config.json',
    },
};

const MOUNT_ID = 'wizard-mount';

let currentStep = 1;
let selectedPreset = null;    // 'bbd' | 'brca' | 'custom' | null
let deps = null;              // injected from app.js

/**
 * Open the wizard.
 * @param {object} injected
 * @param {(url: string) => Promise<{ok: boolean, error?: string}>} injected.loadConfig
 *   Fetch + validate a config URL, save into IndexedDB.
 * @param {() => Promise<{schemaOk: boolean, credsOk: boolean, modelOk: boolean, provider: string|null, model: string|null}>} injected.readSetupStatus
 *   Report which setup slots are already populated.
 * @param {(provider: string, apiKey: string, baseUrl?: string) => Promise<{ok: boolean, error?: string, modelIds?: string[]}>} injected.validateAndSaveCreds
 *   Validate credentials, save them, and return the model list.
 * @param {(modelName: string) => Promise<void>} injected.saveModel
 * @param {() => void} injected.onComplete  Called on Finish.
 * @param {number} [injected.startStep]  Open at a specific step (1..3); used
 *   by the settings panel's "Change…" buttons. Without it the wizard starts
 *   at the first incomplete step.
 */
export async function openWizard(injected) {
    deps = injected;
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;

    // Decide starting step from what's already saved: skip completed slots.
    const status = await deps.readSetupStatus();
    if (injected.startStep >= 1 && injected.startStep <= 3) currentStep = injected.startStep;
    else if (!status.schemaOk) currentStep = 1;
    else if (!status.credsOk) currentStep = 2;
    else if (!status.modelOk) currentStep = 3;
    else currentStep = 1;

    mount.innerHTML = wizardOverlayHtml();
    await renderStep(currentStep);

    // ESC closes the wizard iff setup was already complete (gear-icon reopen).
    document.addEventListener('keydown', escHandler);
}

function escHandler(e) {
    if (e.key !== 'Escape') return;
    deps.readSetupStatus().then((s) => {
        if (s.schemaOk && s.credsOk && s.modelOk) closeWizard();
    });
}

export function closeWizard() {
    const mount = document.getElementById(MOUNT_ID);
    if (mount) mount.innerHTML = '';
    document.removeEventListener('keydown', escHandler);
    deps = null;
}

function wizardOverlayHtml() {
    // Full-screen page-styled setup surface (no modal card, no dark backdrop).
    // Covers the workspace including the app header - which is fine because
    // there's nothing meaningful to interact with underneath during setup.
    return `
<div class="fixed inset-0 z-40 bg-gray-50 overflow-y-auto">
    <div class="max-w-2xl mx-auto px-6 pt-8 pb-16">
        <div class="flex items-baseline justify-between mb-6">
            <div>
                <h1 class="text-xl font-semibold text-gray-900">Setup</h1>
                <p id="wizard-step-label" class="text-xs text-gray-500 mt-0.5"></p>
            </div>
            <button id="wizard-close" type="button" style="display:none"
                    class="text-sm text-gray-500 hover:text-gray-800 items-center gap-1"
                    title="Close" aria-label="Close">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
                </svg>
                Close
            </button>
        </div>
        <div id="wizard-body" class="bg-white rounded-md border border-gray-200 p-6"></div>
        <div id="wizard-footer" class="mt-4 flex justify-between items-center"></div>
    </div>
</div>`;
}

/**
 * @param {number} n step to show
 * @param {string[]} [modelIds] models just listed by a credential check, used
 *   in preference to whatever readSetupStatus reports for step 3.
 */
async function renderStep(n, modelIds) {
    currentStep = n;
    const label = document.getElementById('wizard-step-label');
    if (label) label.textContent = `Step ${n} of 3`;

    const body = document.getElementById('wizard-body');
    const footer = document.getElementById('wizard-footer');
    if (!body || !footer) return;

    // Show the close (X) button once initial setup is complete so gear-icon
    // reopens are dismissable; hide during first-run so the user must finish.
    const status = await deps.readSetupStatus();
    const complete = status.schemaOk && status.credsOk && status.modelOk;
    const closeBtn = document.getElementById('wizard-close');
    if (closeBtn) {
        closeBtn.style.display = complete ? 'inline-flex' : 'none';
        closeBtn.onclick = () => closeWizard();
    }

    if (n === 1) return renderSchemaStep(body, footer, status);
    if (n === 2) return renderCredsStep(body, footer, status);
    if (n === 3) return renderModelStep(body, footer, status, modelIds);
}

// ---------- Step 1: schema ----------

function renderSchemaStep(body, footer, status) {
    body.innerHTML = `
<h3 class="text-base font-semibold text-gray-900">Choose a schema</h3>
<p class="text-sm text-gray-600 mt-1">
    The schema tells the LLM which fields to extract from each report. The two presets ship with the app and work offline; point at your own JSON with Custom URL.
</p>
<div class="mt-4 space-y-3">
    ${schemaOptionRadio('bbd', CONFIG_PRESETS.bbd.label, CONFIG_PRESETS.bbd.description)}
    ${schemaOptionRadio('brca', CONFIG_PRESETS.brca.label, CONFIG_PRESETS.brca.description)}
    ${schemaOptionRadio('custom', 'Custom URL', 'Point at any config.json that follows the app schema convention.')}
</div>
<div id="custom-url-wrap" class="mt-3 hidden">
    <label for="custom-url" class="block text-xs font-medium text-gray-700">Configuration URL</label>
    <input type="url" id="custom-url" placeholder="https://example.com/config.json"
           class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600" />
</div>
<div id="schema-status" class="mt-3 text-sm hidden"></div>
`;

    // Preselect based on saved URL if any.
    let initialPreset = selectedPreset;
    if (!initialPreset && status.currentSchemaUrl) {
        for (const [key, preset] of Object.entries(CONFIG_PRESETS)) {
            if (preset.url === status.currentSchemaUrl) { initialPreset = key; break; }
        }
        if (!initialPreset) initialPreset = 'custom';
    }
    if (initialPreset) {
        const radio = body.querySelector(`input[name="schema-preset"][value="${initialPreset}"]`);
        if (radio) radio.checked = true;
        if (initialPreset === 'custom') {
            const wrap = body.querySelector('#custom-url-wrap');
            if (wrap) wrap.classList.remove('hidden');
            const input = body.querySelector('#custom-url');
            if (input && status.currentSchemaUrl) input.value = status.currentSchemaUrl;
        }
    }

    body.querySelectorAll('input[name="schema-preset"]').forEach((r) => {
        r.addEventListener('change', () => {
            const wrap = body.querySelector('#custom-url-wrap');
            wrap.classList.toggle('hidden', r.value !== 'custom');
        });
    });

    footer.innerHTML = `
<div></div>
<button id="wizard-next-1" type="button"
        class="rounded-md bg-green-800 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-green-700 disabled:opacity-50">
    Next
</button>`;
    document.getElementById('wizard-next-1').addEventListener('click', async () => {
        const chosen = body.querySelector('input[name="schema-preset"]:checked');
        if (!chosen) { showSchemaStatus('Pick a schema to continue.', false); return; }
        selectedPreset = chosen.value;
        let url;
        if (selectedPreset === 'custom') {
            url = body.querySelector('#custom-url').value.trim();
            if (!url) { showSchemaStatus('Enter a configuration URL.', false); return; }
        } else {
            url = CONFIG_PRESETS[selectedPreset].url;
        }
        showSchemaStatus('Loading and validating configuration…', null);
        const res = await deps.loadConfig(url);
        if (!res.ok) { showSchemaStatus(res.error || 'Failed to load configuration.', false); return; }
        showSchemaStatus('Configuration loaded.', true);
        await renderStep(2);
    });
}

function schemaOptionRadio(value, label, description) {
    return `
<label class="flex items-start gap-3 rounded-md border border-gray-300 p-3 cursor-pointer hover:border-green-500 has-[:checked]:border-green-600 has-[:checked]:bg-green-50">
    <input type="radio" name="schema-preset" value="${value}" class="mt-1 h-4 w-4 text-green-600 focus:ring-green-500 border-gray-300"/>
    <div>
        <div class="text-sm font-medium text-gray-900">${label}</div>
        <div class="text-xs text-gray-600 mt-0.5">${description}</div>
    </div>
</label>`;
}

function showSchemaStatus(msg, ok) {
    const el = document.getElementById('schema-status');
    if (!el) return;
    el.classList.remove('hidden');
    el.textContent = msg;
    el.className = 'mt-3 text-sm ' + (ok === true ? 'text-green-700' : ok === false ? 'text-red-700' : 'text-gray-600');
}

// ---------- Step 2: credentials ----------

function renderCredsStep(body, footer, status) {
    const initialProvider = status.provider || API_PROVIDERS.OPENAI;

    body.innerHTML = `
<h3 class="text-base font-semibold text-gray-900">Choose an LLM</h3>
<p class="text-sm text-gray-600 mt-1">
    Extraction runs against a large-language model. Pick a hosted API or an endpoint on your own network (both need a base URL, and a key if the endpoint wants one), or the in-browser option, which runs a small model on this device with no data leaving the machine.
</p>
<div class="mt-4 border-b border-gray-200">
    <nav class="-mb-px flex gap-4">
        <button type="button" data-provider="${API_PROVIDERS.OPENAI}"
                class="creds-tab whitespace-nowrap border-b-2 py-2 px-1 text-sm font-medium">OpenAI / Compatible</button>
        <button type="button" data-provider="${API_PROVIDERS.GEMINI}"
                class="creds-tab whitespace-nowrap border-b-2 py-2 px-1 text-sm font-medium">Google Gemini</button>
        <button type="button" data-provider="${API_PROVIDERS.WEBLLM}"
                class="creds-tab whitespace-nowrap border-b-2 py-2 px-1 text-sm font-medium">In-browser (WebLLM)</button>
    </nav>
</div>
<div id="creds-panel-${API_PROVIDERS.OPENAI}" class="creds-panel mt-4 space-y-3">
    <div>
        <label for="creds-openai-base" class="block text-xs font-medium text-gray-700">Base URL</label>
        <input type="url" id="creds-openai-base" placeholder="https://api.openai.com/v1"
               class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"/>
    </div>
    <div>
        <label for="creds-openai-key" class="block text-xs font-medium text-gray-700">
            API key <span class="font-normal text-gray-400">— leave blank for a server that needs none</span>
        </label>
        <input type="password" id="creds-openai-key" placeholder="sk-…"
               class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"/>
        <p class="mt-1 text-xs text-gray-500">
            Self-hosted servers (llama-server, vLLM, Ollama) usually authenticate nothing.
        </p>
    </div>
</div>
<div id="creds-panel-${API_PROVIDERS.GEMINI}" class="creds-panel mt-4 space-y-3 hidden">
    <div>
        <label for="creds-gemini-key" class="block text-xs font-medium text-gray-700">Gemini API key</label>
        <input type="password" id="creds-gemini-key" placeholder="AIza..."
               class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"/>
    </div>
</div>
<div id="creds-panel-${API_PROVIDERS.WEBLLM}" class="creds-panel mt-4 space-y-3 hidden">
    <div class="rounded-md border border-purple-200 bg-purple-50 p-3 text-xs text-purple-900 space-y-1">
        <p><strong>No API key needed.</strong> The model runs entirely in your browser via WebGPU.</p>
        <p>The first extraction downloads the model (~0.4-2.5 GB depending on the model). Later runs reuse the cached copy.</p>
        <p>Requires a WebGPU-capable browser (recent Chrome/Edge on desktop are safest).</p>
    </div>
    <div>
        <label for="creds-webllm-context" class="block text-xs font-medium text-gray-700">Context window (tokens)</label>
        <input type="number" id="creds-webllm-context" min="1024" max="131072" step="1024" placeholder="8192"
               class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"/>
        <p class="mt-1 text-xs text-gray-500">
            Total prompt tokens the model accepts. Default 8192. Extraction prompts run ~4-6k tokens for BBD; raise if your reports are longer or you're on multi-schema BrCa. Larger = more GPU memory.
        </p>
    </div>
</div>
<div id="creds-status" class="mt-3 text-sm hidden"></div>
`;

    // Prefill from saved creds.
    const openaiBase = body.querySelector('#creds-openai-base');
    const openaiKey = body.querySelector('#creds-openai-key');
    const geminiKey = body.querySelector('#creds-gemini-key');
    const webllmContext = body.querySelector('#creds-webllm-context');
    if (openaiBase) openaiBase.value = status.openaiBaseUrl || 'https://api.openai.com/v1';
    if (openaiKey) openaiKey.value = status.openaiApiKey || '';
    if (geminiKey) geminiKey.value = status.geminiApiKey || '';
    if (webllmContext) webllmContext.value = status.webllmContextWindowSize || 8192;

    // Tab styling helper.
    const applyTab = (provider) => {
        body.querySelectorAll('.creds-tab').forEach((t) => {
            const active = t.dataset.provider === provider;
            t.classList.toggle('border-green-600', active);
            t.classList.toggle('text-green-700', active);
            t.classList.toggle('border-transparent', !active);
            t.classList.toggle('text-gray-500', !active);
            t.classList.toggle('hover:text-gray-700', !active);
        });
        body.querySelectorAll('.creds-panel').forEach((p) => {
            p.classList.toggle('hidden', p.id !== `creds-panel-${provider}`);
        });
        body.dataset.selectedProvider = provider;
    };
    applyTab(initialProvider);
    body.querySelectorAll('.creds-tab').forEach((t) => {
        t.addEventListener('click', () => applyTab(t.dataset.provider));
    });

    footer.innerHTML = `
<button id="wizard-back-2" type="button"
        class="text-sm font-medium text-gray-600 hover:text-gray-800 px-3 py-1.5">Back</button>
<button id="wizard-next-2" type="button"
        class="rounded-md bg-green-800 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-green-700">
    Next
</button>`;
    document.getElementById('wizard-back-2').addEventListener('click', () => renderStep(1));
    document.getElementById('wizard-next-2').addEventListener('click', async () => {
        const provider = body.dataset.selectedProvider;
        let apiKey = '', baseUrl = '';
        const extras = {};
        if (provider === API_PROVIDERS.WEBLLM) {
            // Only extra we collect is the context window (default 8192).
            const raw = webllmContext?.value?.trim();
            const parsed = raw ? Number(raw) : 8192;
            if (!Number.isFinite(parsed) || parsed < 1024) {
                showCredsStatus('Context window must be a number ≥ 1024.', false);
                return;
            }
            extras.contextWindowSize = parsed;
        } else if (provider === API_PROVIDERS.GEMINI) {
            apiKey = geminiKey.value.trim();
            if (!apiKey) { showCredsStatus('Enter your Gemini API key.', false); return; }
        } else {
            baseUrl = openaiBase.value.trim();
            // Key deliberately optional: a self-hosted OpenAI-compatible
            // server (llama-server, vLLM, Ollama) authenticates nothing, and
            // demanding a throwaway value here served no purpose. Hosted APIs
            // still reject a missing key themselves, at validation.
            apiKey = openaiKey.value.trim();
            if (!baseUrl) { showCredsStatus('Enter a Base URL.', false); return; }
        }
        showCredsStatus(provider === API_PROVIDERS.WEBLLM ? 'Saving provider…' : 'Validating credentials…', null);
        const res = await deps.validateAndSaveCreds(provider, apiKey, baseUrl, extras);
        if (!res.ok) { showCredsStatus(res.error || 'Credentials rejected.', false); return; }
        showCredsStatus(provider === API_PROVIDERS.WEBLLM ? 'Provider selected.' : 'Credentials saved.', true);
        // Hand the freshly-listed models straight to the model step. It also
        // reads them from readSetupStatus, but passing them makes the step
        // independent of whether that call happens to re-list.
        await renderStep(3, res.modelIds);
    });
}

function showCredsStatus(msg, ok) {
    const el = document.getElementById('creds-status');
    if (!el) return;
    el.classList.remove('hidden');
    el.textContent = msg;
    el.className = 'mt-3 text-sm ' + (ok === true ? 'text-green-700' : ok === false ? 'text-red-700' : 'text-gray-600');
}

// ---------- Step 3: model ----------

async function renderModelStep(body, footer, status, freshModelIds) {
    body.innerHTML = `
<h3 class="text-base font-semibold text-gray-900">Choose a model</h3>
<p class="text-sm text-gray-600 mt-1">
    Pick which model handles extraction. The list comes from your provider.
</p>
<div class="mt-4">
    <label for="model-select" class="block text-xs font-medium text-gray-700">Model</label>
    <select id="model-select"
            class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600">
        <option value="" disabled selected>Loading…</option>
    </select>
</div>
<div id="model-status" class="mt-3 text-sm hidden"></div>
`;

    const select = body.querySelector('#model-select');
    const ids = (freshModelIds?.length ? freshModelIds : status.modelIds) || [];
    if (!ids.length) {
        showModelStatus('No models returned by the provider. Go back and check your credentials.', false);
    } else {
        select.innerHTML = '';
        for (const id of ids) {
            const opt = document.createElement('option');
            opt.value = id; opt.textContent = id;
            select.appendChild(opt);
        }
        if (status.model && ids.includes(status.model)) select.value = status.model;
    }

    footer.innerHTML = `
<button id="wizard-back-3" type="button"
        class="text-sm font-medium text-gray-600 hover:text-gray-800 px-3 py-1.5">Back</button>
<button id="wizard-finish" type="button"
        class="rounded-md bg-green-800 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-green-700">
    Finish
</button>`;
    document.getElementById('wizard-back-3').addEventListener('click', () => renderStep(2));
    document.getElementById('wizard-finish').addEventListener('click', async () => {
        const modelName = select.value;
        if (!modelName) { showModelStatus('Select a model to continue.', false); return; }
        await deps.saveModel(modelName);
        // Capture onComplete before closeWizard() nulls deps.
        const onComplete = deps.onComplete;
        closeWizard();
        if (typeof onComplete === 'function') onComplete();
    });
}

function showModelStatus(msg, ok) {
    const el = document.getElementById('model-status');
    if (!el) return;
    el.classList.remove('hidden');
    el.textContent = msg;
    el.className = 'mt-3 text-sm ' + (ok === true ? 'text-green-700' : ok === false ? 'text-red-700' : 'text-gray-600');
}
