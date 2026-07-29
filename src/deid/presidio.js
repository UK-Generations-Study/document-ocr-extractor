/**
 * Client for the Presidio analyzer HTTP service.
 *
 * We use the ANALYZER only - it finds PII spans. The substitution itself is a
 * fixed `[REDACTED]` placeholder applied in the browser (see deidentify.js),
 * which is byte-identical to what the anonymizer's `replace` operator would
 * produce, but instant, offline, and unaffected by batch size. It also lets
 * the user's redaction edits and entity toggles take effect immediately.
 *
 * Presidio's Flask app sends no CORS headers, so the browser cannot call it
 * cross-origin: every request here goes to a SAME-ORIGIN base path (default
 * '/presidio') that a reverse proxy forwards on - the Vite dev server in
 * development, nginx in the container image. That keeps the page
 * cross-origin-isolated too, which the OCR engines depend on.
 *
 * Routes, relative to the base:
 *   POST {base}/analyze            -> [{ entity_type, start, end, score }]
 *   GET  {base}/supportedentities  -> ["PERSON", "UK_NHS", ...]
 *   GET  {base}/health             -> "Presidio Analyzer service is up"
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

/** What every redacted span is replaced with on export. */
export const REDACTION_PLACEHOLDER = '[REDACTED]';

/**
 * Score floor for spans we STORE. Analysis keeps every candidate at or above
 * this, so the user's entity selection and score threshold can be applied as a
 * cheap local filter later instead of forcing a re-analysis. Sits below the
 * settings slider's minimum so the slider never asks for spans we discarded.
 */
export const CANDIDATE_SCORE_FLOOR = 0.15;

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

/** Entity types this analyzer build supports (for the Settings checkboxes). */
export async function supportedEntities({ base, language = 'en', signal } = {}) {
    const res = await request(base, `/supportedentities?language=${encodeURIComponent(language)}`, { signal });
    const json = await res.json();
    return Array.isArray(json) ? json.slice().sort() : [];
}

/**
 * Check the analyzer is reachable AND actually working.
 *
 * /health only proves the web process is up: the NLP model is loaded lazily on
 * the first analyze call, so a broken model config still answers /health
 * happily. Running a real analysis is the only check that means anything -
 * and a probe with an obvious name should always come back with a hit.
 */
export async function checkHealth({ base, signal } = {}) {
    await request(base, '/health', { signal });
    const spans = await analyze('Patient John Smith attended on 12 Jul 2012.', {
        base,
        scoreThreshold: CANDIDATE_SCORE_FLOOR,
        signal,
    });
    if (!spans.length) {
        throw new PresidioError(
            'The analyzer responded but detected nothing in a test sentence - its NLP model may have failed to load.',
        );
    }
    return true;
}

export { PresidioError };
