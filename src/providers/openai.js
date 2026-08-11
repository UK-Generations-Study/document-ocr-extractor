/**
 * OpenAI Provider implementation
 * Supports OpenAI API and compatible APIs (Azure OpenAI, vLLM, Ollama, etc.)
 */

import { OpenAI } from 'openai';
import { BaseLLMProvider } from './base.js';
import { MAX_RETRIES, API_PROVIDERS, NO_KEY } from '../core/constants.js';

export class OpenAIProvider extends BaseLLMProvider {
    /**
     * @param {Object} config
     * @param {string} config.apiKey - The OpenAI API key
     * @param {string} config.baseUrl - The base URL (e.g., https://api.openai.com/v1)
     */
    constructor(config) {
        super(config);
        this.name = API_PROVIDERS.OPENAI;
        this.baseUrl = config.baseUrl;
        // A self-hosted OpenAI-compatible server (llama-server, vLLM, Ollama)
        // usually wants no key at all, but the SDK refuses to construct without
        // one. Send a placeholder: those servers ignore the Authorization
        // header, and a real API would have rejected an empty key anyway.
        this.apiKey = config.apiKey || NO_KEY;
    }

    /**
     * Validate the OpenAI API credentials
     * @returns {Promise<boolean>}
     */
    async validateCredentials() {
        try {
            const testClient = new OpenAI({
                baseURL: this.baseUrl,
                apiKey: this.apiKey,
                dangerouslyAllowBrowser: true
            });
            await testClient.models.list();
            return true;
        } catch (error) {
            if (error.response && error.response.status === 401) {
                console.error('Invalid API key:', error);
                return false;
            } else {
                console.error('Error checking API key:', error);
                return false;
            }
        }
    }

    /**
     * Create the OpenAI client
     * @returns {Promise<void>}
     */
    async createClient() {
        this.client = new OpenAI({
            baseURL: this.baseUrl,
            apiKey: this.apiKey,
            dangerouslyAllowBrowser: true
        });
    }

    /**
     * List available models
     * @returns {Promise<Array<{id: string, displayName: string}>>}
     */
    async listModels() {
        if (!this.client) {
            throw new Error('Client not initialized. Call createClient() first.');
        }

        try {
            const resp = await this.client.models.list();
            const models = resp.data.map(m => ({
                id: m.id,
                displayName: m.id
            })).sort((a, b) => a.id.localeCompare(b.id));

            return models;
        } catch (error) {
            console.error('Error listing OpenAI models:', error);
            throw error;
        }
    }

    /**
     * Get preferred models for default selection
     * @returns {string[]}
     */
    getPreferredModels() {
        return ['gpt-5-nano', 'gpt-5-mini', 'gpt-5'];
    }

    /**
     * Execute extraction using OpenAI chat completion
     * @param {Object} task - The extraction task
     * @param {boolean} [checkTerminated] - Function to check if extraction was terminated
     * @returns {Promise<Object>}
     */
    async chatCompletion(task, checkTerminated = () => false) {
        if (!this.client) {
            throw new Error('Client not initialized. Call createClient() first.');
        }

        const { report, schema, model, systemPrompt } = task;

        const systemPromptContent = this.buildSystemPrompt(systemPrompt, report.content);
        const userQuery = this.buildUserQuery(schema);

        let attempt = 0;

        while (attempt < MAX_RETRIES && !checkTerminated()) {
            try {
                const response = await this.client.chat.completions.create({
                    model: model,
                    messages: [
                        { role: 'system', content: systemPromptContent },
                        { role: 'user', content: userQuery }
                    ]
                });

                const message = response.choices?.[0]?.message?.content || '';
                const extracted = this.extractJsonFromResponse(message);

                if (extracted) {
                    return extracted;
                }

                console.warn(`Attempt ${attempt + 1}: No valid JSON found in response`);
            } catch (err) {
                // If the error is 401 or 403, handle auth
                if (err.response && (err.response.status === 401 || err.response.status === 403)) {
                    throw this.createAuthError();
                }
                // Otherwise, throw so concurrency manager can handle backoff
                throw err;
            }
            attempt++;
        }

        // Fallback if no valid JSON
        return {};
    }

    /**
     * Check if an error is an auth error (OpenAI-specific)
     * @param {Error} error
     * @returns {boolean}
     */
    isAuthError(error) {
        if (error.isAuthError) return true;
        if (error.response?.status === 401 || error.response?.status === 403) return true;
        return false;
    }
}
