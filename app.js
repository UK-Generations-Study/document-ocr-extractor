/**
 * Medical Report Information Extractor - orchestrator.
 *
 * Renders the shell (src/gui.js: sidebar + viewer + work surface), owns the
 * selected-report singleton, and wires the app event bus:
 *   - status routing: 'queued' -> OCR queue, 'ocr-confirmed' -> extraction
 *     queue (no polling; the queues are purely event-driven after the one
 *     boot-time prime pass);
 *   - work-pane routing: OCR view vs extraction view per selected doc status;
 *   - keyboard review shortcuts (J/K navigate, Enter confirm-and-advance).
 *
 * First run opens the setup wizard (missing schema / creds / model); the gear
 * icon opens the settings panel, which links back into individual wizard
 * steps. The wizard itself (src/ui/wizard.js) is UI-only; every side effect
 * (fetching a schema, validating an API key, saving to IndexedDB) is a dep
 * injected from here.
 */
import './src/styles.css';

import { ui } from './src/gui.js';
import { validateJsonSchema } from './src/jsonSchemaUtils.js';
import { validateJsonLd } from './src/jsonLdUtils.js';
import {
    saveConfigRecord,
    getConfigRecord,
    deleteConfigRecord,
} from './src/db.js';
import { onAppEvent } from './src/core/bus.js';
import { getSettings } from './src/core/settings.js';
import { canExtract, canRead } from './src/core/flags.js';
import { getPipelineMode } from './src/core/mode.js';
import { openModePicker } from './src/ui/modePicker.js';
import { EXTRACTION_PANE_STATUSES } from './src/core/status.js';
import { openWizard } from './src/ui/wizard.js';
import { openSettingsPanel } from './src/ui/settingsPanel.js';
import {
    mountReportList,
    refresh as refreshReportList,
    selectRelative,
    getSelectedDoc,
} from './src/ui/reportList.js';
import { mountReportViewer } from './src/ui/reportViewer.js';
import { initOcrView, releaseOcrPane, showOcrFor } from './src/ui/ocrView.js';
import { initExtractionView, releaseExtractionPane, showExtractionFor } from './src/ui/extractionView.js';
import { initTooltip } from './src/ui/tooltip.js';
import { initStatusStrip } from './src/ui/statusStrip.js';
import { initSyncScroll } from './src/ui/syncScroll.js';
import { initZoom } from './src/ui/zoom.js';
import { confirmOcr, confirmExtraction } from './src/ui/reviewFlow.js';
import { isModalOpen } from './src/ui/toast.js';
import { getDocument } from './src/db.js';
import { enqueueDocument, primeQueueFromDb, recoverStuckDocuments } from './src/ocr/queue.js';
import { enqueueExtraction, primeExtractionFromDb } from './src/extract/extract.js';

import { API_PROVIDERS, DEFAULT_OPENAI_BASE_URL } from './src/core/constants.js';

import { OpenAI } from 'openai';
import { GoogleGenAI } from '@google/genai';
import { WebLLMProvider } from './src/providers/webllm.js';

// =============================================================================
// LIGHTWEIGHT LLM CLIENT CACHE
// =============================================================================
// Client instances are cached only after successful validation. Phase 5 (LLM
// extraction call) will read these; Phase 2 only needs them so the wizard can
// list models after a key check.
let openaiClient = null;
let geminiClient = null;

// =============================================================================
// CONFIG LOADING
// =============================================================================

