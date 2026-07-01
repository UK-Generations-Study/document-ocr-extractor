/**
 * wllama patch (ported from private-eye/scripts/patch-wllama.ts).
 *
 * Two things applied to every stage:
 *   1) Worker-scope `document` guard in `absoluteUrl()` so wllama loads
 *      inside a Web Worker (there's no `document` there).
 *   2) (default) WASM memory cap raised from 4 GB to 10 GB. llama.cpp b9437
 *      (bundled in wllama 3.5.0) eagerly reserves ~4.6 GB for the glm4v
 *      vision buffer, over the 4 GB cap. b9590+ only estimates; the patch
 *      becomes unnecessary at wllama's next llama.cpp sync.
 *
 * Runs from scripts/prepare-build.mjs. Output goes to public/wllama-patched/
 * so Vite serves it under the app base.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const WASM_MEM_MAX_MB = 10240;
const WASM_MEM_MAX_PAGES = WASM_MEM_MAX_MB * 16; // 64 KiB pages

function patchWasmMemoryMax(wasm) {
    const importPat = Buffer.from([0x03, 0x65, 0x6e, 0x76, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02]);
    const first = wasm.indexOf(importPat);
    if (first === -1 || wasm.indexOf(importPat, first + 1) !== -1) {
        throw new Error('wllama.wasm memory import not found (or ambiguous) - re-verify the memory-max patch');
    }
    let p = first + importPat.length;
    const flags = wasm[p];
    if (flags !== 0x07) throw new Error(`unexpected memory import flags 0x${flags.toString(16)} (want 0x07)`);
    p++;
    while (wasm[p] & 0x80) p++;
    p++;
    const maxBytesLeb = [0x80, 0x80, 0x04];
    const newLeb = [0x80, 0x80, 0x0a];
    if (WASM_MEM_MAX_PAGES !== 163840) throw new Error('WASM_MEM_MAX_MB changed - recompute LEB128 literal');
    for (let i = 0; i < 3; i++) {
        if (wasm[p + i] !== maxBytesLeb[i]) throw new Error('memory max limit is not expected 65536-page LEB128');
    }
    const out = Buffer.from(wasm);
    for (let i = 0; i < 3; i++) out[p + i] = newLeb[i];
    return out;
}

/**
 * Stage @wllama/wllama runtime into public/wllama-patched/. Applies both the
 * memory-cap patch and the worker-scope document guard.
 */
export function ensurePatchedWllama(root) {
    const pkgPath = join(root, 'node_modules/@wllama/wllama/package.json');
    const gluePath = join(root, 'node_modules/@wllama/wllama/esm/index.js');
    const wasmPath = join(root, 'node_modules/@wllama/wllama/esm/wasm/wllama.wasm');
    const outDir = join(root, 'public/wllama-patched');

    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const rawSrc = readFileSync(gluePath, 'utf8');

    // Worker-scope document guard.
    const pDoc = 'new URL(relativePath, document.baseURI).href';
    const pDocFixed = 'new URL(relativePath, (typeof document !== "undefined" ? document.baseURI : self.location.href)).href';
    if (rawSrc.split(pDoc).length !== 2) {
        throw new Error('wllama absoluteUrl() shape changed - re-verify the worker-scope document guard');
    }
    let src = rawSrc.replace(pDoc, pDocFixed);

    // Memory-cap patch.
    const p1 = 'let maxBytes = 4096 * 1024 * 1024;';
    const p2 = 'maximum:65536n';
    const p3 = 'var getHeapMax=()=>4294967296';
    if (src.split(p1).length !== 2 || src.split(p2).length !== 2 || src.split(p3).length !== 2) {
        throw new Error('wllama glue changed - re-verify the WASM memory-cap patch');
    }
    src = src
        .replace(p1, `let maxBytes = ${WASM_MEM_MAX_MB} * 1024 * 1024;`)
        .replace(p2, `maximum:${WASM_MEM_MAX_PAGES}n`)
        .replace(p3, `var getHeapMax=()=>${WASM_MEM_MAX_MB * 1024 * 1024}`);

    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'index.js'), src);
    const wasm = patchWasmMemoryMax(readFileSync(wasmPath));
    writeFileSync(join(outDir, 'wllama.wasm'), wasm);
    return { wllamaNpm: pkg.version, patched: true, outDir };
}
