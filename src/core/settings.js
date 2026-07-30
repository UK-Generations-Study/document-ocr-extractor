/**
 * User-tunable app settings, persisted as one record in the config store.
 *
 * reviewMode gates the human OCR check ("check text"):
 *   - 'manual'  every document parks at ocr-done for review (default);
 *   - 'flagged' only documents with low-confidence OCR lines park; clean
 *               ones flow straight into extraction;
 *   - 'auto'    OCR is always auto-confirmed; the pipeline runs end-to-end.
 * Extracted fields ALWAYS park at extraction-done for confirmation (singly
 * or via the sidebar's "Confirm all") - that is the one human gate that
 * never disappears.
 *
 * syncScroll is the default state of the page-image <-> OCR-text scroll link.
 *
 * lowConfThreshold is the calibrated-confidence bar under which an OCR line
 * counts as "needs a look" (see src/ocr/confidence.js for how it is applied).
 */
import { getConfigRecord, saveConfigRecord } from '../db.js';
import { emitAppEvent } from './bus.js';
import { DEFAULT_ENTITIES } from '../deid/presidio.js';

export const REVIEW_MODES = {
    MANUAL: 'manual',
    FLAGGED: 'flagged',
    AUTO: 'auto',
};

const DEFAULTS = {
    reviewMode: REVIEW_MODES.MANUAL,
    syncScroll: true,
    lowConfThreshold: 0.6,

    // De-identification (Presidio). ON by default: this app is meant to handle
    // identifiable clinical documents, so removing identifiers should be the
    // behaviour you get without having to know to ask for it.
    //
    // The cost of that default: de-identification fails closed, so if the
    // Presidio service is not reachable, documents stop at 'ocr-failed' with an
    // explanatory error rather than quietly passing through un-redacted. Turn
    // this off in Settings if you are running without Presidio.
    deidEnabled: true,
    /** Same-origin base path a reverse proxy forwards to the Presidio services. */
    deidBaseUrl: '/presidio',
    /** Entity types to detect; empty array means "everything the server supports". */
    deidEntities: DEFAULT_ENTITIES,
    /** Minimum analyzer confidence for a span to count as PII. */
    deidScoreThreshold: 0.5,
};

let cache = null;

export async function getSettings() {
    if (cache) return cache;
    const rec = await getConfigRecord('settings');
    const { id, ...saved } = rec || {};
    cache = { ...DEFAULTS, ...saved };
    return cache;
}

/** Synchronous accessor for hot paths (per-line confidence checks). Returns
 *  defaults until the first getSettings() resolves - app.js warms the cache
 *  at boot before any OCR result is rendered or counted. */
export function getCachedSettings() {
    return cache || DEFAULTS;
}

export async function saveSettings(patch) {
    const cur = await getSettings();
    cache = { ...cur, ...patch };
    await saveConfigRecord({ id: 'settings', ...cache });
    emitAppEvent({ source: 'settings', type: 'settings-changed', settings: cache });
    return cache;
}