async function fetchAndValidateConfig(configUrl) {
    if (!configUrl) return { ok: false, error: 'No config URL provided.' };

    // Absolute-ise the outer URL so `new URL(rel, base)` below has an origin
    // to resolve against even when the caller passed a path like
    // '/medical-report-information-extractor/schemas/bbd/config.json'.
    const absConfigUrl = new URL(configUrl, window.location.href).href;

    let configJson;
    try {
        const resp = await fetch(absConfigUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        configJson = await resp.json();
    } catch (err) {
        return { ok: false, error: `Could not fetch config: ${err.message}` };
    }

    const { systemPrompt, schemaFiles, jsonldContextFiles } = configJson;
    if (typeof systemPrompt !== 'string' || !systemPrompt) {
        return { ok: false, error: 'config.json is missing a "systemPrompt" URL string.' };
    }
    if (schemaFiles === undefined) {
        return { ok: false, error: 'config.json is missing "schemaFiles".' };
    }

    // Resolve every inner URL against the config file's location so a config
    // written with sibling-relative paths ('./schemas/foo.json') works when
    // served from public/schemas/ AND when fetched raw from GitHub.
    const resolve = (rel) => new URL(rel, absConfigUrl).href;
    const systemPromptUrl = resolve(systemPrompt);
    const schemaFileUrls = (Array.isArray(schemaFiles) ? schemaFiles : [schemaFiles]).map(resolve);
    const jsonldFileUrls = (
        jsonldContextFiles
            ? (Array.isArray(jsonldContextFiles) ? jsonldContextFiles : [jsonldContextFiles])
            : []
    ).map(resolve);

    let systemPromptText;
    try {
        const resp = await fetch(systemPromptUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        systemPromptText = await resp.text();
    } catch (err) {
        return { ok: false, error: `Could not fetch systemPrompt: ${err.message}` };
    }

    const parsedSchemas = [];
    for (const url of schemaFileUrls) {
        try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const schemaJson = await resp.json();
            const { valid, error } = await validateJsonSchema(schemaJson);
            if (!valid) throw new Error(error);
            parsedSchemas.push(schemaJson);
        } catch (err) {
            return { ok: false, error: `Schema at ${url}: ${err.message}` };
        }
    }

    const parsedJsonLds = [];
    for (const url of jsonldFileUrls) {
        try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const jsonldDoc = await resp.json();
            const { valid, error } = await validateJsonLd(jsonldDoc);
            if (!valid) throw new Error(error);
            parsedJsonLds.push(jsonldDoc);
        } catch (err) {
            return { ok: false, error: `JSON-LD at ${url}: ${err.message}` };
        }
    }

    try {
        await saveConfigRecord({
            id: 'appConfig',
            configUrl: absConfigUrl,
            systemPrompt: systemPromptText,
            schemaFileUrls,
            schemaFiles: parsedSchemas,
            jsonldContextFiles: parsedJsonLds,
        });
    } catch (err) {
        return { ok: false, error: `Failed to save config: ${err.message}` };
    }

    return { ok: true };
}

// =============================================================================
// API CREDENTIAL VALIDATION
// =============================================================================

async function validateOpenAiKey(baseUrl, apiKey) {
    try {
        const c = new OpenAI({ baseURL: baseUrl, apiKey, dangerouslyAllowBrowser: true });
        const resp = await c.models.list();
        return { ok: true, client: c, modelIds: resp.data.map((m) => m.id).sort() };
    } catch (err) {
        return { ok: false, error: err?.message || 'OpenAI credential check failed.' };
    }
}

async function validateGeminiKey(apiKey) {
    try {
        const c = new GoogleGenAI({ apiKey });
        const pager = await c.models.list();
        const ids = [];
        for await (const model of pager) {
            const name = (model.name || '').replace('models/', '');
            if (name && !name.includes('embedding')) ids.push(name);
        }
        ids.sort();
        return { ok: true, client: c, modelIds: ids };
    } catch (err) {
        return { ok: false, error: err?.message || 'Gemini credential check failed.' };
    }
}

async function listWebllmModels() {
    // Cheap: no engine load, just the curated list.
    const p = new WebLLMProvider({});
    const list = await p.listModels();
    return list.map((m) => m.id);
}

