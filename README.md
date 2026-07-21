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

**The build makes no network calls** — the small graph files it needs are
vendored in `assets/` (the ~5 MB layout graph and the PP-OCR calibration map)
and staged by `scripts/prepare-build.mjs`.

At **runtime**, the OCR pipeline streams its large model weight sidecars
(~130 MB) from the HuggingFace repository
[`jeyabbalas/private-eye-models`](https://huggingface.co/jeyabbalas/private-eye-models),
pinned to revision `f1ec7e4` (see `src/ocr/runtime/assets.ts`). They are cached
in the browser after the first OCR run.

That repository is currently **public**, so no credentials are needed.
**In-browser OCR depends on continued read access to it.** If it were made
private or removed, OCR would stop working in the browser — mirror the weights
into a repository this organization owns and update the pinned repo/revision in
`src/ocr/runtime/assets.ts` (and, to keep them in lockstep, the fallback
constants in `scripts/prepare-build.mjs`).

## Sample data

A small set of sample reports lives in
[`examples/bcn_generations_pathology_data/sample_reports/`](examples/bcn_generations_pathology_data/sample_reports).
These are synthetic BBD pathology report page images (mstore-style single-page
TIFF exports) laid out exactly like a real batch:

```
sample_reports/
  metadata.csv                         # one row per report (TCode, yearmonth, mm, CB_DOCID, CB_PAGES)
  BBD_Path_Reports/<yearmonth>/<mm>/<CB_DOCID>.<page>   # the page images
```

To load them in the app, click **CSV batch** in the sidebar and select the
`sample_reports` folder — i.e. the directory that contains `metadata.csv`. The
app reads the CSV, resolves each row's page images under `BBD_Path_Reports/`,
and loads the reports into the queue (grouped by TCode), where OCR begins
automatically. It's the quickest way to see the batch review workflow end to
end. The synthetic pages were produced by `sample_reports/generate_reports.py`.

## Deployment

Pushing to `main` builds and deploys to GitHub Pages via
`.github/workflows/deploy.yml`. The Vite `base` is set to `/` because the site
is served from the deployment origin's root (a private/access-controlled Pages
site on a `*.pages.github.io` subdomain). If you host it as a public project
site under `<owner>.github.io/document-ocr-extractor/`, set `base` back to
`/document-ocr-extractor/`.

Live: https://uk-generations-study.github.io/document-ocr-extractor/

## Provenance

This repository is a fusion of two projects. It was assembled from these
parent commits:

| Component | Source repository | Commit |
| --- | --- | --- |
| Extraction app, UI, batch workflow | [`jeyabbalas/medical-report-information-extractor`](https://github.com/jeyabbalas/medical-report-information-extractor) | `3d08edc` |
| OCR pipeline (Quick Read / Deep Read) | [`jeyabbalas/private-eye`](https://github.com/jeyabbalas/private-eye) | `5e989d0` |
| OCR model weights (HuggingFace) | [`jeyabbalas/private-eye-models`](https://huggingface.co/jeyabbalas/private-eye-models) | `f1ec7e4` |

The `private-eye` OCR pipeline was ported into `src/ocr/`. The small build-time
assets it needs are vendored under `assets/` — the PP-OCR calibration map
(`assets/ppocr/`) and the layout graph + config (`assets/layout/`) — and staged
into `public/` by `scripts/prepare-build.mjs`, so the build is self-contained.
The large layout weight sidecar streams from the pinned `private-eye-models`
revision in the browser at runtime (see `src/ocr/runtime/assets.ts`).

## License

MIT — see [LICENSE](LICENSE).
