# Document OCR Extractor

## Live: 🔗 https://uk-generations-study.github.io/document-ocr-extractor/

Browser-based tool that turns batches of scanned or PDF documents into
structured data. It runs OCR on each page, removes personal identifiers, and
uses a large language model to extract the fields described by a JSON Schema.
Both stages include a human review step.

Document images never leave the machine. OCR runs in the browser; only
de-identified text is sent to an LLM.

- [Requirements](#requirements)
- [Pipeline modes](#pipeline-modes)
- [Docker deployment](#docker-deployment)
- [De-identification](#de-identification)
- [Splitting the pipeline across machines](#splitting-the-pipeline-across-machines)
- [Development](#development)
- [Provenance](#provenance)
- [License](#license)

## Requirements

- Docker, for de-identification and for the packaged deployment
- Node 22 or later, if not using Docker

## Pipeline modes

The tool has two halves, reading and extracting, which can run on separate
machines. The mode is chosen on first launch and can be changed in
**Settings > Mode**. Changing it reloads the page.

| Mode | Does | Use on |
| --- | --- | --- |
| **Read** | OCR, de-identify, review text, export report text | An isolated or air-gapped machine |
| **Extract** | Import report text, extract fields, export fields | A machine with LLM access but no scans |
| **Read + Extract** | The full pipeline | A single machine that does everything |

For LLM extraction you also need an endpoint. The setup wizard accepts an
OpenAI-compatible API, Google Gemini, or an in-browser model that needs no
key. Self-hosted servers such as llama-server, vLLM and Ollama work with a
base URL and no API key.

## Docker deployment

Two images: the app, with all OCR model weights baked in, and the Presidio
analyzer. Neither needs network access at runtime. No LLM weights are bundled.

Build on a machine with internet access:

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-airgap.ps1
```

This produces `airgap-bundle.tar` (about 4.4 GB) containing both images. Add
`-QuickReadOnly` to omit the Deep Read model and save about 1.4 GB. The
equivalent by hand:

```bash
docker build --platform linux/amd64 --build-arg "FETCH_DEEP=--deep" -t document-ocr-extractor:latest .
docker build --platform linux/amd64 -t document-ocr-extractor-presidio:latest docker/presidio
docker save -o airgap-bundle.tar document-ocr-extractor:latest document-ocr-extractor-presidio:latest
```

Copy `airgap-bundle.tar` and `compose.yaml` to the target machine, then:

```bash
docker load -i airgap-bundle.tar
docker compose up -d
```

Open **http://localhost:7777**.

## De-identification

Personal identifiers are removed from the OCR text using
[Presidio](https://github.com/data-privacy-stack/presidio).

**If you run without the Docker image, you need to spin up the Presidio docker image if you want de-identification support**:

```bash
docker compose -f docker/presidio/compose.yaml up -d --build
```

Enable it in **Settings > De-identification** and press **Test**.

The analyzer image bundles a clinical de-id model and needs no network access:

| Identifier | Detected by |
| --- | --- |
| Names, dates, places | [`StanfordAIMI/stanford-deidentifier-base`](https://huggingface.co/StanfordAIMI/stanford-deidentifier-base), PubMedBERT fine-tuned for PHI |
| NHS numbers | Presidio `NhsRecognizer`, checksum validated |
| National Insurance numbers | Presidio `UkNinoRecognizer` |
| UK postcodes | Custom pattern in `docker/presidio/uk-postcode-recognizer.yaml` |
| Record and hospital numbers | The model's `ID` label |

## Splitting the pipeline across machines

A **report-text file** carries de-identified text from a Read machine to an
Extract machine. Extraction only ever receives text, so the absence of page
images costs it nothing.

On the Read machine, confirm the text, then **Export > Report text as JSON**:

```json
{
  "format": "doe-report-text",
  "formatVersion": 1,
  "documents": [
    {
      "fileName": "12345.1.tif",
      "identifiers": { "TCode": "T0001", "CB_DOCID": "12345", "yearmonth": "201207" },
      "deidentified": true,
      "pages": [{ "index": 1, "text": "# Histopathology Report\n\n..." }]
    }
  ]
}
```

On the Extract machine, use **Import text**. Documents arrive at
`ocr-confirmed` and go straight to the extraction queue. Results join back to
the originals on `TCode` and `CB_DOCID`.

Imported reports have no page images, because de-identification redacts text
only and the original scans stay on the machine that read them. The viewer
shows the de-identified text instead.

## Development

```bash
npm run dev        # dev server
npm run build      # production build into dist/
npm run preview    # serve the production build
npm test           # test suite
npm run typecheck  # tsc --noEmit
```

Build flags, both unset by default:

| Variable | Effect |
| --- | --- |
| `VITE_OFFLINE_MODELS` | Serve OCR weights from this origin instead of the HuggingFace CDN. Requires `npm run fetch-models`. |
| `VITE_DEFAULT_PIPELINE_MODE` | Start in a given mode instead of asking on first launch |

To vendor the model weights locally:

```bash
npm run fetch-models -- --deep
```

### Sample data

Synthetic pathology reports are in
[`examples/bcn_generations_pathology_data/sample_reports/`](examples/bcn_generations_pathology_data/sample_reports),
laid out as a real batch:

```
sample_reports/
  metadata.csv                                           # one row per report
  BBD_Path_Reports/<yearmonth>/<mm>/<CB_DOCID>.<page>    # page images
```

Click **CSV batch** and select the `sample_reports` folder.

## Provenance

This repository combines two projects:

| Component | Source | Commit |
| --- | --- | --- |
| Extraction app, UI, batch workflow | [`jeyabbalas/medical-report-information-extractor`](https://github.com/jeyabbalas/medical-report-information-extractor) | `3d08edc` |
| OCR pipeline | [`jeyabbalas/private-eye`](https://github.com/jeyabbalas/private-eye) | `5e989d0` |
| OCR model weights | [`jeyabbalas/private-eye-models`](https://huggingface.co/jeyabbalas/private-eye-models) | `f1ec7e4` |

## License

MIT. See [LICENSE](LICENSE).