async function validateAndSaveCreds(provider, apiKey, baseUrl, extras = {}) {
    let res;
    if (provider === API_PROVIDERS.WEBLLM) {
        const modelIds = await listWebllmModels();
        // Clear stale creds for the other providers so re-opening the wizard
        // prefills correctly.
        for (const other of [API_PROVIDERS.OPENAI, API_PROVIDERS.GEMINI]) {
            await deleteConfigRecord(`llmApiCreds_${other}`);
        }
        await saveConfigRecord({
            id: `llmApiCreds_${API_PROVIDERS.WEBLLM}`,
            provider: API_PROVIDERS.WEBLLM,
            // No key/URL. Kept for shape parity with other providers.
            apiKey: '',
            baseUrl: '',
            contextWindowSize: Number(extras.contextWindowSize) || 8192,
        });
        await saveConfigRecord({ id: 'activeProvider', provider: API_PROVIDERS.WEBLLM });
        openaiClient = null;
        geminiClient = null;
        return { ok: true, modelIds };
    }
    if (provider === API_PROVIDERS.GEMINI) {
        res = await validateGeminiKey(apiKey);
        if (res.ok) {
            geminiClient = res.client;
            openaiClient = null;
        }
    } else {
        res = await validateOpenAiKey(baseUrl, apiKey);
        if (res.ok) {
            openaiClient = res.client;
            geminiClient = null;
        }
    }
    if (!res.ok) return { ok: false, error: res.error };

    // Clean any stale creds for the *other* provider so we don't leak into
    // the wizard's "provider" prefill.
    const otherKey = provider === API_PROVIDERS.OPENAI
        ? `llmApiCreds_${API_PROVIDERS.GEMINI}`
        : `llmApiCreds_${API_PROVIDERS.OPENAI}`;
    await deleteConfigRecord(otherKey);

    await saveConfigRecord({
        id: `llmApiCreds_${provider}`,
        provider,
        baseUrl: provider === API_PROVIDERS.GEMINI ? '' : baseUrl,
        apiKey,
    });
    // Track the last-successful provider so future loads know which set to
    // pick up.
    await saveConfigRecord({ id: 'activeProvider', provider });

    return { ok: true, modelIds: res.modelIds };
}

async function saveModel(modelName) {
    await saveConfigRecord({ id: 'model', name: modelName });
}

// =============================================================================
// SETUP STATUS
// =============================================================================

async function readSetupStatus() {
    const appConfig = await getConfigRecord('appConfig');
    const activeProviderRec = await getConfigRecord('activeProvider');
    const provider = activeProviderRec?.provider || null;
    const openaiCreds = await getConfigRecord(`llmApiCreds_${API_PROVIDERS.OPENAI}`);
    const geminiCreds = await getConfigRecord(`llmApiCreds_${API_PROVIDERS.GEMINI}`);
    const webllmCreds = await getConfigRecord(`llmApiCreds_${API_PROVIDERS.WEBLLM}`);
    const modelRec = await getConfigRecord('model');

    let credsOk = false;
    let modelIds = [];
    if (provider === API_PROVIDERS.WEBLLM) {
        // No credential to validate; being the active provider = "creds ok".
        credsOk = true;
        modelIds = await listWebllmModels();
    } else if (provider === API_PROVIDERS.GEMINI && geminiCreds?.apiKey) {
        credsOk = !!geminiClient; // require an active client, else force revalidation
        if (!credsOk) {
            const v = await validateGeminiKey(geminiCreds.apiKey);
            if (v.ok) {
                geminiClient = v.client;
                modelIds = v.modelIds;
                credsOk = true;
            }
        }
    } else if (provider === API_PROVIDERS.OPENAI && openaiCreds?.apiKey) {
        credsOk = !!openaiClient;
        if (!credsOk) {
            const v = await validateOpenAiKey(openaiCreds.baseUrl, openaiCreds.apiKey);
            if (v.ok) {
                openaiClient = v.client;
                modelIds = v.modelIds;
                credsOk = true;
            }
        }
    }

    return {
        schemaOk: !!appConfig?.schemaFiles?.length,
        currentSchemaUrl: appConfig?.configUrl || null,
        credsOk,
        modelOk: !!modelRec?.name,
        provider,
        model: modelRec?.name || null,
        openaiBaseUrl: openaiCreds?.baseUrl || DEFAULT_OPENAI_BASE_URL,
        openaiApiKey: openaiCreds?.apiKey || '',
        geminiApiKey: geminiCreds?.apiKey || '',
        webllmContextWindowSize: webllmCreds?.contextWindowSize || 8192,
        modelIds,
    };
}

