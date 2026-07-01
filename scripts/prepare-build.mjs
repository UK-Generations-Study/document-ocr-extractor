/**
 * Pre-build / pre-dev staging.
 *
 * Copies same-origin runtime assets used by src/ocr/ (the ported Quick Read
 * pipeline) into public/ so Vite serves them under the configured `base`:
 *
 *   node_modules/onnxruntime-web/dist/*.wasm  ->  public/ort/
 *   private-eye/public/models/ppocr/calibration.json  ->  public/models/ppocr/
 *
 * Runs from `npm run predev` / `npm run prebuild` (see package.json).
 *
 * NOT staged in Phase 1:
 *   - Patched layout ONNX graph. Fetching + WebGPU-patching the 130 MB
 *     PP-DocLayoutV3 graph is deferred until Phase 4 (when OCR is wired up
 *     in the UI). Until then, calling into src/ocr/runtime/run-e.ts will
 *     fail at model-load time.
 *   - wllama runtime (Deep Read). Ported in a later phase.
 *
 * Idempotent: safe to run repeatedly. Warns and continues if a source is
 * missing (e.g., `npm install` hasn't run yet, or the private-eye reference
 * directory isn't on disk).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Only the two WASM builds ORT loads under our config (webgpu / wasm EPs with
// numThreads=1, no proxy/JSPI): the base SIMD+threads WASM (CPU fallback) and
// the JSEP build (WebGPU). The asyncify (~23 MB) and jspi (~14 MB) variants
// are never selected under these settings, so we don't stage them.
const ORT_ALLOWED = /^ort-wasm-simd-threaded(\.jsep)?\.(wasm|mjs)$/;

function stageOrt() {
  const src = join(ROOT, 'node_modules/onnxruntime-web/dist');
  const dst = join(ROOT, 'public/ort');
  if (!existsSync(src)) {
    console.warn(
      '[prepare-build] node_modules/onnxruntime-web/dist not found - run `npm install` first (skipping ORT stage)',
    );
    return;
  }
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  const files = readdirSync(src).filter((f) => ORT_ALLOWED.test(f));
  for (const f of files) copyFileSync(join(src, f), join(dst, f));
  console.log(`[prepare-build] staged ${files.length} onnxruntime-web files -> public/ort/`);
}

function stagePpocrCalibration() {
  // Small calibration.json (a few KB, checked into private-eye's public tree).
  // Copied here so src/ocr/engines/ppocr/calibration.ts can fetch it same-origin.
  const src = join(ROOT, 'private-eye/public/models/ppocr/calibration.json');
  const dst = join(ROOT, 'public/models/ppocr/calibration.json');
  if (!existsSync(src)) {
    console.warn(
      '[prepare-build] private-eye/public/models/ppocr/calibration.json not found (skipping - Quick Read will use defaults)',
    );
    return;
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  console.log('[prepare-build] staged ppocr calibration.json -> public/models/ppocr/');
}

stageOrt();
stagePpocrCalibration();
