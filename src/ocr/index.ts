/**
 * Public facade for the ported private-eye OCR pipeline.
 *
 * This is the ONLY module the rest of the app should import from. Everything
 * under src/ocr/{adapters,core,engines,orchestrate,pipelines,runtime,structure,workers}
 * is implementation detail — subject to churn as we adapt the pipeline to
 * this app's UI needs (Phases 2-6). Keeping the surface narrow here means
 * downstream code doesn't lock in against private-eye's internal shapes.
 *
 * Phase 1 status: modules are ported and compile clean, but no OCR entry
 * point is wired up in the UI yet. Calling runQuickOcr() before Phase 4
 * completes the layout-model staging in scripts/prepare-build.mjs will fail
 * at model-load time.
 */

// PDF rasterisation - splits an uploaded PDF into per-page image blobs.
// Used by the ingest step in Phase 3.
export { getPdfPageCount, rasterizePdfPage, type RasterResult } from './orchestrate/pdf-raster.ts';

// Quick Read pipeline (PP-DocLayoutV3 -> PP-OCRv6 -> SLANet). Deterministic,
// runs off the main thread via ONNX Runtime Web. Entry points:
//   ensureE(onStatus, ep?)  - loads models (idempotent, ~275 MB first time)
//   runE(imageUrl, onStatus, ep?)  - OCRs one rasterised page
//   disposeE()              - frees GPU/WASM sessions
// Deep Read (GLM-OCR via wllama) is deliberately not exported here; it's
// wired in a later phase after Phase 4 confirms Quick Read works end-to-end.
export { ensureE, runE, disposeE, isELoaded, eEpNote, type AppEp } from './runtime/run-e.ts';

// Shared types the UI will need to render OCR results and confidence overlays.
export type { PageRun, InitStats } from './pipelines/types.ts';
export type { Block } from './structure/blocks.ts';
