/**
 * Medical Report Information Extractor - orchestrator (Phase 2 shape).
 *
 * Renders the three-panel shell (src/gui.js), decides on load whether to
 * open the setup wizard (missing schema / creds / model) or leave the shell
 * visible, and wires the gear icon to reopen the wizard. The wizard itself
 * (src/ui/wizard.js) is UI-only; every side effect (fetching a schema,
 * validating an API key, saving to IndexedDB) is a dep injected from here.
 *
 * The OCR pipeline (src/ocr/) is ported but not yet invoked - Phase 3 wires
 * ingest + the left/right/bottom panes, Phase 4 the OCR review, Phase 5 the
 * extraction call and edit form. This file will grow again as those land.
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
import { openWizard } from './src/ui/wizard.js';
import { mountReportList, refresh as refreshReportList } from './src/ui/reportList.js';
import { mountReportViewer } from './src/ui/reportViewer.js';
import { mountOcrView } from './src/ui/ocrView.js';
import { enqueueDocument, primeQueueFromDb, recoverStuckDocuments, subscribeQueue } from './src/ocr/queue.js';

import { API_PROVIDERS, DEFAULT_OPENAI_BASE_URL } from './src/core/constants.js';

import { OpenAI } from 'openai';
import { GoogleGenAI } from '@google/genai';

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

    let configJson;
    try {
        const resp = await fetch(configUrl);
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
    const schemaFileUrls = Array.isArray(schemaFiles) ? schemaFiles : [schemaFiles];
    const jsonldFileUrls = jsonldContextFiles
        ? (Array.isArray(jsonldContextFiles) ? jsonldContextFiles : [jsonldContextFiles])
        : [];

    let systemPromptText;
    try {
        const resp = await fetch(systemPrompt);
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
            configUrl,
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

async function validateAndSaveCreds(provider, apiKey, baseUrl) {
    let res;
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
    const modelRec = await getConfigRecord('model');

    let credsOk = false;
    let modelIds = [];
    if (provider === API_PROVIDERS.GEMINI && geminiCreds?.apiKey) {
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

function bindGearIcon() {
    const btn = document.getElementById('open-settings');
    if (!btn) return;
    btn.addEventListener('click', () => {
        openWizard({
            loadConfig: fetchAndValidateConfig,
            readSetupStatus,
            validateAndSaveCreds,
            saveModel,
            onComplete: () => {/* settings-mode: nothing to reveal, shell already visible */},
        });
    });
}

async function mountWorkspace() {
    await mountReportList({ selection });
    mountReportViewer({ selection });
    mountOcrView({ selection });

    // The queue drives status transitions on documents. Whenever anything
    // material happens (a new doc becomes queued, OCR finishes, edits arrive)
    // we refresh the bottom list so the badge stays honest.
    subscribeQueue((ev) => {
        if (ev.type === 'status' || ev.type === 'doc-done' || ev.type === 'doc-start') {
            refreshReportList();
        }
    });

    // Watch document ingestion so the OCR queue kicks in automatically.
    // Rather than plumb ingest events end-to-end, we poll on a short interval
    // - refreshReportList is cheap and we're only reading metadata. This will
    // move to a proper event bus in Phase 5 or later.
    setInterval(async () => {
        // primeQueueFromDb dedupes internally, so calling it repeatedly is safe.
        await primeQueueFromDb();
    }, 2000);
    // Boot recovery MUST run before the first prime pass so a doc left in
    // 'ocr-running' from a previous session gets rewound to 'queued' before
    // the queue looks at it.
    await recoverStuckDocuments();
    await primeQueueFromDb();
}

async function init() {
    ui('app');
    bindGearIcon();
    await mountWorkspace();

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
