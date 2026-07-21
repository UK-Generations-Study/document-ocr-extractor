/**
 * Pre-build / pre-dev staging.
 *
 * Copies same-origin runtime assets used by src/ocr/ (the ported Quick Read
 * pipeline) into public/ so Vite serves them under the configured `base`:
 *
 *   node_modules/onnxruntime-web/dist/*.wasm  ->  public/ort/
 *   private-eye/public/models/ppocr/calibration.json  ->  public/models/ppocr/
 *   HF: PP-DocLayoutV3.onnx (patched) + inference.yml  ->  public/models/layout/doclayoutv3/
 *
 * Runs from `npm run predev` / `npm run prebuild` (see package.json).
 *
 * The layout graph is patched here (ceil_mode flip - see scripts/patch-layout.mjs)
 * so the resulting model runs under ORT-web's WebGPU EP. The heavy 130 MB
 * .onnx.data weight sidecar is NOT vendored - the app fetches it from the HF
 * CDN on the first OCR run (src/ocr/runtime/model-cache.ts).
 *
 * NOT staged yet:
 *   - wllama runtime (Deep Read / GLM-OCR). Deferred to Phase 4b.
 *
 * Idempotent: safe to run repeatedly. `--skip-models` skips the small HF fetch
 * for fast shell iteration when you don't need OCR loaded.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePatchedLayoutModel, ORIGINAL_NAME, PATCHED_NAME } from './patch-layout.mjs';
import { ensurePatchedWllama } from './patch-wllama.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const skipModels = process.argv.includes('--skip-models');

// Pinned to the same rev as src/ocr/runtime/assets.ts. Update in lockstep.
const LAYOUT_REPO = 'jeyabbalas/private-eye-models';
const LAYOUT_REV = 'f1ec7e4768b2418c5e8cd88e9aaac217a00f6f97';
const LAYOUT_HF_DIR = 'layout/doclayoutv3';

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
  // Small PP-OCR calibration map (~18 KB), vendored into assets/ (tracked)
  // when the OCR pipeline was fused in from private-eye. Copied here so
  // src/ocr/engines/ppocr/calibration.ts can fetch it same-origin.
  const src = join(ROOT, 'assets/ppocr/calibration.json');
  const dst = join(ROOT, 'public/models/ppocr/calibration.json');
  if (!existsSync(src)) {
    console.warn(
      '[prepare-build] assets/ppocr/calibration.json not found (skipping - Quick Read will use defaults)',
    );
    return;
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  console.log('[prepare-build] staged ppocr calibration.json -> public/models/ppocr/');
}

async function fetchToFile(url, dest) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    return buf.byteLength;
}

async function stageLayout() {
    // Obtain the small (~5 MB) original layout graph + inference.yml, apply the
    // ceil_mode patch, then vendor only the patched .onnx + yml into public/.
    // The ~130 MB .onnx.data weight sidecar stays remote and streams from HF at
    // runtime (per-user, cached) - it is never fetched here.
    //
    // Source of the graph: the copy vendored in assets/ (preferred - no network,
    // so CI can't be rate-limited by HuggingFace, which throttles shared runner
    // IPs with HTTP 429). Only if the vendored copy is absent do we fall back to
    // fetching from the pinned HF revision. The SHA check in patch-layout.mjs
    // guarantees the vendored graph is exactly that revision.
    const modelsDir = join(ROOT, 'models', LAYOUT_HF_DIR);
    const publicDir = join(ROOT, 'public/models', LAYOUT_HF_DIR);
    const patchedInPublic = join(publicDir, PATCHED_NAME);
    const ymlInPublic = join(publicDir, 'inference.yml');
    if (existsSync(patchedInPublic) && existsSync(ymlInPublic)) {
        console.log('[prepare-build] layout graph already staged -> public/models/layout/doclayoutv3/');
        return;
    }

    const originalPath = join(modelsDir, ORIGINAL_NAME);
    const ymlPath = join(modelsDir, 'inference.yml');
    const vendorDir = join(ROOT, 'assets', LAYOUT_HF_DIR);
    const vendoredOriginal = join(vendorDir, ORIGINAL_NAME);
    const vendoredYml = join(vendorDir, 'inference.yml');
    const haveVendored = existsSync(vendoredOriginal) && existsSync(vendoredYml);

    if (!existsSync(originalPath) || !existsSync(ymlPath)) {
        if (haveVendored) {
            mkdirSync(modelsDir, { recursive: true });
            if (!existsSync(originalPath)) copyFileSync(vendoredOriginal, originalPath);
            if (!existsSync(ymlPath)) copyFileSync(vendoredYml, ymlPath);
            console.log(`[prepare-build] using vendored layout graph (assets/${LAYOUT_HF_DIR}/) - no network fetch`);
        } else if (skipModels) {
            console.warn('[prepare-build] --skip-models: layout graph not staged; Quick Read will not run');
            return;
        } else {
            const base = `https://huggingface.co/${LAYOUT_REPO}/resolve/${LAYOUT_REV}/${LAYOUT_HF_DIR}`;
            if (!existsSync(originalPath)) {
                console.log(`[prepare-build] fetching ${ORIGINAL_NAME} from ${LAYOUT_REPO}@${LAYOUT_REV.slice(0, 7)}...`);
                const bytes = await fetchToFile(`${base}/${ORIGINAL_NAME}`, originalPath);
                console.log(`[prepare-build] fetched ${(bytes / 1024).toFixed(1)} KB -> models/${LAYOUT_HF_DIR}/${ORIGINAL_NAME}`);
            }
            if (!existsSync(ymlPath)) {
                const bytes = await fetchToFile(`${base}/inference.yml`, ymlPath);
                console.log(`[prepare-build] fetched ${(bytes / 1024).toFixed(1)} KB -> models/${LAYOUT_HF_DIR}/inference.yml`);
            }
        }
    }
    const patchedPath = ensurePatchedLayoutModel(modelsDir);
    mkdirSync(publicDir, { recursive: true });
    copyFileSync(patchedPath, patchedInPublic);
    copyFileSync(ymlPath, ymlInPublic);
    console.log(`[prepare-build] staged ${PATCHED_NAME} + inference.yml -> public/models/${LAYOUT_HF_DIR}/`);
}

function stageWllama() {
    const dst = join(ROOT, 'public/wllama-patched');
    const glue = join(dst, 'index.js');
    const wasm = join(dst, 'wllama.wasm');
    if (existsSync(glue) && existsSync(wasm)) {
        console.log('[prepare-build] wllama runtime already staged -> public/wllama-patched/');
        return;
    }
    if (skipModels) {
        console.warn('[prepare-build] --skip-models: wllama runtime not staged; Deep Read will not run');
        return;
    }
    try {
        const { wllamaNpm } = ensurePatchedWllama(ROOT);
        console.log(`[prepare-build] staged patched wllama runtime (@wllama/wllama@${wllamaNpm}) -> public/wllama-patched/`);
    } catch (err) {
        console.warn(`[prepare-build] wllama staging skipped: ${err.message}`);
    }
}

/**
 * Stage the two example schemas (BBD + BrCa) under public/schemas/ so the app
 * can offer offline-capable "bundled" presets in the setup wizard.
 *
 * The source-of-truth stays under examples/bcn_generations_pathology_data/; we
 * copy the tree verbatim, then REWRITE each config.json's systemPrompt /
 * schemaFiles / jsonldContextFiles from their absolute raw.githubusercontent
 * URLs to sibling-relative paths ('./schemas/foo.json' etc.). The app's config
 * loader resolves those relative to the config URL, so the same file works
 * whether it's fetched from public/schemas/ (dev/prod build) or from a
 * GitHub-hosted mirror.
 */
