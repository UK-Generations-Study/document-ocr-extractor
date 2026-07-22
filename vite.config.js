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

/**
 * De-identification (Presidio) reverse proxy.
 *
 * The Presidio containers serve no CORS headers, so the browser cannot call
 * them cross-origin. Everything goes through the same-origin '/presidio' path
 * instead, which we forward here in dev/preview (nginx does the same job in
 * the Docker image). /anonymize goes to the anonymizer service, everything
 * else (/analyze, /supportedentities, /health) to the analyzer.
 *
 * Point these at your services with PRESIDIO_ANALYZER_URL /
 * PRESIDIO_ANONYMIZER_URL if they aren't on the default ports.
 */
const analyzerTarget = process.env.PRESIDIO_ANALYZER_URL || 'http://localhost:5002';
const anonymizerTarget = process.env.PRESIDIO_ANONYMIZER_URL || 'http://localhost:5001';
const stripPresidio = (p) => p.replace(/^\/presidio/, '');
// Key order matters: Vite matches by prefix, so the more specific
// '/presidio/anonymize' must be declared before the '/presidio' catch-all.
const presidioProxy = {
  '/presidio/anonymize': { target: anonymizerTarget, changeOrigin: true, rewrite: stripPresidio },
  '/presidio': { target: analyzerTarget, changeOrigin: true, rewrite: stripPresidio },
};

export default defineConfig({
  plugins: [tailwindcss()],
  // Served at the ROOT of the deployment origin. GitHub Pages with access
  // control (private/internal repo) serves from a generated *.pages.github.io
  // subdomain root, so the base is '/', not '/<repo>/'. If this is ever made a
  // PUBLIC project site (served at <owner>.github.io/document-ocr-extractor/),
  // change this back to '/document-ocr-extractor/'. The base must match the
  // served path: src/ocr/runtime/assets.ts resolves vendored assets against it.
  base: '/',
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
  server: { headers: coiHeaders, proxy: presidioProxy },
  preview: { headers: coiHeaders, proxy: presidioProxy },
});
