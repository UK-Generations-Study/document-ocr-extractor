/**
 * The air-gap handoff format: OCR'd, de-identified text leaving the isolated
 * machine so an LLM-connected one can run field extraction on it.
 *
 * The two halves of this tool can run on different machines. OCR and
 * de-identification happen on an air-gapped host running in Read mode;
 * extraction needs an LLM, which that host cannot reach, so another machine
 * runs in Extract mode. See src/core/mode.js. This file crosses the gap.
 *
 * Deliberately NOT the same as the `ocr-text` export. That one is a flat
 * analyst-facing artifact: one string per document, pages joined with
 * `--- Page N ---` separators that a single-page document does not get at all,
 * so page boundaries cannot be recovered reliably. This one is a machine
 * round-trip, so pages stay separate and identity is explicit.
 *
 * Page IMAGES never appear here, and that is the point rather than an
 * omission: de-identification redacts text only, so the original page images
 * still carry PHI and must not leave the air-gapped host. A document imported
 * from a handoff therefore has no images, and the review pane shows its
 * de-identified text instead (see reportViewer.js).
 *
 * `deidentified` is per document and means "every page carries a current-schema
 * de-identification record" - NOT "something was redacted". A page with no PHI
 * and a page that never went through the analyzer both yield zero redactions,
 * and only the record tells them apart. It is recorded rather than enforced:
 * export emits un-redacted documents with the flag false, and import loads them
 * as-is, so anything acting on that distinction must read the flag.
 */

/** Identifies the file. Present so a stray JSON cannot be mistaken for one. */
export const HANDOFF_FORMAT = 'doe-ocr-handoff';

/** Bumped only for breaking shape changes; the importer rejects what it cannot read. */
export const HANDOFF_VERSION = 1;

/**
 * Assemble the handoff object.
 *
 * @param {{doc: object, pages: {index: number, text: string}[], deidentified: boolean}[]} entries
 * @returns {object} the object to serialize
 */
export function buildHandoff(entries) {
    return {
        format: HANDOFF_FORMAT,
        formatVersion: HANDOFF_VERSION,
        exportedAt: new Date().toISOString(),
        documents: entries.map(({ doc, pages, deidentified }) => ({
            fileName: doc.name || '',
            // Nested so the join keys stay distinguishable from the payload.
            // Null rather than absent: a document ingested as a loose PDF has
            // no TCode, and the receiving side should see that explicitly.
            identifiers: {
                TCode: doc.metadata?.tcode ?? null,
                CB_DOCID: doc.metadata?.docid ?? null,
                yearmonth: doc.metadata?.yearmonth ?? null,
            },
            deidentified,
            pages: pages.map((p) => ({ index: p.index, text: p.text })),
        })),
    };
}

/**
 * Parse and validate a handoff file.
 *
 * Throws with a message worth showing the user: this reads a file that was
 * hand-carried across an air gap, where "it silently imported nothing" is a far
 * worse outcome than a blunt error.
 *
 * @param {string} json raw file contents
 * @returns {{exportedAt: string|null, documents: object[]}}
 */
export function parseHandoff(json) {
    let data;
    try {
        data = JSON.parse(json);
    } catch (err) {
        throw new Error(`Not valid JSON: ${err.message}`);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Not a handoff file: expected a JSON object.');
    }
    if (data.format !== HANDOFF_FORMAT) {
        throw new Error(
            `Not a handoff file (format is ${JSON.stringify(data.format ?? null)}, expected "${HANDOFF_FORMAT}"). ` +
            'The plain ocr-text export cannot be imported - it does not keep page boundaries.',
        );
    }
    if (data.formatVersion > HANDOFF_VERSION) {
        throw new Error(
            `This file is version ${data.formatVersion}; this build reads up to ${HANDOFF_VERSION}. Update the app.`,
        );
    }
    if (!Array.isArray(data.documents)) {
        throw new Error('Malformed handoff file: "documents" is not an array.');
    }

    const documents = data.documents.map((d, i) => {
        const where = `document ${i + 1}`;
        if (!d || typeof d !== 'object') throw new Error(`Malformed ${where}.`);
        if (!Array.isArray(d.pages) || d.pages.length === 0) {
            throw new Error(`Malformed ${where}: no pages.`);
        }
        const pages = d.pages.map((p, j) => {
            if (!p || typeof p.text !== 'string') {
                throw new Error(`Malformed ${where}, page ${j + 1}: missing text.`);
            }
            return { index: Number.isFinite(p.index) ? p.index : j + 1, text: p.text };
        });
        return {
            fileName: typeof d.fileName === 'string' ? d.fileName : '',
            identifiers: {
                TCode: d.identifiers?.TCode ?? null,
                CB_DOCID: d.identifiers?.CB_DOCID ?? null,
                yearmonth: d.identifiers?.yearmonth ?? null,
            },
            // Absent means unknown, which is not the same as de-identified.
            deidentified: d.deidentified === true,
            pages,
        };
    });

    return { exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : null, documents };
}