// =============================================================================
// SELECTED-REPORT STATE
// =============================================================================
// Which document is currently loaded into the left/right panes. Bottom-list
// clicks call setSelected(id); anyone else who cares (viewer, list, later
// phases) subscribes via `subscribe(fn)`. Kept on the module scope because
// it's a natural singleton for the whole app session.

const _selectionSubs = new Set();
let _selectedDocId = null;

const selection = {
    getSelected: () => _selectedDocId,
    setSelected: (id) => {
        if (id === _selectedDocId) return;
        _selectedDocId = id || null;
        for (const fn of _selectionSubs) {
            try { fn(_selectedDocId); } catch (err) { console.error(err); }
        }
    },
    subscribe: (fn) => {
        _selectionSubs.add(fn);
        return () => _selectionSubs.delete(fn);
    },
};

// =============================================================================
// SHELL + INIT
// =============================================================================

function openWizardAt(startStep) {
    openWizard({
        loadConfig: fetchAndValidateConfig,
        readSetupStatus,
        validateAndSaveCreds,
        saveModel,
        startStep,
        onComplete: () => {/* shell already visible; nothing to reveal */},
    });
}

function bindGearIcon() {
    const btn = document.getElementById('open-settings');
    if (!btn) return;
    btn.addEventListener('click', () => {
        openSettingsPanel({ readSetupStatus, openWizardAt });
    });
}

// Per-doc work-pane override: 'ocr' shows the (read-only) OCR text view even
// while the doc's status belongs to the extraction pane ("View text" /
// "View extracted fields" buttons). Cleared on any status change, where the
// status-based routing takes over again.
const paneOverrides = new Map();

async function routeWorkPane(docId) {
    if (!docId) {
        releaseOcrPane();
        releaseExtractionPane();
        await showOcrFor(null);
        return;
    }
    const doc = await getDocument(docId);
    if (!doc) return;
    // With no extraction view, the OCR pane owns every status.
    if (canExtract && EXTRACTION_PANE_STATUSES.has(doc.status) && paneOverrides.get(docId) !== 'ocr') {
        releaseOcrPane();
        await showExtractionFor(docId);
    } else {
        releaseExtractionPane();
        await showOcrFor(docId);
    }
}

// Coalesce bursts of queue events into one sidebar redraw per animation-ish tick.
let refreshTimer = null;
function scheduleListRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refreshReportList();
    }, 150);
}

function wireBus() {
    onAppEvent(async (ev) => {
        // Queue routing: every status transition lands here exactly once
        // (all writers go through setDocumentStatus / the queues).
        if (ev.type === 'status') {
            paneOverrides.delete(ev.docId); // status flow resumes pane control
            if (ev.status === 'queued') enqueueDocument(ev.docId);
            // In OCR-only builds 'ocr-confirmed' is terminal - never hand off
            // to the extraction queue (there is no LLM to call).
            else if (ev.status === 'ocr-confirmed' && canExtract) enqueueExtraction(ev.docId);
        }

        // "View text" / "View extracted fields" pane toggle.
        if (ev.type === 'set-pane') {
            if (ev.pane === 'ocr') paneOverrides.set(ev.docId, 'ocr');
            else paneOverrides.delete(ev.docId);
            if (selection.getSelected() === ev.docId) await routeWorkPane(ev.docId);
            return;
        }

        // Sidebar + work-pane refresh.
        const refreshTypes = ev.type === 'status' || ev.type === 'doc-done' || ev.type === 'doc-start'
            || ev.type === 'schema-done' || ev.type === 'enqueued' || ev.type === 'flags-recomputed';
        if (refreshTypes) {
            scheduleListRefresh();
            const sel = selection.getSelected();
            if (ev.type === 'status' && sel && sel === ev.docId) await routeWorkPane(sel);
            // Threshold changed: redraw the selected doc so overlays,
            // highlights, and badges reflect the new bar.
            if (ev.type === 'flags-recomputed' && sel) await routeWorkPane(sel);
        }
    });
}

