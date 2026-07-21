import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

/**
 * Cross-origin isolation (COOP/COEP) is required so wllama and multi-threaded
 * ORT can use SharedArrayBuffer. Vite serves these headers in dev/preview;
 * production (static host) relies on the coi-serviceworker shim in public/,
 * registered from index.html.
 *
 * COEP must be `credentialless`, not `require-corp`: model weights are fetched
 * cross-origin from the HuggingFace CDN, whose responses do NOT carry
 * `Cross-Origin-Resource-Policy`. Under `require-corp` those fetches would be
 * blocked once isolation activates. `credentialless` keeps isolation (and the
 * SharedArrayBuffer threads) while allowing no-credentials cross-origin
 * subresource fetches — exactly what public model weights need.
 */
const coiHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  plugins: [tailwindcss()],
  base: '/document-ocr-extractor/',
  build: {
    target: 'es2022',
  },
  worker: {
    format: 'es',
  },
  // ONNX Runtime Web ships its own WASM/worker assets and breaks Vite's dep
  // pre-bundling; we load them via same-origin URLs (staged into public/ by
  // scripts/prepare-build.mjs), so exclude from optimizeDeps.
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
  server: { headers: coiHeaders },
  preview: { headers: coiHeaders },
});
