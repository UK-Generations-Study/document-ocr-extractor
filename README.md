# Document OCR Extractor

Document OCR Extractor is a browser-based tool for turning batches of scanned
or PDF documents into structured, tabular data. It runs an on-device OCR
pipeline over each page, then uses a large language model to extract the fields
described by a JSON Schema, with a human-in-the-loop review step for both
stages. Document bytes never leave the machine for OCR; extraction can use a
hosted LLM API or an in-browser model.

It is built for a non-technical abstractor to feed in many documents at once
(via a metadata CSV or by dropping files), supervise the automated OCR and
extraction, correct anything the machine got wrong, and export the results.

## Features

- **Batch-first workflow** — a sidebar queue with search, status filters and
  counts, per-TCode grouping, and bulk confirm/retry actions.
- **On-device OCR** — a "Quick Read" pipeline (PP-OCR detection/recognition +
  layout analysis, running in WebGPU/WASM) with an optional higher-quality
  "Deep Read" VLM pass. No page images are uploaded.
- **Attention flags** — low-confidence lines, text outside the recognized
  layout, and cross-model disagreements are surfaced on the page image and
  counted per report; the confidence threshold is user-tunable.
- **Schema-driven extraction** — one LLM call per JSON Schema, rendered as a
  typed, editable form. Works with OpenAI-compatible APIs, Google Gemini, or an
  in-browser model (no key, WebGPU).
- **Review modes** — from "review everything" to fully automatic, so a clean
  batch can flow end-to-end while flagged documents stop for a human.
- **Export** — confirmed extractions download as CSV or JSON, with the source
  metadata (TCode / document id / period) carried through as join keys.

All state (documents, page images, OCR results, extracted fields, settings)
lives in the browser's IndexedDB; model weights are cached in the browser after
first download.

## Getting started

Requires Node 22+ and a WebGPU-capable browser (recent Chrome/Edge on desktop
are safest).

```bash
npm install
npm run dev      # local dev server (staging + Vite)
npm run build    # production build into dist/
npm run preview  # serve the production build
```

The app requires cross-origin isolation (COOP/COEP) for its multi-threaded OCR
and in-browser LLM. The dev/preview servers send the headers directly; on a
static host a service-worker shim (`public/coi-serviceworker.js`) provides them.

### External dependency: OCR model weights

The OCR pipeline fetches its model weights from the HuggingFace repository
[`jeyabbalas/private-eye-models`](https://huggingface.co/jeyabbalas/private-eye-models),
pinned to revision `f1ec7e4` (see `src/ocr/runtime/assets.ts` and
`scripts/prepare-build.mjs`). The small layout graph is fetched at build time;
the larger weight sidecars stream from the HuggingFace CDN on the first OCR run
and are then cached in the browser.

This repository is currently **public**, so no credentials are needed. **The
build and runtime OCR both depend on continued read access to it.** If it were
made private or removed, OCR would stop working — mirror the weights (e.g. into
a repository this organization owns) and update the pinned repo/revision in the
two files above.

## Deployment

Pushing to `main` builds and deploys to GitHub Pages via
`.github/workflows/deploy.yml`. The Vite `base` is set to
`/document-ocr-extractor/` to match the repository name; update it if you host
under a different path.

Live: https://uk-generations-study.github.io/document-ocr-extractor/

## Provenance

This repository is a fusion of two projects. It was assembled from these
parent commits:

| Component | Source repository | Commit |
| --- | --- | --- |
| Extraction app, UI, batch workflow | [`jeyabbalas/medical-report-information-extractor`](https://github.com/jeyabbalas/medical-report-information-extractor) | `3d08edc` |
| OCR pipeline (Quick Read / Deep Read) | [`jeyabbalas/private-eye`](https://github.com/jeyabbalas/private-eye) | `5e989d0` |
| OCR model weights (HuggingFace) | [`jeyabbalas/private-eye-models`](https://huggingface.co/jeyabbalas/private-eye-models) | `f1ec7e4` |

The `private-eye` OCR pipeline was ported into `src/ocr/`; the one build-time
asset it provided (`public/models/ppocr/calibration.json`) is vendored at
`assets/ppocr/calibration.json` and staged by `scripts/prepare-build.mjs`. The
layout model weights stream from the pinned `private-eye-models` revision at
runtime (see `src/ocr/runtime/assets.ts`).

## License

MIT — see [LICENSE](LICENSE).
