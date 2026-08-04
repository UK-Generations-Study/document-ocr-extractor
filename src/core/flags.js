/**
 * Build-time feature flags and the derived pipeline capabilities.
 *
 * OFFLINE_MODELS stays a build-time flag: whether the model weights are
 * vendored into the bundle is decided when the bundle is built, not by the
 * user. Which halves of the pipeline run is a RUNTIME choice - see
 * src/core/mode.js - so the capability booleans below derive from that.
 */
import { getPipelineMode, PIPELINE_MODES } from './mode.js';

/**
 * Serve every model weight from this origin instead of the HuggingFace CDN.
 * Requires `npm run fetch-models` to have vendored them into public/models/.
 * Consumed by src/ocr/runtime/assets.ts.
 */
export const OFFLINE_MODELS = import.meta.env.VITE_OFFLINE_MODELS === 'true';

// Null while the user has yet to choose and no build default applies. Both
// capabilities then read true, which is harmless: app.js shows the blocking
// first-run picker before mounting anything that consults them, and the choice
// reloads the page.
const mode = getPipelineMode();

/**
 * Reading half available: file/PDF ingest, the OCR engines, the text review
 * stage. False in Extract mode, where documents arrive as text via a handoff
 * and there is nothing to OCR.
 */
export const canRead = mode !== PIPELINE_MODES.EXTRACT;

/**
 * Extracting half available: the setup wizard, the LLM call, the Fields pane,
 * field export. False in Read mode, where confirming the text is the finish
 * line and there is no LLM to reach.
 *
 * Read this rather than negating canRead - the two are independent, and both
 * are true in Read + Extract.
 */
export const canExtract = mode !== PIPELINE_MODES.READ;

/**
 * Handoff import is offered wherever extraction can consume it. In Read mode
 * there is nothing to do with imported text, so the entry point is hidden.
 */
export const canImportHandoff = canExtract;
