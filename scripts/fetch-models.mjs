/**
 * Vendor every runtime model weight into public/models/ for offline use.
 *
 * The app normally streams these from the HuggingFace CDN on first use
 * (src/ocr/runtime/assets.ts). For an air-gapped deployment they must be
 * served same-origin instead, so this script downloads them into
 * public/models/<key>, where `vendored('models/' + key)` resolves them.
 * Pair it with a build that sets VITE_OFFLINE_MODELS=true.
 *
 * Run on a NETWORKED machine (the Dockerfile does this during image build):
 *   npm run fetch-models              # Quick Read only  (~270 MB)
 *   npm run fetch-models -- --deep    # + Deep Read VLM  (~1.64 GB total)
 *
 * Idempotent: a file whose size already matches the server's Content-Length
 * is skipped, so re-runs are cheap and interrupted runs resume cleanly.
 * HuggingFace rate-limits shared CI/runner IPs, so 429s and transient 5xx
 * are retried with exponential backoff.
 *
 * The KEYS BELOW MUST MATCH the MODEL_CDN map in src/ocr/runtime/assets.ts -
 * that map defines what the app requests at runtime. If you re-pin a model
 * there, update the revisions here in lockstep.
 */
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = join(ROOT, 'public/models');
const wantDeep = process.argv.includes('--deep');

// Pinned in lockstep with src/ocr/runtime/assets.ts.
const PE = { repo: 'jeyabbalas/private-eye-models', rev: 'f1ec7e4768b2418c5e8cd88e9aaac217a00f6f97' };
const GLM = { repo: 'ggml-org/GLM-OCR-GGUF', rev: '65a42de1148dbed2297e922b5dbc7d9b70c36578' };

const hf = (src, path) => `https://huggingface.co/${src.repo}/resolve/${src.rev}/${path}`;

/** key = path under public/models/ (and the key the app asks modelUrl() for). */
const QUICK_READ = {
  // Layout: the patched graph itself is vendored in assets/ at build time;
  // this is its external 130 MB weight sidecar.
  'layout/doclayoutv3/PP-DocLayoutV3.onnx.data': hf(PE, 'layout/doclayoutv3/PP-DocLayoutV3.onnx.data'),
  'ppocr/det-medium/inference.onnx': hf(PE, 'ppocr/det-medium/inference.onnx'),
  'ppocr/det-medium/inference.yml': hf(PE, 'ppocr/det-medium/inference.yml'),
  'ppocr/rec-medium/inference.onnx': hf(PE, 'ppocr/rec-medium/inference.onnx'),
  'ppocr/rec-medium/inference.yml': hf(PE, 'ppocr/rec-medium/inference.yml'),
  'slanet/inference.onnx': hf(PE, 'slanet/inference.onnx'),
  'slanet/inference.yml': hf(PE, 'slanet/inference.yml'),
};

/** Deep Read's GLM-OCR GGUF pair (~1.37 GB). Opt-in via --deep. */
const DEEP_READ = {
  'bakeoff/glm-ocr-q8/GLM-OCR-Q8_0.gguf': hf(GLM, 'GLM-OCR-Q8_0.gguf'),
  'bakeoff/glm-ocr-q8/mmproj-GLM-OCR-Q8_0.gguf': hf(GLM, 'mmproj-GLM-OCR-Q8_0.gguf'),
};

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET with retries. HF answers 429 to busy shared IPs; back off and retry. */
async function fetchWithRetry(url, attempts = 5) {
  let delay = 2000;
  for (let i = 1; i <= attempts; i++) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      if (i === attempts) throw err;
      console.warn(`  network error (${err.message}); retrying in ${delay / 1000}s...`);
      await sleep(delay);
      delay *= 2;
      continue;
    }
    if (res.ok) return res;
    // 429 = rate limited, 5xx = transient. Anything else is fatal.
    if (res.status !== 429 && res.status < 500) {
      throw new Error(`GET ${url}: HTTP ${res.status}`);
    }
    if (i === attempts) throw new Error(`GET ${url}: HTTP ${res.status} after ${attempts} attempts`);
    const retryAfter = Number(res.headers.get('retry-after')) * 1000;
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : delay;
    console.warn(`  HTTP ${res.status}; retrying in ${wait / 1000}s...`);
    await sleep(wait);
    delay *= 2;
  }
  throw new Error(`GET ${url}: exhausted retries`);
}

async function download(key, url) {
  const dest = join(OUT_ROOT, key);
  const res = await fetchWithRetry(url);
  const expected = Number(res.headers.get('content-length')) || 0;

  // Already vendored at the right size? Skip (and drain the body).
  if (existsSync(dest) && expected > 0 && statSync(dest).size === expected) {
    await res.body?.cancel?.();
    console.log(`  = ${key} (${mb(expected)}, already present)`);
    return;
  }

  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  // Stream to a .part file so an interrupted run never leaves a truncated
  // model in place that the size check would later accept.
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  const got = statSync(tmp).size;
  if (expected > 0 && got !== expected) {
    await rm(tmp, { force: true });
    throw new Error(`${key}: size mismatch (got ${got}, expected ${expected})`);
  }
  await rm(dest, { force: true });
  const { rename } = await import('node:fs/promises');
  await rename(tmp, dest);
  console.log(`  + ${key} (${mb(got)})`);
}

const targets = { ...QUICK_READ, ...(wantDeep ? DEEP_READ : {}) };
const entries = Object.entries(targets);

console.log(
  `[fetch-models] vendoring ${entries.length} files into public/models/` +
    (wantDeep ? ' (including Deep Read)' : ' (Quick Read only; pass --deep for the VLM)'),
);

let total = 0;
for (const [key, url] of entries) {
  await download(key, url);
  const dest = join(OUT_ROOT, key);
  if (existsSync(dest)) total += statSync(dest).size;
}
console.log(`[fetch-models] done - ${mb(total)} vendored under public/models/`);
