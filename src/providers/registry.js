/**
 * Provider Registry
 * Factory and registry for LLM providers
 */

import { OpenAIProvider } from './openai.js';
import { GeminiProvider } from './gemini.js';
import { WebLLMProvider } from './webllm.js';
import { API_PROVIDERS } from '../core/constants.js';

// Re-export API_PROVIDERS for convenience
export { API_PROVIDERS };

// Map of provider IDs to their classes
const providerClasses = {
    [API_PROVIDERS.OPENAI]: OpenAIProvider,
    [API_PROVIDERS.GEMINI]: GeminiProvider,
    [API_PROVIDERS.WEBLLM]: WebLLMProvider
};

/**
 * Create a provider instance
 * @param {string} providerId - The provider ID (e.g., 'openai', 'gemini')
 * @param {Object} config - Provider configuration
 * @returns {BaseLLMProvider}
 */
export function createProvider(providerId, config) {
    const ProviderClass = providerClasses[providerId];
    if (!ProviderClass) {
        throw new Error(`Unknown provider: ${providerId}`);
    }
    return new ProviderClass(config);
}

/**
 * Get list of available providers
 * @returns {Array<{id: string, name: string, description: string}>}
 */
export function getAvailableProviders() {
    return [
        {
            id: API_PROVIDERS.OPENAI,
            name: 'OpenAI Compatible',
            description: 'OpenAI API and compatible endpoints (Azure OpenAI, vLLM, Ollama, etc.)'
        },
        {
            id: API_PROVIDERS.GEMINI,
            name: 'Google Gemini',
            description: 'Google Gemini API'
        },
        {
            id: API_PROVIDERS.WEBLLM,
            name: 'In-browser (WebLLM)',
            description: 'Small on-device LLM via WebGPU. No API key. Documents never leave your machine.'
        }
    ];
}

/**
 * Get provider display name
 * @param {string} providerId
 * @returns {string}
 */
export function getProviderDisplayName(providerId) {
    const providers = {
        [API_PROVIDERS.OPENAI]: 'OpenAI',
        [API_PROVIDERS.GEMINI]: 'Gemini',
        [API_PROVIDERS.WEBLLM]: 'WebLLM'
    };
    return providers[providerId] || providerId;
}

/**
 * Detect provider from base URL
 * @param {string} baseUrl - The base URL to analyze
 * @returns {string} - The detected provider ID
 */
export function detectProviderFromUrl(baseUrl) {
    if (!baseUrl) return API_PROVIDERS.GEMINI; // Empty base URL = Gemini

    const url = baseUrl.toLowerCase();
    if (url.includes('generativelanguage.googleapis.com') ||
        url.includes('gemini') ||
        url.includes('google')) {
        return API_PROVIDERS.GEMINI;
    }
    return API_PROVIDERS.OPENAI;
}

/**
 * Check if a provider ID is valid
 * @param {string} providerId
 * @returns {boolean}
 */
export function isValidProvider(providerId) {
    return Object.values(API_PROVIDERS).includes(providerId);
}
