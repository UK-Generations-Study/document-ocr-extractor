/**
 * The report-text export: OCR'd, de-identified text leaving one machine so
 * another can run field extraction on it.
 *
 * The two halves of this tool can run on different machines. OCR and
 * de-identification happen on a host running in Read mode; extraction needs an
 * LLM, so another machine runs in Extract mode. See src/core/mode.js. This file
 * is what moves between them.
 *
 * Deliberately NOT the same as a flat text dump. Pages stay separate here, so
 * page boundaries survive the round trip; joining them into one string with
 * `--- Page N ---` separators cannot be reversed reliably, because a
 * single-page document gets no separator at all.
 *
 * Page IMAGES never appear here, and that is the point rather than an
 * omission: de-identification redacts text only, so the original page images
 * still carry PHI and must not leave the machine that holds them. A document
 * imported from one of these files therefore has no images, and the review pane
 * shows its de-identified text instead (see reportViewer.js).
 *
 * `deidentified` is per document and means "every page carries a current-schema
 * de-identification record" - NOT "something was redacted". A page with no PHI
 * and a page that never went through the analyzer both yield zero redactions,
 * and only the record tells them apart. It is recorded rather than enforced:
 * export emits un-redacted documents with the flag false, and import loads them
 * as-is, so anything acting on that distinction must read the flag.
 */

/** Identifies the file. Present so a stray JSON cannot be mistaken for one. */
export const TEXT_EXPORT_FORMAT = 'doe-report-text';

/** Bumped only for breaking shape changes; the importer rejects what it cannot read. */
export const TEXT_EXPORT_VERSION = 1;

/**
 * Assemble the export object.
 *
 * @param {{doc: object, pages: {index: number, text: string}[], deidentified: boolean}[]} entries
 * @returns {object} the object to serialize
 */
export function buildTextExport(entries) {
    return {
        format: TEXT_EXPORT_FORMAT,
        formatVersion: TEXT_EXPORT_VERSION,
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
 * Parse and validate a report-text file.
 *
 * Throws with a message worth showing the user: this reads a file that was
 * hand-carried between machines, where "it silently imported nothing" is a far
 * worse outcome than a blunt error.
 *
 * @param {string} json raw file contents
 * @returns {{exportedAt: string|null, documents: object[]}}
 */
export function parseTextExport(json) {
    let data;
    try {
        data = JSON.parse(json);
    } catch (err) {
        throw new Error(`Not valid JSON: ${err.message}`);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Not a report-text file: expected a JSON object.');
    }
    if (data.format !== TEXT_EXPORT_FORMAT) {
        throw new Error(
            `Not a report-text file (format is ${JSON.stringify(data.format ?? null)}, `
            + `expected "${TEXT_EXPORT_FORMAT}"). Files exported by an older build are not read by this one - `
            + 're-export them from the machine that produced them.',
        );
    }
    if (data.formatVersion > TEXT_EXPORT_VERSION) {
        throw new Error(
            `This file is version ${data.formatVersion}; this build reads up to ${TEXT_EXPORT_VERSION}. Update the app.`,
        );
    }
    if (!Array.isArray(data.documents)) {
        throw new Error('Malformed report-text file: "documents" is not an array.');
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
