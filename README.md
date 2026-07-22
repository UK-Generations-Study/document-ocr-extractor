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

## De-identification (optional)

The app can strip personal identifiers out of the OCR text using
[Presidio](https://github.com/data-privacy-stack/presidio). It uses the
**analyzer and anonymizer services only** — not the image redactor: each text
region the OCR pipeline already recognized is analyzed on its own, so every
detected identifier comes back attached to a bounding box. Those boxes are
blacked out over the page image, and the matching text is replaced with
`[REDACTED]`.

Run the two services:

```bash
docker run -d --name presidio-analyzer   -p 5002:3000 mcr.microsoft.com/presidio-analyzer:latest
docker run -d --name presidio-anonymizer -p 5001:3000 mcr.microsoft.com/presidio-anonymizer:latest
```

Then enable it in **Settings → De-identification** and press **Test**.

The services send no CORS headers, so the browser cannot call them directly.
Everything goes through the same-origin `/presidio` path, which the Vite dev
server proxies (see `vite.config.js`; override with `PRESIDIO_ANALYZER_URL` /
`PRESIDIO_ANONYMIZER_URL`). This also keeps the page cross-origin-isolated,
which the OCR engines require.

How it behaves:

- Runs **automatically after OCR** on every page, before the document becomes
  reviewable.
- **The original text is kept.** The review pane shows the redacted version
  (editable, so you can fix a bad redaction) with a **Show original** toggle
  that reveals the un-redacted text read-only. Exports — and the LLM, when the
  extraction stage is enabled — only ever receive the redacted text.
- **A failure fails the document.** If the services are unreachable the report
  is marked failed rather than quietly proceeding, so text that was meant to be
  redacted can never reach the review pane or an export.
- Identifier types are configurable; the default set is tuned for UK pathology
  reports (`PERSON`, `DATE_TIME`, `LOCATION`, `PHONE_NUMBER`, `EMAIL_ADDRESS`,
  `UK_NHS`, `MEDICAL_LICENSE`). **Load all from service** offers every type the
  running analyzer supports.

Box precision comes from the OCR uncertainty layer: where per-character
geometry is available the rectangle is narrowed to the exact characters,
otherwise it falls back to the line box and then the block box.

> The air-gapped Docker image does not yet bundle Presidio — enabling
> de-identification there needs the two services running alongside it and
> nginx proxying `/presidio`.

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

## Air-gapped Docker deployment

The `Dockerfile` builds a self-contained image that serves the app with every
model weight baked in, so the running container needs **no network access**.
It is an OCR appliance: ingest, OCR, review and export, with **no LLM field
extraction** (nothing to reach on an isolated network) — the setup wizard is
skipped and Export emits the reviewed OCR text instead of extracted fields.

All computation still happens in the operator's **browser**; the container is
only a static file server. The host therefore needs a WebGPU-capable browser
(recent Chrome/Edge).

Build on a networked machine (it downloads ~1.64 GB of weights), then move it:

```bash
docker build -t document-ocr-extractor:latest .
docker save document-ocr-extractor:latest | gzip > doe.tar.gz
```

Copy `doe.tar.gz` to the air-gapped host, then:

```bash
docker load < doe.tar.gz
docker run -d --name doe -p 8080:80 document-ocr-extractor:latest
```

Open **http://localhost:8080** on that machine.

Two constraints worth knowing:

- **Use `localhost`.** The OCR engines need `SharedArrayBuffer`, which browsers
  only expose on a cross-origin-isolated *and* secure page. `http://localhost`
  counts as secure; reaching the container over plain HTTP from another machine
  does not, and OCR will refuse to start. Serving to other hosts requires HTTPS
  with a trusted certificate.
- **Image size.** ~1.8 GB by default, including the Deep Read VLM. Build with
  `--build-arg FETCH_DEEP=` to omit it and ship ~270 MB of models instead
  (Quick Read only, roughly a 450 MB image).

To vendor the weights outside Docker (e.g. for an offline `npm run preview`):

```bash
npm run fetch-models -- --deep        # into public/models/
VITE_OFFLINE_MODELS=true VITE_OCR_ONLY=true npm run build
```

Both flags are off by default, so an ordinary `npm run build` still produces
the normal online app with LLM extraction (see `src/core/flags.js`).

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
