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

/**
 * Fallback context window when the user hasn't set one. WebLLM's own default
 * for most compiled binaries is 4096, which the BBD extraction prompt
 * (system instructions + OCR + schema JSON with x-enumDescriptions) overflows
 * regularly. 8192 covers a single-page report + BBD comfortably.
 */
export const DEFAULT_WEBLLM_CONTEXT = 8192;

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
        this.contextWindowSize = Number(config?.contextWindowSize) || DEFAULT_WEBLLM_CONTEXT;
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

    /** Streamed token counter: called with {inputTokens?, outputTokens} while a
     *  chatCompletion is in flight. `inputTokens` may be undefined until the
     *  final chunk arrives. */
    setTokenUsageCallback(fn) {
        this._onTokenUsage = fn;
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
        if (this.client && this._loadedModel === modelId && this._loadedContext === this.contextWindowSize) return this.client;
        const initProgressCallback = (report) => {
            this._onLoadProgress?.(report);
        };
        const chatOpts = { context_window_size: this.contextWindowSize };
        if (this.client && (this._loadedModel !== modelId || this._loadedContext !== this.contextWindowSize)) {
            try { await this.client.reload(modelId, chatOpts); }
            catch { this.client = null; }
            if (this.client) {
                this._loadedModel = modelId;
                this._loadedContext = this.contextWindowSize;
                return this.client;
            }
        }
        this.client = await CreateMLCEngine(modelId, { initProgressCallback }, chatOpts);
        this._loadedModel = modelId;
        this._loadedContext = this.contextWindowSize;
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

        // WebLLM supports grammar-constrained decoding via `response_format`.
        // With type=json_object + schema, xgrammar restricts every generated
        // token so the final output is guaranteed valid JSON matching the
        // target schema. This is the difference between the small Llama /
        // Qwen models "usually" emitting JSON and "always" doing so.
        //
        // Build a shape XGrammar accepts. It doesn't handle draft-2020-12's
        // full vocabulary (x-* annotations, x-enumDescriptions etc. are
        // ignored) but the type / enum / pattern / required constraints are
        // exactly what we want to enforce.
        const constrainedSchema = extractStructuralSchema(schema);
        const responseFormat = constrainedSchema
            ? { type: 'json_object', schema: JSON.stringify(constrainedSchema) }
            : { type: 'json_object' };

        let attempt = 0;
        while (attempt < MAX_RETRIES && !checkTerminated()) {
            try {
                // Stream so we can surface a growing output-token count while
                // the model decodes. include_usage=true asks WebLLM to send a
                // final usage chunk with the definitive prompt+completion
                // token totals.
                const stream = await engine.chat.completions.create({
                    messages: [
                        { role: 'system', content: systemPromptContent },
                        { role: 'user', content: userQuery },
                    ],
                    response_format: responseFormat,
                    stream: true,
                    stream_options: { include_usage: true },
                });
                let content = '';
                let outputTokens = 0;
                let inputTokens;
                for await (const chunk of stream) {
                    const delta = chunk.choices?.[0]?.delta?.content;
                    if (delta) {
                        content += delta;
                        outputTokens++; // one delta per token in WebLLM streams
                        this._onTokenUsage?.({ inputTokens, outputTokens });
                    }
                    if (chunk.usage) {
                        inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
                        outputTokens = chunk.usage.completion_tokens ?? outputTokens;
                        this._onTokenUsage?.({ inputTokens, outputTokens });
                    }
                }
                // With response_format=json_object, WebLLM produces bare JSON
                // (no ```json fences). Try that first; fall back to the
                // markdown-fenced extractor for any run where the model
                // slipped a wrapper around it.
                const extracted = parseLooseJson(content) || this.extractJsonFromResponse(content);
                if (extracted) return extracted;
                console.warn(`WebLLM attempt ${attempt + 1}: no valid JSON in response`);
            } catch (err) {
                // If xgrammar rejected the schema, drop the constraint and
                // retry with plain json_object mode - better than nothing.
                if (attempt === 0 && String(err?.message || err).match(/xgrammar|schema|grammar/i)) {
                    responseFormat.schema = undefined;
                    console.warn('WebLLM rejected schema-constrained mode; falling back to plain json_object');
                    continue;
                }
                console.warn(`WebLLM attempt ${attempt + 1} failed:`, err);
            }
            attempt++;
        }
        return {};
    }

    /** Free the resident model + KV cache. */
    async destroy() {
        try { await this.client?.unload?.(); } catch { /* ignore */ }
        this.client = null;
        this._loadedModel = null;
    }
}

