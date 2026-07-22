/**
 * De-identify one OCR'd page with Presidio, scoped to the bounding boxes the
 * OCR pipeline already recognized.
 *
 * We deliberately do NOT use Presidio's image redactor. Instead each assembled
 * document Block (heading / paragraph / listItem / kv / table - all of which
 * carry a `box`) is analyzed on its own, so every PII span comes back attached
 * to a known region of the page. That gives us two outputs:
 *
 *   - findings[]  entity type + score + a PIXEL BOX, used to draw redaction
 *                 rectangles over the page image in the review pane;
 *   - markdown    the page text with every finding replaced by the placeholder,
 *                 which is what gets exported (and what the LLM sees, when the
 *                 extraction stage is enabled).
 *
 * Box precision: a Block's own box bounds the whole paragraph/table, which is
 * coarser than the entity itself. Where the uncertainty layer supplies raw OCR
 * lines with per-character boxes we narrow the rectangle to the exact
 * characters; otherwise we fall back to the line box, then the block box.
 *
 * The redacted markdown is produced by substring replacement rather than by
 * re-assembling blocks, because the markdown is built inside the OCR worker
 * and its layout (headings, tables, key/value runs) isn't reproducible here.
 * Replacement is global per distinct PII string, so a name appearing twice is
 * redacted in both places - over-redaction being the safe direction.
 */
import { analyze, anonymize, REDACTION_PLACEHOLDER } from './presidio.js';

/** Analyze at most this many blocks concurrently. */
const CONCURRENCY = 4;

/** The analyzable text of one Block, or '' for blocks that carry none. */
function blockText(block) {
    if (!block || typeof block !== 'object') return '';
    switch (block.kind) {
        case 'heading':
        case 'paragraph':
            return block.text || '';
        case 'listItem':
            return [block.lead, block.text].filter(Boolean).join(' ');
        case 'kv':
            // Analyze as "Label: value" so the label gives the recognizers
            // context (e.g. "Patient: J Smith" reads far more clearly as a
            // PERSON than a bare "J Smith").
            return [block.label, block.value].filter(Boolean).join(': ');
        case 'table':
            return (block.cells || []).map((row) => (row || []).join('\t')).join('\n');
        default:
            return ''; // 'rule' and anything unknown
    }
}

const boxesOverlap = (a, b) =>
    !!a && !!b && a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

function unionBox(boxes) {
    const valid = boxes.filter(Boolean);
    if (!valid.length) return null;
    return valid.reduce((acc, b) => ({
        x0: Math.min(acc.x0, b.x0),
        y0: Math.min(acc.y0, b.y0),
        x1: Math.max(acc.x1, b.x1),
        y1: Math.max(acc.y1, b.y1),
    }));
}

/**
 * Best pixel box for a PII string that was found inside `block`.
 * Prefers per-character geometry from the raw OCR lines; degrades to the
 * line box, then the block box.
 */
function locateSpan(piiText, block, lines) {
    const needle = piiText.trim();
    if (needle) {
        for (const line of lines) {
            if (!boxesOverlap(line.box, block.box)) continue;
            const idx = (line.text || '').indexOf(needle);
            if (idx < 0) continue;
            const chars = line.chars;
            if (Array.isArray(chars) && chars.length >= idx + needle.length) {
                const tight = unionBox(chars.slice(idx, idx + needle.length).map((c) => c.box));
                if (tight) return tight;
            }
            if (line.box) return line.box;
        }
    }
    return block.box || null;
}

/** Run `tasks` (thunks) with at most `limit` in flight, preserving order. */
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
 * De-identify a single stored OCR page.
 *
 * @param {object} ocrPage  a record from the ocrPages store (markdown, blocks, uncertainty)
 * @param {object} opts     { base, entities, scoreThreshold, placeholder, signal }
 * @returns {Promise<{markdown: string, findings: Array, entities: string[], at: number}>}
 *   `markdown` is the redacted page text; `findings` carry entity type, score
 *   and box (no raw PII - the original text is retained separately).
 */
export async function deidentifyPage(ocrPage, opts = {}) {
    const { base, entities, scoreThreshold, placeholder = REDACTION_PLACEHOLDER, signal } = opts;
    const blocks = Array.isArray(ocrPage?.blocks) ? ocrPage.blocks : [];
    const lines = Array.isArray(ocrPage?.uncertainty?.lines) ? ocrPage.uncertainty.lines : [];
    const originalMarkdown = ocrPage?.markdown || '';

    // Analyze each recognized region independently, so every span is already
    // attributed to one bounding box.
    const analyzable = blocks
        .map((block, index) => ({ block, index, text: blockText(block) }))
        .filter((b) => b.text.trim().length > 0);

    // Each region: analyzer finds the spans, anonymizer performs the actual
    // substitution on that region's text. Both services are used as intended;
    // no image redaction is involved.
    const perBlock = await mapWithConcurrency(analyzable, CONCURRENCY, async ({ block, index, text }) => {
        const spans = await analyze(text, { base, entities, scoreThreshold, signal });
        if (!spans.length) return { block, index, text, spans, items: [] };
        const { items } = await anonymize(text, spans, { base, placeholder, signal });
        return { block, index, text, spans, items };
    });

    const findings = [];
    /** original PII string -> whatever the anonymizer replaced it with. */
    const replacements = new Map();
    for (const { block, index, text, spans, items } of perBlock) {
        // Pair spans with the anonymizer's items positionally: replacements
        // preserve order, so both sorted ascending line up one-to-one. This
        // means we adopt the service's actual output rather than assuming the
        // placeholder - so a different operator would still work.
        const spansAsc = [...spans].sort((a, b) => a.start - b.start);
        const itemsAsc = [...items].sort((a, b) => a.start - b.start);
        spansAsc.forEach((span, i) => {
            const piiText = text.slice(span.start, span.end).trim();
            if (!piiText) return;
            replacements.set(piiText, itemsAsc[i]?.text ?? placeholder);
            findings.push({
                entityType: span.entity_type,
                score: span.score,
                blockIndex: index,
                box: locateSpan(piiText, block, lines),
            });
        });
    }

    // Propagate those substitutions through the assembled markdown, which the
    // anonymizer never sees in its laid-out form (the OCR worker builds it).
    let markdown = originalMarkdown;
    if (replacements.size) {
        // Longest first so a shorter PII string can't partially clobber a
        // longer one that contains it.
        const ordered = [...replacements.keys()].sort((a, b) => b.length - a.length);
        for (const pii of ordered) {
            markdown = markdown.split(pii).join(replacements.get(pii));
        }
    }

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
 * Ask the anonymizer to redact a standalone string. Used for the Settings
 * "test connection" round-trip and available for callers that want the
 * service (rather than local substitution) to do the substituting.
 */
export async function anonymizeText(text, opts = {}) {
    const { base, entities, scoreThreshold, placeholder, signal } = opts;
    const spans = await analyze(text, { base, entities, scoreThreshold, signal });
    const { text: redacted } = await anonymize(text, spans, { base, placeholder, signal });
    return redacted;
}
