/**
 * De-identify one OCR'd page with Presidio, scoped to the regions the OCR
 * pipeline already recognized.
 *
 * We deliberately do NOT use Presidio's image redactor. The OCR pipeline hands
 * us a DocModel: a list of Blocks (heading / paragraph / listItem / kv / table),
 * each a recognized region of the page, plus the Markdown it serialized them
 * into. De-identification sits BETWEEN those two: every text field of every
 * block is analyzed and anonymized, then the page Markdown is re-rendered from
 * the redacted blocks with the pipeline's own renderMarkdown().
 *
 * That ordering matters. Re-rendering means the redacted Markdown is
 * structurally identical to the original - same headings, same tables, same
 * spacing - and that no text is ever pattern-matched or replaced after the
 * fact. A finding only ever affects the exact field it was found in.
 *
 * Only the text is redacted. Page images are left untouched: nothing but text
 * is exported, so the text is the only thing that needs de-identifying.
 */
import { analyze, anonymize, REDACTION_PLACEHOLDER } from './presidio.js';
import { renderMarkdown } from '../ocr/structure/blocks.ts';

/** Analyze at most this many distinct field texts concurrently. */
const CONCURRENCY = 4;

/**
 * Every de-identifiable text field of a block, as {path, text} pairs. `path`
 * tells applyRedactions where to write the redacted value back.
 *
 * Fields are analyzed individually rather than as one joined string per block,
 * so each result maps back to exactly the field it came from with no offset
 * arithmetic and no risk of an entity straddling two fields.
 */
function blockFields(block) {
    if (!block || typeof block !== 'object') return [];
    switch (block.kind) {
        case 'heading':
        case 'paragraph':
            return [{ path: ['text'], text: block.text || '' }];
        case 'listItem':
            return [
                ...(block.lead ? [{ path: ['lead'], text: block.lead }] : []),
                { path: ['text'], text: block.text || '' },
            ];
        case 'kv':
            return [
                { path: ['label'], text: block.label || '' },
                { path: ['value'], text: block.value || '' },
            ];
        case 'table':
            return (block.cells || []).flatMap((row, r) =>
                (row || []).map((cell, c) => ({ path: ['cells', r, c], text: cell || '' })),
            );
        default:
            return []; // 'rule' and anything unknown carry no text
    }
}

/** Structured clone of a block with one field replaced. */
function withField(block, path, value) {
    const next = { ...block };
    if (path[0] === 'cells') {
        const [, r, c] = path;
        next.cells = (block.cells || []).map((row, i) =>
            i === r ? (row || []).map((cell, j) => (j === c ? value : cell)) : row,
        );
    } else {
        next[path[0]] = value;
    }
    return next;
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(lanes);
    return results;
}

/**
 * Analyze then anonymize one piece of text.
 * @returns {Promise<{redacted: string, spans: Array}>}
 */
async function redactText(text, { base, entities, scoreThreshold, placeholder, signal }) {
    const spans = await analyze(text, { base, entities, scoreThreshold, signal });
    if (!spans.length) return { redacted: text, spans };
    const { text: redacted } = await anonymize(text, spans, { base, placeholder, signal });
    return { redacted, spans };
}

/**
 * De-identify a single stored OCR page.
 *
 * @param {object} ocrPage  a record from the ocrPages store (markdown, blocks, width, height)
 * @param {object} opts     { base, entities, scoreThreshold, placeholder, signal }
 * @returns {Promise<{markdown: string, findings: Array, entities: string[], at: number}>}
 *   `markdown` is the re-rendered redacted page text. `findings` record the
 *   entity type and score of each detection - never the matched text itself.
 */
export async function deidentifyPage(ocrPage, opts = {}) {
    const { base, entities, scoreThreshold, placeholder = REDACTION_PLACEHOLDER, signal } = opts;
    const redactOpts = { base, entities, scoreThreshold, placeholder, signal };
    const blocks = Array.isArray(ocrPage?.blocks) ? ocrPage.blocks : [];
    const originalMarkdown = ocrPage?.markdown || '';

    // Safety net: a page with no block structure (an older record, or a
    // pipeline that returned none) must still be de-identified rather than
    // silently exporting its raw text. Redact the whole page text as one unit.
    if (!blocks.length) {
        if (!originalMarkdown.trim()) {
            return { markdown: originalMarkdown, findings: [], entities: entities ? [...entities] : [], at: Date.now() };
        }
        const { redacted, spans } = await redactText(originalMarkdown, redactOpts);
        return {
            markdown: redacted,
            findings: spans.map((s) => ({ entityType: s.entity_type, score: s.score, blockIndex: -1 })),
            entities: entities && entities.length ? [...entities] : [],
            at: Date.now(),
        };
    }

    // Flatten to the set of fields needing analysis, then de-duplicate by text
    // so a value repeated across cells costs one round-trip, not many.
    const fields = blocks.flatMap((block, blockIndex) =>
        blockFields(block)
            .filter((f) => f.text.trim().length > 0)
            .map((f) => ({ ...f, blockIndex })),
    );
    const uniqueTexts = [...new Set(fields.map((f) => f.text))];
    const byText = new Map();
    await mapWithConcurrency(uniqueTexts, CONCURRENCY, async (text) => {
        byText.set(text, await redactText(text, redactOpts));
    });

    // Rebuild the blocks with redacted field values, and record what was found.
    let redactedBlocks = blocks;
    const findings = [];
    for (const { blockIndex, path, text } of fields) {
        const result = byText.get(text);
        if (!result || !result.spans.length) continue;
        redactedBlocks = redactedBlocks.map((b, i) => (i === blockIndex ? withField(b, path, result.redacted) : b));
        for (const span of result.spans) {
            findings.push({ entityType: span.entity_type, score: span.score, blockIndex });
        }
    }

    // Re-render with the pipeline's own serializer, so the redacted page is
    // laid out exactly as the original was.
    const markdown = findings.length
        ? renderMarkdown({ blocks: redactedBlocks, width: ocrPage.width, height: ocrPage.height })
        : originalMarkdown;

    return {
        markdown,
        findings,
        entities: entities && entities.length ? [...entities] : [],
        at: Date.now(),
    };
}

/**
 * The text of a page that is allowed to leave the browser - the redacted copy
 * when de-identification produced one, otherwise the raw OCR text. Every
 * consumer that exports text or sends it to an LLM must go through this, so a
 * de-identified document can never leak its original PII.
 */
export function pageOutputText(ocrPage) {
    return ocrPage?.deid?.markdown ?? ocrPage?.markdown ?? '';
}

/**
 * Ask Presidio to redact a standalone string. Used by the Settings
 * "test connection" round-trip.
 */
export async function anonymizeText(text, opts = {}) {
    const { redacted } = await redactText(text, { placeholder: REDACTION_PLACEHOLDER, ...opts });
    return redacted;
}
