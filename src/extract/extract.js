/**
 * Extraction orchestrator (Phase 5).
 *
 * When a document reaches status 'ocr-confirmed', we call the LLM once per
 * schema in the saved appConfig. The concatenated OCR markdown for the doc
 * plays the role of the "report" content in the old text-file pipeline.
 * Results are stored on the document record under `extractions[]` (one entry
 * per schemaId), and the document transitions:
 *   ocr-confirmed -> extraction-running -> extraction-done
 *
 * Event-driven: app.js routes every `status: 'ocr-confirmed'` bus event here;
 * `primeExtractionFromDb` runs once at boot for leftovers from a previous
 * session. There is no polling.
 *
 * Setup/infrastructure failures (bad credentials, missing config, no OCR
 * text) are terminal: the doc moves to 'extraction-failed' with doc.lastError
 * and stays there until the user retries. Rolling back to 'ocr-confirmed'
 * used to re-enqueue the doc in a loop, re-calling the API every pass.
 * Per-schema LLM errors are softer: they are recorded on the extraction entry
 * and the doc still reaches 'extraction-done' so the abstractor can review
 * whatever succeeded and re-run if needed.
 *
 * The abstractor always confirms extracted fields (singly or via the
 * sidebar's "Confirm all") - review modes never remove that gate.
 */
import { API_PROVIDERS } from '../core/constants.js';
import { emitAppEvent } from '../core/bus.js';
import { setDocumentStatus } from '../core/status.js';
import { createProvider } from '../providers/registry.js';
import { pageOutputText } from '../deid/deidentify.js';
import {
    allDocuments,
    getConfigRecord,
    getDocument,
    getOcrPagesByDoc,
    putDocument,
} from '../db.js';

const pending = [];
let processing = false;
let providerCache = null;      // { provider, providerId, apiKey, baseUrl }

function emit(event) {
    emitAppEvent({ source: 'extract', ...event });
}

/** Add a doc to the extraction queue if not already scheduled. */
export function enqueueExtraction(docId) {
    if (!docId) return;
    if (pending.includes(docId)) return;
    pending.push(docId);
    emit({ type: 'enqueued', docId });
    tick();
}

/** Scan documents at boot and enqueue anything sitting in ocr-confirmed. */
export async function primeExtractionFromDb() {
    const docs = await allDocuments();
    for (const d of docs) {
        if (d.status === 'ocr-confirmed') enqueueExtraction(d.id);
    }
}

async function tick() {
    if (processing) return;
    if (!pending.length) return;
    processing = true;
    try {
        while (pending.length) {
            const docId = pending.shift();
            await processDoc(docId);
        }
    } finally {
        processing = false;
    }
}

