/**
 * Client for the Presidio analyzer + anonymizer HTTP services.
 *
 * Presidio runs as two Docker services (analyzer and anonymizer). Their Flask
 * apps send no CORS headers, so the browser cannot call them cross-origin:
 * every request here goes to a SAME-ORIGIN base path (default '/presidio')
 * that a reverse proxy forwards on - the Vite dev server in development, nginx
 * in the container image. That keeps the page cross-origin-isolated too, which
 * the OCR engines depend on.
 *
 * Routes, relative to the base:
 *   POST {base}/analyze            -> [{ entity_type, start, end, score }]
 *   POST {base}/anonymize          -> { text, items: [...] }
 *   GET  {base}/supportedentities  -> ["PERSON", "UK_NHS", ...]
 *   GET  {base}/health             -> "Presidio Analyzer service is up"
 *
 * The proxy is expected to route /analyze + /supportedentities + /health to
 * the analyzer and /anonymize to the anonymizer.
 */

/** Entity types worth detecting in UK pathology reports by default. The full
 *  list the server supports is offered in Settings via supportedEntities(),
 *  and every one of these can be switched off there.
 *
 *  PERSON / DATE_TIME / LOCATION come from the clinical NER model; UK_NHS and
 *  UK_POSTCODE come from deterministic pattern recognizers (see
 *  docker/presidio/recognizers.yaml). */
export const DEFAULT_ENTITIES = [
    'PERSON',
    'DATE_TIME',
    'LOCATION',
    'PHONE_NUMBER',
    'EMAIL_ADDRESS',
    'UK_NHS',
    'UK_POSTCODE',
    'MEDICAL_LICENSE',
];

/** What every detected entity is replaced with (fixed placeholder). */
export const REDACTION_PLACEHOLDER = '[REDACTED]';

class PresidioError extends Error {
    constructor(message, { status } = {}) {
        super(message);
        this.name = 'PresidioError';
        this.status = status;
    }
}

function joinUrl(base, path) {
    const b = String(base || '/presidio').replace(/\/+$/, '');
    return `${b}${path}`;
}

async function request(base, path, { method = 'GET', body, signal } = {}) {
    let res;
    try {
        res = await fetch(joinUrl(base, path), {
            method,
            signal,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
    } catch (err) {
        // Network-level failure: service down, proxy misconfigured, or (if the
        // base was pointed cross-origin) blocked by CORS.
        throw new PresidioError(
            `Could not reach the Presidio service at ${joinUrl(base, path)}: ${err.message}`,
        );
    }
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new PresidioError(
            `Presidio ${path} failed: HTTP ${res.status}${detail ? ` - ${detail.slice(0, 200)}` : ''}`,
            { status: res.status },
        );
    }
    return res;
}

/**
 * Find PII spans in one piece of text.
 * @returns {Promise<Array<{entity_type: string, start: number, end: number, score: number}>>}
 *   Character offsets are into the text as passed in.
 */
export async function analyze(text, { base, entities, scoreThreshold = 0.5, language = 'en', signal } = {}) {
    if (!text || !text.trim()) return [];
    const body = { text, language, score_threshold: scoreThreshold };
    // Omit `entities` entirely to let Presidio use every recognizer it has.
    if (entities && entities.length) body.entities = entities;
    const res = await request(base, '/analyze', { method: 'POST', body, signal });
    const json = await res.json();
    return Array.isArray(json) ? json : [];
}

/**
 * Replace the given spans in `text`. Uses the anonymizer's `replace` operator
 * with a fixed placeholder for every entity type.
 *
 * @returns {Promise<{text: string, items: Array<{start:number,end:number,entity_type:string,text:string,operator:string}>}>}
 *   `items` describe each substitution the service made (positions are into
 *   the RETURNED text), so callers can learn what each span became rather
 *   than assuming the placeholder.
 */
export async function anonymize(text, analyzerResults, { base, placeholder = REDACTION_PLACEHOLDER, signal } = {}) {
    if (!analyzerResults?.length) return { text, items: [] };
    const body = {
        text,
        // The anonymizer rejects unknown keys, so pass only what it defines.
        analyzer_results: analyzerResults.map((r) => ({
            entity_type: r.entity_type,
            start: r.start,
            end: r.end,
            score: r.score,
        })),
        anonymizers: { DEFAULT: { type: 'replace', new_value: placeholder } },
    };
    const res = await request(base, '/anonymize', { method: 'POST', body, signal });
    const json = await res.json();
    return {
        text: typeof json?.text === 'string' ? json.text : text,
        items: Array.isArray(json?.items) ? json.items : [],
    };
}

/** Entity types this analyzer build supports (for the Settings checkboxes). */
export async function supportedEntities({ base, language = 'en', signal } = {}) {
    const res = await request(base, `/supportedentities?language=${encodeURIComponent(language)}`, { signal });
    const json = await res.json();
    return Array.isArray(json) ? json.slice().sort() : [];
}

/**
 * Check both services are reachable through the proxy. Analyzer health is a
 * plain GET; the anonymizer is probed with a trivial anonymize call because
 * its /health is not exposed consistently across versions.
 */
export async function checkHealth({ base, signal } = {}) {
    await request(base, '/health', { signal });
    await anonymize('probe', [{ entity_type: 'PERSON', start: 0, end: 5, score: 1 }], { base, signal });
    return true;
}

export { PresidioError };
