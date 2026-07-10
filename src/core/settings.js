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
 */
import { getConfigRecord, saveConfigRecord } from '../db.js';
import { emitAppEvent } from './bus.js';

export const REVIEW_MODES = {
    MANUAL: 'manual',
    FLAGGED: 'flagged',
    AUTO: 'auto',
};

const DEFAULTS = {
    reviewMode: REVIEW_MODES.MANUAL,
    syncScroll: true,
};

let cache = null;

export async function getSettings() {
    if (cache) return cache;
    const rec = await getConfigRecord('settings');
    const { id, ...saved } = rec || {};
    cache = { ...DEFAULTS, ...saved };
    return cache;
}

export async function saveSettings(patch) {
    const cur = await getSettings();
    cache = { ...cur, ...patch };
    await saveConfigRecord({ id: 'settings', ...cache });
    emitAppEvent({ source: 'settings', type: 'settings-changed', settings: cache });
    return cache;
}
