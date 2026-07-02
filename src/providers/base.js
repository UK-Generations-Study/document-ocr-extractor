/**
 * Abstract base class for LLM providers
 * All providers must extend this class and implement the required methods
 */

import { isAuthError, isRateLimitError, createAuthError } from '../core/errors.js';
import { JSON_EXTRACTION_REGEX } from '../core/constants.js';

export class BaseLLMProvider {
    /**
     * @param {Object} config - Provider configuration
     * @param {string} config.apiKey - The API key for authentication
     * @param {string} [config.baseUrl] - The base URL for the API (optional for some providers)
     */
    constructor(config) {
        if (this.constructor === BaseLLMProvider) {
            throw new Error('BaseLLMProvider is an abstract class and cannot be instantiated directly');
        }
        this.config = config;
        this.client = null;
        this.name = 'base';
    }

    /**
     * Get the provider name
     * @returns {string}
     */
    getProviderName() {
        return this.name;
    }

    /**
     * Validate the API credentials
     * @returns {Promise<boolean>} - True if credentials are valid
     */
    async validateCredentials() {
        throw new Error('validateCredentials() must be implemented by subclass');
    }

    /**
     * Create and initialize the API client
     * @returns {Promise<void>}
     */
    async createClient() {
        throw new Error('createClient() must be implemented by subclass');
    }

    /**
     * Get the API client
     * @returns {Object|null}
     */
    getClient() {
        return this.client;
    }

    /**
     * List available models
     * @returns {Promise<Array<{id: string, displayName: string}>>}
     */
    async listModels() {
        throw new Error('listModels() must be implemented by subclass');
    }

    /**
     * Execute a chat completion
     * @param {Object} task - The extraction task
     * @param {Object} task.report - The report object with content
     * @param {Object} task.schema - The JSON schema for extraction
     * @param {string} task.model - The model name to use
     * @param {string} task.systemPrompt - The system prompt
     * @returns {Promise<Object>} - The extracted JSON data
     */
    async chatCompletion(task) {
        throw new Error('chatCompletion() must be implemented by subclass');
    }

    /**
     * Build the system prompt
     * @param {string} systemPrompt - The system prompt text
     * @param {string} report - The report content
     * @returns {string}
     */
    buildSystemPrompt(systemPrompt, report) {
        return `<instructions>\n${systemPrompt}\n</instructions>\n\n<report>\n${report}\n</report>`;
    }

    /**
     * Build the user query from schema
     * @param {Object} schema - The JSON schema
     * @returns {string}
     */
    buildUserQuery(schema) {
        const keys = Object.keys(schema.properties || {});
        return `<query>\n<json_keys>\n[${keys.join(', ')}]\n</json_keys>\n<json_schema>\n\`\`\`json${JSON.stringify(schema, null, 2)}\`\`\`\n</json_schema>\n</query>`;
    }

    /**
     * Extract JSON from LLM response text
     * @param {string} responseText - The raw LLM response
     * @returns {Object|null} - The parsed JSON or null if extraction failed
     */
    extractJsonFromResponse(responseText) {
        if (!responseText) return null;

        const match = responseText.match(JSON_EXTRACTION_REGEX);
        if (match) {
            try {
                return JSON.parse(match[1]);
            } catch (err) {
                console.warn('Failed to parse JSON from LLM output:', err);
                return null;
            }
        }
        return null;
    }

    /**
     * Check if an error is an authentication error
     * @param {Error} error
     * @returns {boolean}
     */
    isAuthError(error) {
        return isAuthError(error);
    }

    /**
     * Check if an error is a rate limit error
     * @param {Error} error
     * @returns {boolean}
     */
    isRateLimitError(error) {
        return isRateLimitError(error);
    }

    /**
     * Create a standardized auth error
     * @returns {Error}
     */
    createAuthError() {
        return createAuthError();
    }

    /**
     * Destroy the client and clean up resources
     */
    destroy() {
        this.client = null;
    }
}