/**
 * XGrammar's JSON-Schema support is a subset of draft-2020-12. Strip the
 * `x-*` annotations we lean on (x-enumDescriptions, x-unit, x-provenance,
 * x-primaryKey, x-version) and any other unfamiliar top-level keys so the
 * grammar builder sees only the structural constraints (type / enum / pattern
 * / required / properties / items). Returns null if the schema is unusable.
 */
function extractStructuralSchema(schema) {
    if (!schema || typeof schema !== 'object') return null;
    // Keywords whose values are themselves subschemas that need recursion.
    const SUBSCHEMA_KEYS = new Set(['items', 'additionalProperties', 'not']);
    // Keywords whose value is a MAP of name -> subschema. Their child keys
    // are user-defined field names, not schema keywords, so we recurse into
    // each value but keep every child key.
    const SUBSCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', 'definitions', '$defs']);
    // Keywords whose value is an ARRAY of subschemas.
    const SUBSCHEMA_ARRAY_KEYS = new Set(['anyOf', 'oneOf', 'allOf']);
    // Structural keywords xgrammar actually uses when building its GBNF.
    // Documentation-only keys (title, description, $id, $schema) are dropped
    // even though they're valid schema — leaving them in dramatically slows
    // xgrammar's grammar compile on schemas with long descriptions (BBD's
    // descriptions run 100-500 chars each; multiplied by 11 properties this
    // is enough to peg the CPU and hang the tab for minutes).
    const STRUCTURAL_KEYS = new Set([
        'type', 'enum', 'const', 'required', 'pattern', 'format',
        'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
        'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems',
        ...SUBSCHEMA_KEYS, ...SUBSCHEMA_MAP_KEYS, ...SUBSCHEMA_ARRAY_KEYS,
        '$ref', '$defs',
    ]);
    const strip = (node) => {
        if (Array.isArray(node)) return node.map(strip);
        if (!node || typeof node !== 'object') return node;
        const out = {};
        for (const [k, v] of Object.entries(node)) {
            if (k.startsWith('x-')) continue;
            if (!STRUCTURAL_KEYS.has(k)) continue;
            if (SUBSCHEMA_MAP_KEYS.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
                // Preserve field names; recurse into each subschema value.
                const mapOut = {};
                for (const [name, sub] of Object.entries(v)) mapOut[name] = strip(sub);
                out[k] = mapOut;
            } else if (SUBSCHEMA_ARRAY_KEYS.has(k) && Array.isArray(v)) {
                out[k] = v.map(strip);
            } else if (SUBSCHEMA_KEYS.has(k) && v && typeof v === 'object') {
                out[k] = strip(v);
            } else {
                out[k] = v;
            }
        }
        return out;
    };
    return strip(schema);
}

/**
 * Best-effort JSON parse of a raw LLM response. Small models sometimes emit
 * a leading "Here is the extracted data:" preface, or wrap the JSON in
 * back-tick fences without the `json` hint. Try the raw content first, then
 * carve out the first `{ ... }` block.
 */
function parseLooseJson(text) {
    if (!text) return null;
    const trimmed = text.trim();
    if (!trimmed) return null;
    try { return JSON.parse(trimmed); } catch { /* try again */ }
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first !== -1 && last > first) {
        try { return JSON.parse(trimmed.slice(first, last + 1)); } catch { /* give up */ }
    }
    return null;
}