/**
 * Review keyboard shortcuts: K selects the next visible sidebar row, J the
 * previous; Enter confirms the selected doc's current review stage and
 * advances. Inactive while typing in a field or while a modal/wizard is open.
 */
function bindKeyboard() {
    const isTyping = () => {
        const ae = document.activeElement;
        return !!(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable));
    };
    document.addEventListener('keydown', async (e) => {
        if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
        if (isTyping() || isModalOpen()) return;
        if (e.key === 'k' || e.key === 'K') {
            e.preventDefault();
            selectRelative(1);
        } else if (e.key === 'j' || e.key === 'J') {
            e.preventDefault();
            selectRelative(-1);
        } else if (e.key === 'Enter') {
            const doc = getSelectedDoc();
            if (!doc) return;
            if (doc.status === 'ocr-done') {
                e.preventDefault();
                await confirmOcr(doc.id);
            } else if (doc.status === 'extraction-done') {
                e.preventDefault();
                await confirmExtraction(doc.id);
            }
        }
    });
}

async function mountWorkspace() {
    // Warm the settings cache before anything renders or counts OCR
    // confidence - confidence.js reads it synchronously.
    await getSettings();
    // Before the viewer mounts: it paints page cards at the current zoom, and
    // reading the stored level afterwards would leave the first document at
    // 100% until something happened to re-render it.
    await initZoom();
    await mountReportList({ selection });
    mountReportViewer({ selection });
    initOcrView();
    initExtractionView();
    initStatusStrip();
    await initSyncScroll();

    // Router: pick the right work-pane view whenever the selected doc changes.
    selection.subscribe((id) => { void routeWorkPane(id); });
    wireBus();
    bindKeyboard();

    // One boot-time pass: recover *-running docs stranded by a closed session,
    // then enqueue whatever is actionable. After this, routing is event-driven.
    await recoverStuckDocuments();
    // Each queue is primed only where its half of the pipeline runs. Without
    // the guards a mode switch would restart work the new mode cannot finish -
    // documents left mid-OCR would be re-queued on a machine with no OCR stage.
    if (canRead) await primeQueueFromDb();
    if (canExtract) await primeExtractionFromDb();

    // Do the initial route once everything is wired.
    await routeWorkPane(selection.getSelected());
}

async function init() {
    // Pipeline mode first, before anything mounts: every module below reads it
    // while loading, so there is no coherent state to render without it. Only
    // reached on a first run where the build ships no default; the picker
    // resolves by reloading, so nothing after this line runs.
    if (getPipelineMode() === null) {
        await openModePicker();
        return;
    }

    ui('app');
    initTooltip();
    bindGearIcon();
    await mountWorkspace();

    // The wizard exists solely to configure the extraction LLM and its schema,
    // so modes without extraction skip it - there is nothing to set up, and its
    // blocking overlay would make the app unusable with no reachable LLM.
    if (!canExtract) return;

    const status = await readSetupStatus();
    const setupComplete = status.schemaOk && status.credsOk && status.modelOk;
    if (!setupComplete) {
        openWizard({
            loadConfig: fetchAndValidateConfig,
            readSetupStatus,
            validateAndSaveCreds,
            saveModel,
            onComplete: () => {/* first-run: nothing to reveal, shell was rendered underneath */},
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    init();
});
