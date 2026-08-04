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
**analyzer service only** — not the anonymizer, and not the image redactor.
The analyzer finds the PII spans; the app derives the redacted text from them
itself, byte-identically to what the anonymizer's `replace` operator would
have returned.

De-identification sits between the two halves of the OCR pipeline. That
pipeline produces a list of blocks (heading / paragraph / key-value / table),
each a recognized region of the page, and then serializes them to Markdown.
Every text field of every block is analyzed and anonymized, and the page
Markdown is then **re-rendered from the redacted blocks** using the pipeline's
own serializer. So a finding only ever affects the field it was found in, and
the redacted page keeps the exact structure of the original.

Only the text is redacted — page images are left untouched, since the text is
the only thing that gets exported.

Run the analyzer:

```bash
docker compose -f docker/presidio/compose.yaml up -d --build
```

Then enable it in **Settings → De-identification** and press **Test**.

### Detection models

All the intelligence is in the analyzer, and `docker/presidio/` builds a
customised one:

- **Names, dates, places** come from
  [`StanfordAIMI/stanford-deidentifier-base`](https://huggingface.co/StanfordAIMI/stanford-deidentifier-base)
  — PubMedBERT fine-tuned for PHI de-identification (MIT licence; reported F1
  97.9–99.6 on radiology reports and i2b2). Presidio's stock analyzer uses the
  general-purpose spaCy `en_core_web_lg`, which is materially weaker on
  clinical prose. spaCy is still installed but only tokenizes.
- **UK NHS numbers** come from Presidio's built-in `NhsRecognizer` — a
  checksum-validated pattern matcher, not a model.
- **UK postcodes** come from a custom pattern recognizer defined in
  `docker/presidio/uk-postcode-recognizer.yaml`. Presidio ships a
  `UkPostcodeRecognizer` but it is disabled by default *and* scores matches at
  0.1, below the app's 0.5 threshold, so it would never surface a finding.
- **UK National Insurance numbers** come from Presidio's `UkNinoRecognizer`,
  which ships disabled and is enabled in `build-recognizers.py`.
- **Record and hospital numbers** come from the model's `ID` label. Presidio's
  stock config multiplies `ID` scores by 0.4 as a noisy category, which caps
  them at ~0.4 — below the 0.5 threshold, so the category could never surface a
  redaction. `nlp-transformers.yaml` removes that penalty: those numbers are
  exactly what a clinical de-identification pass should remove.

Everything (torch, transformers, tokenizer, model weights) is baked into the
image, so the analyzer needs no network access at runtime.

Note that general-purpose PII models — GLiNER-PII, Piiranha and similar — score
well on generic text but drop to roughly 0.41 F1 on clinical notes, so they
were not used here. `obi/deid_roberta_i2b2` is a comparable clinical
alternative if you ever want to A/B it.

The service sends no CORS headers, so the browser cannot call it directly.
Everything goes through the same-origin `/presidio` path, which the Vite dev
server proxies (see `vite.config.js`; override with `PRESIDIO_ANALYZER_URL`)
and which nginx proxies in the Docker image (`docker/nginx.conf`). This also
keeps the page cross-origin-isolated, which the OCR engines require.

How it behaves:

- Runs **automatically after OCR** on every page, before the document becomes
  reviewable.
- **The review pane shows the original text under a translucent veil**, so you
  can read what is about to be removed and judge whether it is right. Exports —
  and the LLM, when the extraction stage is enabled — receive that text with
  every veiled span replaced by `[REDACTED]`. (No extra exposure: the
  un-redacted page image is already on screen beside it.)
- **The text stays editable and the redactions are adjustable, in the same
  place.** Click in and type to fix an OCR error. Click inside a veil and
  confirm **Keep this text** to un-redact it — it drops to a dashed outline, so
  the decision stays visible, and clicking it offers **Redact this** to put it
  back. Select any text and confirm **Redact** to remove something the analyzer
  missed. **Reset** returns the page to what Presidio proposed.
- **A manual redaction applies to the whole document.** Redacting a string
  means that string identifies someone, so every occurrence of it is redacted —
  on every line and every page — and lifting it removes them all. Automatic
  detections stay per-page, since those are per-page judgements.
- Three views per page: **Rendered** (formatted) and **Raw** (Markdown source)
  are both editable and both show the veils, so you can redact from either;
  **Export** is a read-only preview of the text that will actually leave the
  app, with each veiled span replaced by `[REDACTED]`.
- On by default. It fails closed: if the Presidio service is unreachable,
  documents stop with an error rather than passing through un-redacted, so turn
  it off in Settings if you are running without Presidio.
- **Automatic detection runs once**, after OCR, and is never repeated on its
  own — re-running it would resurrect redactions you dismissed and discard the
  ones you added. Editing the text therefore re-anchors the redactions you
  already have onto the new text rather than re-analyzing it. If a redaction's
  own text is what changed it cannot be relocated, so it is dropped and you are
  told how many, rather than one quietly disappearing.
- **Nothing redacted is stored.** The redacted text is derived on demand from
  the stored candidate spans, so it always reflects your current settings -
  including for documents processed weeks ago.
- **A failure fails the document.** If the services are unreachable the report
  is marked failed rather than quietly proceeding, so text that was meant to be
  redacted can never reach the review pane or an export.
- Identifier types and the detection-confidence threshold are configurable, and
  both apply **live** to reports you have already processed - analysis records
  every candidate span, so changing them re-filters stored data rather than
  re-running Presidio. The default set is tuned for UK pathology reports
  (`PERSON`, `DATE_TIME`, `LOCATION`, `ORGANIZATION`, `PHONE_NUMBER`,
  `EMAIL_ADDRESS`, `ID`, `UK_NHS`, `UK_NINO`, `UK_POSTCODE`,
  `MEDICAL_LICENSE`); **Load all from service** offers every type the running
  analyzer supports. Types added to this list in a later version are adopted by
  existing profiles automatically, without resurrecting ones you switched off.
- A page that arrives with no block structure still gets de-identified: its
  whole text is redacted as one unit rather than passed through raw.

Recall is Presidio's, not ours: it decides what counts as an identifier and
where each span starts and ends. In practice that means a span can be narrower
than you'd expect — `Dr A Patel` is typically returned as just `Patel`, leaving
`Dr A` in place. Review the redactions on real reports and widen the entity
selection if needed.

The air-gapped deployment bundles the analyzer alongside the app — see below.

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

Two images, run together by `compose.yaml` in the repo root:

| Image | Built from | Contains |
| --- | --- | --- |
| `document-ocr-extractor` | `Dockerfile` | The built app, every OCR model weight, nginx |
| `document-ocr-extractor-presidio` | `docker/presidio/` | Presidio analyzer, torch, the clinical de-identification model |

Both are fully self-contained: **neither needs network access at runtime**, and
compose puts them on an `internal` network with no route out, so they cannot
reach anything even on a host that does have one.

The image **starts in Read mode** (see [Pipeline modes](#pipeline-modes)): ingest,
OCR, de-identify, review and export, with no LLM field extraction — nothing to
reach on an isolated network — so the setup wizard is skipped and Export emits
the reviewed OCR text instead of extracted fields. That is a *default*, not a
lock: an operator can switch modes in **Settings → Mode** if this image is ever
deployed somewhere an LLM is reachable. No LLM weights are bundled either way.

OCR still happens in the operator's **browser**; the app container is a static
file server plus the `/presidio` proxy. The host therefore needs a
WebGPU-capable browser (recent Chrome/Edge). De-identification is the one part
that runs server-side, in the analyzer container.

### Build (on a networked machine)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-airgap.ps1
```

That builds both images for `linux/amd64` and saves them into one
`airgap-bundle.tar`. Add `-QuickReadOnly` to omit the Deep Read VLM, or
`-OutFile` to write it elsewhere. Expect a long first run: it downloads
~1.64 GB of OCR weights, the clinical model, and CPU torch.

(The `-ExecutionPolicy Bypass` is because Windows blocks local scripts by
default. It applies to that one process and changes nothing on the machine.)

Or run the same three steps by hand, no script involved:

```powershell
docker build --platform linux/amd64 --build-arg "FETCH_DEEP=--deep" -t document-ocr-extractor:latest .
docker build --platform linux/amd64 -t document-ocr-extractor-presidio:latest docker/presidio
docker save -o airgap-bundle.tar document-ocr-extractor:latest document-ocr-extractor-presidio:latest
```

### Run (on the air-gapped machine)

Copy `airgap-bundle.tar` **and** `compose.yaml` across, then:

```bash
docker load -i airgap-bundle.tar
docker compose up -d
```

Open **http://localhost:7777** on that machine. De-identification is on by
default; **Settings → De-identification → Test** confirms the analyzer is
reachable and actually detecting.

### Things worth knowing before you carry it over

- **Give the analyzer a moment.** Measured at ~5 seconds from `compose up` to
  a working `/analyze`. Requests before then get a 502 and de-identification
  fails closed, so don't load documents the instant the containers start.
- **On a VM with no GPU, OCR runs on CPU threads.** Quick Read asks for WebGPU
  and falls back to the WASM execution provider when no adapter exists — the
  normal case on an air-gapped VM. That fallback used to be pinned to a single
  thread, which showed up as one saturated core and very slow OCR. It now uses
  `min(hardwareConcurrency, 8)` threads whenever the page is cross-origin
  isolated (which the Docker image guarantees), and one thread otherwise.
  Append **`?ortThreads=N`** to the URL to force a specific count —
  `http://localhost:7777/?ortThreads=1` restores the old single-threaded
  behaviour without a rebuild, which is the escape hatch to reach for if the
  threaded runtime ever misbehaves on a particular host.
- **Use `localhost`.** The OCR engines need `SharedArrayBuffer`, which browsers
  only expose on a cross-origin-isolated *and* secure page. `http://localhost`
  counts as secure; reaching the container over plain HTTP from another machine
  does not, and OCR will refuse to start. Serving to other hosts requires HTTPS
  with a trusted certificate. The published port is bound to `127.0.0.1` to
  make that explicit.
- **Bundle size.** ~1.8 GB for the app image including the Deep Read VLM, plus
  the analyzer image (torch and the clinical model dominate it). Use
  `-QuickReadOnly` to drop ~1.37 GB if Deep Read isn't needed for this run.
- **De-identification fails closed.** If the analyzer is unreachable, documents
  stop at `ocr-failed` rather than silently going through un-redacted. Turn it
  off in Settings if you deliberately want to run without it.
- **The analyzer publishes no port.** It accepts unauthenticated requests and
  would analyze anything sent to it, so it is reachable only from the app
  container, through nginx.

To vendor the weights outside Docker (e.g. for an offline `npm run preview`):

```bash
npm run fetch-models -- --deep        # into public/models/
VITE_OFFLINE_MODELS=true VITE_DEFAULT_PIPELINE_MODE=read npm run build
```

Both are unset by default, so an ordinary `npm run build` produces the normal
online app and asks the operator which mode to run on first launch (see
`src/core/flags.js` and `src/core/mode.js`).

## Pipeline modes

The tool has two halves — **reading** (OCR + de-identification) and
**extracting** (LLM fields) — and they need not run on the same machine. On
first launch the app asks which this one does; the answer is remembered and can
be changed in **Settings → Mode**.

| Mode | Does | For |
| --- | --- | --- |
| **Read** | OCR, de-identify, review text, export text or a handoff | An air-gapped or isolated machine |
| **Extract** | Import a handoff, extract fields with an LLM, export fields | A machine that can reach an LLM but holds no scans |
| **Read + Extract** | The complete pipeline on one machine | A single machine that does everything |

In Read mode there is no setup wizard, no Fields tab, and no LLM call. In
Extract mode there is no file ingest at all — the only way in is **Import text**,
and documents arrive already reviewed. The handoff export appears in Read mode,
where the exportable documents are text-confirmed ones; a Read + Extract machine
extracts locally instead, so it does not offer one.

Changing the mode **reloads the page**. The value is read while modules are
still loading — `STATUS_META` is rewritten and the sidebar's filter chips are
computed as module constants — so it cannot be swapped live. Documents already
loaded are kept untouched across the switch; they simply stop advancing if the
new mode has no stage for them, and resume if you switch back.

A build can ship a default with `VITE_DEFAULT_PIPELINE_MODE`, which suppresses
the first-run question. The Docker image sets `read` for exactly this reason.

## Split workflow: OCR on the air-gapped machine, extraction elsewhere

The two halves of the pipeline can run on different machines. OCR and
de-identification happen on the isolated host; field extraction needs an LLM,
which that host cannot reach. A **handoff file** carries the de-identified text
across.

This works because extraction only ever sees text — it builds a plain string
from the OCR pages and drops it into a prompt (`src/extraction/prompts.js`).
Page images are never sent to the LLM, so their absence costs extraction
nothing.

**On the air-gapped machine** (Read mode), confirm the text as usual, then
**Export → Download handoff (JSON)**. You get one file:

```json
{
  "format": "doe-ocr-handoff",
  "formatVersion": 1,
  "documents": [
    {
      "fileName": "12345.1.tif",
      "identifiers": { "TCode": "T0001", "CB_DOCID": "12345", "yearmonth": "201207" },
      "deidentified": true,
      "pages": [ { "index": 1, "text": "# Histopathology Report\n\n..." } ]
    }
  ]
}
```

Pages stay separate here, unlike the flat `ocr-text` export, whose
`--- Page N ---` separators are omitted entirely for single-page documents and
so cannot be parsed back reliably. Both exports remain available; this one is
for the machine round-trip.

**On the LLM-connected machine** (any normal build), **Import text** and pick
the file. Documents arrive at `ocr-confirmed` — the text was already reviewed —
and go straight into the extraction queue. Results join back to the originals on
`TCode` / `CB_DOCID`.

Imported reports have **no page images**, by design: de-identification redacts
text only, so the original scans still contain PHI and stay on the air-gapped
host. The viewer pane shows the de-identified text in their place, so extracted
fields can still be checked against their source.

`deidentified` means *every page carries a de-identification record* — not
*something was redacted*. A page with no PHI and a page that was never analyzed
both produce zero redactions, and only the record distinguishes them. It is
recorded, not enforced: a document that skipped de-identification is exported
with the flag `false` and imported as-is, so **a handoff file can contain
identifiable text** and should be handled accordingly in transit and at rest.
Export and import both say so in a notification when it happens.

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