function stageSchemas() {
    const subjects = [
        {
            id: 'bbd',
            src: 'examples/bcn_generations_pathology_data/config/bbd',
            hasJsonld: false,
        },
        {
            id: 'brca',
            src: 'examples/bcn_generations_pathology_data/config/brca',
            hasJsonld: true,
        },
    ];
    for (const s of subjects) {
        const srcDir = join(ROOT, s.src);
        const dstDir = join(ROOT, 'public/schemas', s.id);
        if (!existsSync(srcDir)) {
            console.warn(`[prepare-build] ${s.src} not found; skipping ${s.id}`);
            continue;
        }
        rmSync(dstDir, { recursive: true, force: true });
        mkdirSync(join(dstDir, 'schemas'), { recursive: true });
        // Copy every schema file.
        for (const f of readdirSync(join(srcDir, 'schemas'))) {
            copyFileSync(join(srcDir, 'schemas', f), join(dstDir, 'schemas', f));
        }
        // JSON-LD contexts (BrCa only).
        if (s.hasJsonld && existsSync(join(srcDir, 'jsonldContexts'))) {
            mkdirSync(join(dstDir, 'jsonldContexts'), { recursive: true });
            for (const f of readdirSync(join(srcDir, 'jsonldContexts'))) {
                copyFileSync(join(srcDir, 'jsonldContexts', f), join(dstDir, 'jsonldContexts', f));
            }
        }
        // System prompt.
        copyFileSync(join(srcDir, 'systemPrompt.txt'), join(dstDir, 'systemPrompt.txt'));
        // Rewrite config.json to reference siblings by relative path.
        const cfgSrc = JSON.parse(readFileSync(join(srcDir, 'config.json'), 'utf8'));
        const rewrite = (url) => {
            // Absolute raw URLs → sibling path. Anything else already-relative.
            const m = url.match(/\/config\/(bbd|brca)\/(.*)$/);
            return m ? `./${m[2]}` : url;
        };
        const cfgOut = { ...cfgSrc };
        if (typeof cfgOut.systemPrompt === 'string') cfgOut.systemPrompt = rewrite(cfgOut.systemPrompt);
        if (Array.isArray(cfgOut.schemaFiles)) cfgOut.schemaFiles = cfgOut.schemaFiles.map(rewrite);
        else if (typeof cfgOut.schemaFiles === 'string') cfgOut.schemaFiles = rewrite(cfgOut.schemaFiles);
        if (Array.isArray(cfgOut.jsonldContextFiles)) cfgOut.jsonldContextFiles = cfgOut.jsonldContextFiles.map(rewrite);
        writeFileSync(join(dstDir, 'config.json'), JSON.stringify(cfgOut, null, 2) + '\n');
        console.log(`[prepare-build] staged ${s.id} schema tree -> public/schemas/${s.id}/`);
    }
}

stageOrt();
stagePpocrCalibration();
await stageLayout();
stageWllama();
stageSchemas();