async function getProvider(docId) {
    const activeProvider = await getConfigRecord('activeProvider');
    const providerId = activeProvider?.provider || API_PROVIDERS.OPENAI;
    const creds = await getConfigRecord(`llmApiCreds_${providerId}`);
    // What counts as "configured" differs by provider. Gemini needs a key;
    // an OpenAI-compatible endpoint needs only a base URL, because a
    // self-hosted server (llama-server, vLLM, Ollama) authenticates nothing.
    // Requiring a key here rejected exactly those setups after the wizard had
    // already accepted them.
    const configured = providerId === API_PROVIDERS.WEBLLM
        || (providerId === API_PROVIDERS.OPENAI ? !!creds?.baseUrl : !!creds?.apiKey);
    if (!configured) {
        throw new Error('LLM credentials not configured (open Settings).');
    }
    const ctxWindow = providerId === API_PROVIDERS.WEBLLM
        ? (Number(creds?.contextWindowSize) || 8192)
        : null;

    // Reuse cached provider if configuration is unchanged.
    if (
        providerCache &&
        providerCache.providerId === providerId &&
        providerCache.apiKey === (creds?.apiKey || '') &&
        providerCache.baseUrl === (creds?.baseUrl || '') &&
        providerCache.contextWindowSize === ctxWindow
    ) {
        if (providerId === API_PROVIDERS.WEBLLM) {
            providerCache.provider.setLoadProgressCallback?.((report) => {
                emit({ type: 'load-progress', docId, progress: report.progress, text: report.text });
            });
            providerCache.provider.setTokenUsageCallback?.((usage) => {
                emit({ type: 'schema-tokens', docId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
            });
        }
        return providerCache.provider;
    }

    const provider = createProvider(providerId, {
        apiKey: creds?.apiKey || '',
        baseUrl: creds?.baseUrl || '',
        ...(providerId === API_PROVIDERS.WEBLLM ? { contextWindowSize: ctxWindow } : {}),
    });
    if (providerId === API_PROVIDERS.WEBLLM) {
        provider.setLoadProgressCallback((report) => {
            emit({ type: 'load-progress', docId, progress: report.progress, text: report.text });
        });
        provider.setTokenUsageCallback((usage) => {
            emit({ type: 'schema-tokens', docId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
        });
    }
    await provider.createClient();
    providerCache = {
        provider,
        providerId,
        apiKey: creds?.apiKey || '',
        baseUrl: creds?.baseUrl || '',
        contextWindowSize: ctxWindow,
    };
    return provider;
}

async function failDoc(docId, message) {
    emit({ type: 'doc-error', docId, error: new Error(message) });
    await setDocumentStatus(docId, 'extraction-failed', { lastError: message });
}

async function processDoc(docId) {
    const doc = await getDocument(docId);
    if (!doc) return;
    if (doc.status !== 'ocr-confirmed') return; // caught up or user rewound

    const appConfig = await getConfigRecord('appConfig');
    const modelRec = await getConfigRecord('model');
    if (!appConfig?.schemaFiles?.length || !appConfig?.systemPrompt || !modelRec?.name) {
        await failDoc(docId, 'Extraction setup incomplete - pick a schema and model in Settings.');
        return;
    }

    // Build the concatenated OCR text for this doc (page 1, page 2, ...).
    const ocrPages = await getOcrPagesByDoc(docId);
    // Match ocrPages to their doc order using the doc.pages[].blobKey sequence.
    const byKey = new Map(ocrPages.map((r) => [r.pageBlobKey, r]));
    // pageOutputText yields the de-identified copy when de-identification ran,
    // so PII never reaches the LLM provider.
    const orderedText = (doc.pages || [])
        .map((p, i) => {
            const md = pageOutputText(byKey.get(p.blobKey));
            return doc.pages.length > 1 ? `--- Page ${i + 1} ---\n${md}` : md;
        })
        .join('\n\n');
    if (!orderedText.trim()) {
        await failDoc(docId, 'No OCR text to extract from - re-run OCR first.');
        return;
    }

    await setDocumentStatus(docId, 'extraction-running');
    emit({ type: 'doc-start', docId });

    let provider;
    try {
        provider = await getProvider(docId);
    } catch (err) {
        await failDoc(docId, err?.message || String(err));
        return;
    }

    // Fresh extractions array so a re-run doesn't leak stale keys.
    doc.status = 'extraction-running';
    doc.extractions = [];
    doc.lastError = null;
    const schemas = appConfig.schemaFiles;
    for (let i = 0; i < schemas.length; i++) {
        const schema = schemas[i];
        emit({ type: 'schema-start', docId, schemaIndex: i, schemaCount: schemas.length, schemaTitle: schema.title || `schema ${i + 1}` });
        try {
            const result = await provider.chatCompletion({
                report: { content: orderedText },
                schema,
                model: modelRec.name,
                systemPrompt: appConfig.systemPrompt,
            });
            doc.extractions.push({
                schemaId: i,
                schemaTitle: schema.title || null,
                data: result || {},
            });
            // Persist progressively so the user sees partial results if we crash.
            await putDocument(doc);
            emit({ type: 'schema-done', docId, schemaIndex: i, keys: Object.keys(result || {}).length });
        } catch (err) {
            emit({ type: 'schema-error', docId, schemaIndex: i, error: err });
            doc.extractions.push({ schemaId: i, schemaTitle: schema.title || null, data: {}, error: err?.message || String(err) });
            await putDocument(doc);
        }
    }

    await setDocumentStatus(docId, 'extraction-done', { extractedAt: Date.now() });
    emit({ type: 'doc-done', docId });
}
