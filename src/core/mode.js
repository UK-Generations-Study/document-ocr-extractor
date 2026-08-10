/**
 * Pipeline mode: which halves of the pipeline this installation runs.
 *
 * The tool has two halves - reading (OCR + de-identification) and extracting
 * (LLM field extraction) - and they can run on different machines. An
 * air-gapped host reads; a host that can reach an LLM extracts; one machine
 * with both does everything. The report-text file carries text between them (see
 * src/results/textExport.js).
 *
 * Called "pipeline mode" throughout, because Settings already calls the
 * how-much-stops-for-review choice a "review mode" (REVIEW_MODES) and two
 * unqualified "modes" in one settings panel would be indistinguishable.
 *
 * WHY localStorage AND settings. The authoritative copy lives in settings
 * (IndexedDB), like everything else the user chooses. But IndexedDB is async,
 * and this value is needed before it could possibly arrive: status.js rewrites
 * STATUS_META as an import side effect, and reportList.js computes EXPORTABLE
 * and FILTERS as module constants - all while modules are still loading, long
 * before any await could resolve. localStorage is synchronous and readable from
 * a module body, so it acts as a boot-time mirror. Writes go to both, always
 * through setPipelineMode.
 *
 * Because the value is captured at import time, CHANGING IT REQUIRES A RELOAD.
 * Settings does that deliberately rather than trying to re-render the eight
 * modules that already read it.
 */

/** @typedef {'read' | 'extract' | 'read-extract'} PipelineMode */

export const PIPELINE_MODES = {
    /** OCR + de-identify. No LLM. The air-gapped deployment. */
    READ: 'read',
    /** Import de-identified text and extract fields. No OCR engines. */
    EXTRACT: 'extract',
    /** Both halves on one machine. */
    READ_EXTRACT: 'read-extract',
};

const ALL = Object.values(PIPELINE_MODES);

/** localStorage key holding the boot-time mirror. */
const STORAGE_KEY = 'pipelineMode';

/**
 * Mode used when the user has never chosen one.
 *
 * VITE_DEFAULT_PIPELINE_MODE lets a build ship a default without forcing it:
 * the Docker image sets `read`, so an air-gapped host behaves exactly as it did
 * when the mode was a build-time flag, while the operator can still switch.
 * Unset (the ordinary build) means no default - the first-run picker asks.
 */
const BUILD_DEFAULT = import.meta.env.VITE_DEFAULT_PIPELINE_MODE;

export const MODE_COPY = {
    [PIPELINE_MODES.READ]: {
        title: 'Read',
        short: 'Read reports',
        desc: 'OCR and de-identify scanned reports, review the text, and export it. No LLM is used or needed.',
        forWhom: 'For an air-gapped or isolated machine.',
    },
    [PIPELINE_MODES.EXTRACT]: {
        title: 'Extract',
        short: 'Extract fields',
        desc: 'Import de-identified text produced elsewhere and extract structured fields from it with an LLM. No OCR.',
        forWhom: 'For a machine that can reach an LLM but holds no scans.',
    },
    [PIPELINE_MODES.READ_EXTRACT]: {
        title: 'Read + Extract',
        short: 'Read and extract',
        desc: 'The complete pipeline on one machine: OCR, de-identify, review, then extract fields with an LLM.',
        forWhom: 'For a single machine that does everything.',
    },
};

/** Whether `v` names a real mode. */
export function isPipelineMode(v) {
    return ALL.includes(v);
}

/**
 * The stored mode, or null if the user has never chosen and no build default
 * applies. Null is what makes the first-run picker appear.
 *
 * @returns {PipelineMode | null}
 */
export function getPipelineMode() {
    let stored = null;
    try {
        stored = localStorage.getItem(STORAGE_KEY);
    } catch {
        // Private-mode / storage-disabled browsers. Fall through to the build
        // default so the app still runs, just without remembering the choice.
    }
    if (isPipelineMode(stored)) return stored;
    if (isPipelineMode(BUILD_DEFAULT)) return BUILD_DEFAULT;
    return null;
}

/**
 * Record the chosen mode in the boot mirror.
 *
 * The caller also persists it to settings; this is the copy that survives to
 * the next boot early enough to matter. Takes effect on the next load - see the
 * note at the top of this file.
 */
export function setPipelineMode(mode) {
    if (!isPipelineMode(mode)) throw new Error(`Unknown pipeline mode: ${mode}`);
    try {
        localStorage.setItem(STORAGE_KEY, mode);
    } catch {
        // Nothing to do: the setting is still written to IndexedDB, the app
        // just falls back to the build default next boot.
    }
}
