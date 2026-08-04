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

// Provider display names and the provider-from-URL guess used to live here as
// exported helpers with no callers. Each duplicated a list that the UI already
// keeps for itself - the wizard's provider tabs, settingsPanel's providerLabel
// map - so they could drift out of step silently, and did. Whatever needs a
// label or a URL guess should own it, or take it from a single shared source;
// a second unused copy is worse than none.
