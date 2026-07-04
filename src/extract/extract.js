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
 * The abstractor still has to hit "Confirm" in the extraction form to move on
 * to 'confirmed'; that's the point of the review step. If the LLM is edited
 * after 'confirmed' (in the form), we keep the status at 'confirmed' - only
 * an explicit Reopen rewinds.
 *
 * Uses the existing provider abstraction (src/providers/*) so no LLM code is
 * duplicated here.
 */
import { API_PROVIDERS } from '../core/constants.js';
import { createProvider } from '../providers/registry.js';
import {
    allDocuments,
    getConfigRecord,
    getDocument,
    getOcrPagesByDoc,
    putDocument,
} from '../db.js';

const listeners = new Set();
const pending = [];
let processing = false;
let providerCache = null;      // { provider, providerId, apiKey, baseUrl }

function emit(event) {
    for (const fn of listeners) {
        try { fn(event); } catch (err) { console.error('[extract] listener error', err); }
    }
}

export function subscribeExtract(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Add a doc to the extraction queue if not already scheduled. */
export function enqueueExtraction(docId) {
    if (!docId) return;
    if (pending.includes(docId)) return;
    pending.push(docId);
    emit({ type: 'enqueued', docId });
    tick();
}

/** Scan documents on boot and re-enqueue anything sitting in ocr-confirmed. */
export async function primeExtractionFromDb() {
    const docs = await allDocuments();
    for (const d of docs) {
        if (d.status === 'ocr-confirmed') enqueueExtraction(d.id);
    }
}

/** Recover a doc left in extraction-running by an interrupted session. */
export async function recoverStuckExtraction() {
    const docs = await allDocuments();
    for (const d of docs) {
        if (d.status === 'extraction-running') {
            d.status = 'ocr-confirmed';
            await putDocument(d);
            emit({ type: 'status', docId: d.id, status: d.status });
        }
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
    if (providerId !== API_PROVIDERS.WEBLLM && !creds?.apiKey) {
        throw new Error('LLM credentials not configured (run the setup wizard).');
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

async function processDoc(docId) {
    const doc = await getDocument(docId);
    if (!doc) return;
    if (doc.status !== 'ocr-confirmed') return; // caught up or user rewound

    const appConfig = await getConfigRecord('appConfig');
    const modelRec = await getConfigRecord('model');
    if (!appConfig?.schemaFiles?.length || !appConfig?.systemPrompt || !modelRec?.name) {
        emit({ type: 'doc-error', docId, error: new Error('extraction setup incomplete') });
        return;
    }

    // Build the concatenated OCR text for this doc (page 1, page 2, ...).
    const ocrPages = await getOcrPagesByDoc(docId);
    // Match ocrPages to their doc order using the doc.pages[].blobKey sequence.
    const byKey = new Map(ocrPages.map((r) => [r.pageBlobKey, r]));
    const orderedText = (doc.pages || [])
        .map((p, i) => {
            const md = byKey.get(p.blobKey)?.markdown || '';
            return doc.pages.length > 1 ? `--- Page ${i + 1} ---\n${md}` : md;
        })
        .join('\n\n');
    if (!orderedText.trim()) {
        emit({ type: 'doc-error', docId, error: new Error('no OCR text for extraction') });
        return;
    }

    doc.status = 'extraction-running';
    await putDocument(doc);
    emit({ type: 'doc-start', docId });
    emit({ type: 'status', docId, status: 'extraction-running' });

    let provider;
    try {
        provider = await getProvider(docId);
    } catch (err) {
        emit({ type: 'doc-error', docId, error: err });
        // Roll status back so the user can fix config and try again.
        doc.status = 'ocr-confirmed';
        await putDocument(doc);
        emit({ type: 'status', docId, status: 'ocr-confirmed' });
        return;
    }

    // Fresh extractions array so a re-run doesn't leak stale keys.
    doc.extractions = [];
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

    doc.status = 'extraction-done';
    doc.extractedAt = Date.now();
    await putDocument(doc);
    emit({ type: 'doc-done', docId });
    emit({ type: 'status', docId, status: 'extraction-done' });
}
