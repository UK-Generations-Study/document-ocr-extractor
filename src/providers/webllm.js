/**
 * In-browser LLM via WebLLM (MLC AI) - runs the model entirely on-device
 * through WebGPU. There's no API key: the abstractor picks a model, and the
 * first extraction pays the one-time weight download (cached in browser
 * storage / OPFS by WebLLM). No document bytes leave the machine.
 *
 * We curate a small list of models that fit comfortably in a laptop's memory.
 * Larger listed models still work if the user has the GPU RAM; smaller ones
 * are useful for phones and older machines. If you need a model outside this
 * list, the WebLLM prebuilt registry is available - swap it in and rebuild.
 */
import { CreateMLCEngine } from '@mlc-ai/web-llm';
import { BaseLLMProvider } from './base.js';
import { API_PROVIDERS, MAX_RETRIES } from '../core/constants.js';

/** Curated set of small-to-medium models suitable for structured extraction. */
const CURATED_MODELS = [
    { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', displayName: 'Llama 3.2 1B Instruct (~0.9 GB)' },
    { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', displayName: 'Llama 3.2 3B Instruct (~2.1 GB)' },
    { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', displayName: 'Qwen 2.5 0.5B Instruct (~0.4 GB)' },
    { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', displayName: 'Qwen 2.5 1.5B Instruct (~1.1 GB)' },
    { id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC', displayName: 'Qwen 2.5 3B Instruct (~2.0 GB)' },
    { id: 'Phi-3.5-mini-instruct-q4f16_1-MLC', displayName: 'Phi 3.5 mini Instruct (~2.4 GB)' },
    { id: 'SmolLM2-1.7B-Instruct-q4f16_1-MLC', displayName: 'SmolLM2 1.7B Instruct (~1.1 GB)' },
];

export class WebLLMProvider extends BaseLLMProvider {
    /**
     * @param {Object} config
     * @param {string} [config.model] - Optional; the engine can be created lazily
     *   when chatCompletion runs, using the model on the task.
     */
    constructor(config) {
        super(config);
        this.name = API_PROVIDERS.WEBLLM;
        this.model = config?.model || null;
        // Streamed to whoever registers via setLoadProgressCallback (used by
        // the extraction orchestrator so the right pane can show a bar).
        this._onLoadProgress = null;
    }

    /** No credentials to validate for a fully-local runtime. */
    async validateCredentials() {
        // We could probe navigator.gpu here but the model-download UX is a
        // better place to explain a missing WebGPU device.
        return true;
    }

    setLoadProgressCallback(fn) {
        this._onLoadProgress = fn;
    }

    /**
     * Create (or reuse) an engine loaded with the given model. Called both
     * from the setup path (to pre-warm) and from chatCompletion (to make the
     * task's model requirement authoritative).
     */
    async createClient() {
        // Placeholder - the actual engine load happens in ensureEngineFor()
        // because we may not know the model yet at createClient() time.
        return;
    }

    async ensureEngineFor(modelId) {
        if (this.client && this._loadedModel === modelId) return this.client;
        // Switching models = fresh engine. WebLLM's engine.reload() handles
        // this cleanly.
        const initProgressCallback = (report) => {
            // report = { progress: 0..1, text: 'Fetching param cache...', timeElapsed }
            this._onLoadProgress?.(report);
        };
        if (this.client && this._loadedModel !== modelId) {
            try { await this.client.reload(modelId); }
            catch (err) { /* fall through to a fresh CreateMLCEngine */ this.client = null; }
            if (this.client) {
                this._loadedModel = modelId;
                return this.client;
            }
        }
        this.client = await CreateMLCEngine(modelId, { initProgressCallback });
        this._loadedModel = modelId;
        return this.client;
    }

    /** Curated model list; task-worthy small-to-medium sizes only. */
    async listModels() {
        return CURATED_MODELS.map((m) => ({ id: m.id, displayName: m.displayName }));
    }

    getPreferredModels() {
        return ['Llama-3.2-1B-Instruct-q4f16_1-MLC', 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC'];
    }

    /**
     * Run one extraction request against the loaded engine. Retries on JSON
     * parse miss (matches the OpenAI provider). The engine's chat.completions
     * API is deliberately shaped like OpenAI's, so this is a near-drop-in.
     */
    async chatCompletion(task, checkTerminated = () => false) {
        const { report, schema, model, systemPrompt } = task;
        const engine = await this.ensureEngineFor(model);
        const systemPromptContent = this.buildSystemPrompt(systemPrompt, report.content);
        const userQuery = this.buildUserQuery(schema);

        let attempt = 0;
        while (attempt < MAX_RETRIES && !checkTerminated()) {
            try {
                const response = await engine.chat.completions.create({
                    messages: [
                        { role: 'system', content: systemPromptContent },
                        { role: 'user', content: userQuery },
                    ],
                });
                const message = response.choices?.[0]?.message?.content || '';
                const extracted = this.extractJsonFromResponse(message);
                if (extracted) return extracted;
                console.warn(`WebLLM attempt ${attempt + 1}: no valid JSON in response`);
            } catch (err) {
                // No auth path for WebLLM - just retry, then bubble up.
                console.warn(`WebLLM attempt ${attempt + 1} failed:`, err);
            }
            attempt++;
        }
        // Return empty object rather than throw so the extraction orchestrator
        // records "no fields found" for this schema and keeps moving.
        return {};
    }

    /** Free the resident model + KV cache. */
    async destroy() {
        try { await this.client?.unload?.(); } catch { /* ignore */ }
        this.client = null;
        this._loadedModel = null;
    }
}
