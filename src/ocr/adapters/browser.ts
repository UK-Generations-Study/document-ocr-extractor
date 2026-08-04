/**
 * Browser runtime adapter: Canvas/ImageBitmap decode, fetch for assets/models,
 * onnxruntime-web (WASM or WebGPU EP) for inference. The production deployment
 * target — proves the pipeline code (which only ever touches RuntimeContext)
 * runs unchanged client-side. No data leaves the page: every fetch is to the
 * same origin (models + fixtures), inference is local WASM/WebGPU.
 */
import * as ort from 'onnxruntime-web';
import type { InferenceSession } from 'onnxruntime-common';
import type { RasterImage } from '../core/types.ts';
import type { ExecutionProvider, ImageSource, ModelSpec, OrtSessionOpts, RuntimeContext } from './types.ts';
import { modelUrl, ORT_WASM_DIR } from '../runtime/assets.ts';
import { cachedModelBytes, isRemote } from '../runtime/model-cache.ts';

// onnxruntime-web WASM runtime files are vendored same-origin (public/ort/).
ort.env.wasm.wasmPaths = ORT_WASM_DIR;
ort.env.webgpu.powerPreference = 'high-performance';

/** Upper bound on WASM threads. Past a handful of threads ORT is limited by
 *  memory bandwidth rather than cores, and the remaining CPUs are better left
 *  to the browser's compositor and (in the air-gapped deployment) the Presidio
 *  container. Override per-session with ?ortThreads=N if a host disagrees. */
const MAX_WASM_THREADS = 8;

/**
 * How many threads the WASM execution provider may use.
 *
 * This matters most where there is no GPU — an air-gapped VM, typically — as
 * Quick Read then falls back from WebGPU to WASM and this becomes the only
 * lever on OCR speed. Threading needs SharedArrayBuffer, hence a
 * cross-origin-isolated page (COOP/COEP; see docker/nginx.conf and
 * vite.config.js). Without isolation the threaded runtime cannot start at all,
 * so fall back to one thread rather than failing.
 *
 * `n` comes from the ?ortThreads=N escape hatch, plumbed in from the page URL
 * because a Web Worker can read neither the page's query string nor
 * localStorage. It exists because ORT's threaded runtime spawns nested workers
 * from inside quick.worker.ts, and a nested Emscripten pthread pool is exactly
 * what deadlocked wllama here before (run-g-live.ts). If that ever happens to
 * ORT too, ?ortThreads=1 restores the old single-threaded behaviour without a
 * rebuild - which on an air-gapped host means without a multi-GB transfer.
 */
export function wasmThreadCount(n?: number): number {
  if (!globalThis.crossOriginIsolated) return 1;
  if (Number.isFinite(n) && (n as number) >= 1) return Math.floor(n as number);
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(1, Math.min(MAX_WASM_THREADS, cores));
}

/** Set the WASM thread count. Must run before the first session is created;
 *  ORT reads this when it brings the WASM backend up. */
export function configureWasmThreads(n?: number): void {
  ort.env.wasm.numThreads = wasmThreadCount(n);
}

// Safe default for any importer that never calls configureWasmThreads().
configureWasmThreads();

export interface BrowserContextOpts {
  /** Default EP for every session created on this context (per-call opts.ep wins). */
  ep?: ExecutionProvider;
  /** Per-model override by ModelSpec.id; wins over `ep`, loses to per-call opts.ep. */
  epOverrides?: Record<string, ExecutionProvider>;
  /** webgpu session-creation failure → retry once on wasm and report (app mode).
   *  Default false = strict: failures propagate (bench / probes / parity). */
  epFallback?: boolean;
  onEpFallback?: (specId: string, requested: ExecutionProvider, err: unknown) => void;
}

async function decodeImage(src: ImageSource): Promise<RasterImage> {
  const blob = await (await fetch(src)).blob();
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const cx = canvas.getContext('2d', { willReadFrequently: true })!;
  cx.drawImage(bmp, 0, 0);
  const img = cx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return { data: img.data, width: img.width, height: img.height };
}

async function fetchBytesWithRetry(src: ImageSource, init?: RequestInit): Promise<Uint8Array> {
  // Model weights stream from the cross-origin HuggingFace CDN, and the eager
  // warm-up pulls the layout + OCR weights concurrently (hundreds of MB), so a
  // single transient blip shouldn't hard-fail the whole load. Bounded retry with
  // backoff; also treat a non-2xx response as an error so a bad body never reaches
  // ORT as "model bytes". GETs here are idempotent static assets, safe to retry.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(src, init);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${src}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
    }
  }
  throw lastErr;
}

async function readBytes(src: ImageSource): Promise<Uint8Array> {
  // Cross-origin weights (the HF CDN) get a durable CacheStorage copy so a returning
  // user doesn't re-stream the ~275 MB Quick Read set; same-origin vendored assets are
  // small and ride the normal HTTP cache. cachedModelBytes falls back to a plain fetch
  // wherever CacheStorage is unavailable, so this never blocks a load.
  if (isRemote(src)) return cachedModelBytes(src, fetchBytesWithRetry);
  return fetchBytesWithRetry(src);
}

async function assetSize(rel: string): Promise<number> {
  const head = await fetch(modelUrl(rel), { method: 'HEAD' });
  const len = head.headers.get('content-length');
  if (len) return Number(len);
  return (await readBytes(modelUrl(rel))).byteLength;
}

async function fetchModel(spec: ModelSpec): Promise<{ data: Uint8Array; bytes: number }> {
  const data = await readBytes(modelUrl(spec.url));
  let bytes = data.byteLength;
  for (const ext of spec.externalData ?? []) bytes += (await readBytes(modelUrl(ext))).byteLength;
  return { data, bytes };
}

export function createBrowserContext(ctxOpts: BrowserContextOpts = {}): RuntimeContext {
  async function createSession(spec: ModelSpec, opts: OrtSessionOpts = {}): Promise<InferenceSession> {
    // Per-call > per-model override > context default > wasm. Engines never
    // pass opts.ep, so pipelines follow the context (probes stay explicit).
    const resolved = opts.ep ?? ctxOpts.epOverrides?.[spec.id] ?? ctxOpts.ep ?? 'wasm';
    const { data } = await fetchModel(spec);
    // External-data models (none in pipeline B) would register buffers here.
    const externalData = await Promise.all(
      (spec.externalData ?? []).map(async (ext) => ({ path: ext.split('/').pop()!, data: await readBytes(modelUrl(ext)) })),
    );
    const create = (ep: ExecutionProvider) =>
      ort.InferenceSession.create(data, {
        executionProviders: ep === 'webgpu' ? ['webgpu'] : ['wasm'],
        graphOptimizationLevel: 'all',
        ...(externalData.length ? { externalData } : {}),
      });
    if (resolved !== 'webgpu' || !ctxOpts.epFallback) return create(resolved);
    try {
      return await create('webgpu');
    } catch (err) {
      ctxOpts.onEpFallback?.(spec.id, 'webgpu', err);
      return create('wasm');
    }
  }

  return {
    kind: 'browser',
    decodeImage,
    readBytes,
    fetchModel,
    createSession,
    assetUrl: (rel) => modelUrl(rel),
    assetSize,
    now: () => performance.now(),
  };
}
