/**
 * Build-time feature flags, set as Vite env vars at build time.
 *
 * Both default to OFF, so a normal `npm run build` produces the unchanged
 * online app. The Docker image (see Dockerfile) builds with both ON to
 * produce a fully self-contained, air-gapped OCR appliance.
 */

/**
 * Serve every model weight from this origin instead of the HuggingFace CDN.
 * Requires `npm run fetch-models` to have vendored them into public/models/.
 * Consumed by src/ocr/runtime/assets.ts.
 */
export const OFFLINE_MODELS = import.meta.env.VITE_OFFLINE_MODELS === 'true';

/**
 * OCR + review + export only: no LLM field extraction anywhere in the app.
 *
 * The setup wizard is skipped (it exists only to configure the LLM and its
 * schema), confirming a document's text is the terminal step, the Fields tab
 * is hidden, and Export emits the reviewed OCR text rather than extracted
 * fields. Used for air-gapped deployments where no LLM is reachable.
 */
export const OCR_ONLY = import.meta.env.VITE_OCR_ONLY === 'true';
