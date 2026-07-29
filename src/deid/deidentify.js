/**
 * De-identification: find PII with Presidio, then derive the redacted text.
 *
 * The pipeline sits between the two halves of OCR. That pipeline produces a
 * list of blocks (heading / paragraph / key-value / table), each a recognized
 * region of the page, and then serializes them to Markdown. We analyze every
 * text field of every block, and the redacted page is re-rendered from the
 * redacted blocks with the pipeline's own serializer - so a finding only ever
 * affects the field it was found in, and the page keeps its exact structure.
 *
 * STORE THE EVIDENCE, DERIVE THE OUTCOME. Analysis records every candidate
 * span it found - unfiltered by entity type, down to a low score floor - and
 * the user's decisions are kept separately as overrides. Which spans are
 * actually redacted is computed on demand from:
 *
 *     spans matching the enabled entity types and score threshold
 *   - spans the user dismissed          (overrides.off)
 *   + spans the user added by hand      (overrides.on)
 *
 * That is what makes the entity toggles and the score slider live: changing
 * them re-filters stored data instead of re-calling Presidio, so it is
 * instant, works offline, and stays consistent for documents analyzed weeks
 * ago. It also means the redacted text is never stored, so it can never go
 * stale relative to the current settings.
 *
 * Substitution is a local splice with a fixed `[REDACTED]` placeholder -
 * identical to what Presidio's anonymizer `replace` operator would return, but
 * without a network round-trip per field on every export.
 *
 * Only text is redacted; page images are left untouched, since the text is the
 * only thing that gets exported.
 */
import { analyze, CANDIDATE_SCORE_FLOOR, REDACTION_PLACEHOLDER } from './presidio.js';
import { renderMarkdown } from '../ocr/structure/blocks.ts';
import { getCachedSettings } from '../core/settings.js';

/** Analyze at most this many distinct field texts concurrently. */
const CONCURRENCY = 4;

/** Marks the single unit used when a page has no block structure to work with. */
export const PAGE_UNIT_PATH = ['__page__'];

/** Entity type recorded for a span the user added by hand. */
export const MANUAL_ENTITY = 'MANUAL';

/** Stable identifier for one analyzed unit of text. */
export function unitKey(blockIndex, path) {
    return `${blockIndex}:${path.join('.')}`;
}

// ---------------------------------------------------------------- block I/O

/**
 * Every de-identifiable text field of a block, as {path, text} pairs.
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

// ---------------------------------------------------------------- analysis

const normalizeSpans = (spans) =>
    (spans || [])
        .map((s) => ({ start: s.start, end: s.end, entityType: s.entity_type, score: s.score }))
        .filter((s) => s.end > s.start)
        .sort((a, b) => a.start - b.start || a.end - b.end);

/**
 * Analyze one page and record every candidate PII span.
 *
 * @param {object} ocrPage  a record from the ocrPages store (markdown, blocks)
 * @param {object} opts     { base, signal }
 * @returns {Promise<{schema: 2, at: number, units: Array, overrides: {off: Array, on: Array}}>}
 */
export async function deidentifyPage(ocrPage, opts = {}) {
    const { base, signal } = opts;
    const blocks = Array.isArray(ocrPage?.blocks) ? ocrPage.blocks : [];
    const markdown = ocrPage?.markdown || '';

    // Deliberately unfiltered: no `entities`, and only the storage floor for a
    // threshold. Filtering happens at render time (see effectiveSpans).
    const runAnalysis = (text) =>
        analyze(text, { base, scoreThreshold: CANDIDATE_SCORE_FLOOR, signal });

    const empty = { schema: 2, at: Date.now(), units: [], overrides: { off: [], on: [] } };

    // A page with no usable block structure - an older record, a pipeline that
    // returned none, or a page whose text has since been hand-edited - is
    // still de-identified, as one unit covering the whole markdown.
    if (!blocks.length) {
        if (!markdown.trim()) return empty;
        return {
            ...empty,
            units: [{
                blockIndex: -1,
                path: PAGE_UNIT_PATH,
                text: markdown,
                spans: normalizeSpans(await runAnalysis(markdown)),
            }],
        };
    }

    const fields = blocks.flatMap((block, blockIndex) =>
        blockFields(block)
            .filter((f) => f.text.trim().length > 0)
            .map((f) => ({ ...f, blockIndex })),
    );
    if (!fields.length) return empty;

    // De-duplicate by text so a value repeated across cells costs one call.
    const uniqueTexts = [...new Set(fields.map((f) => f.text))];
    const spansByText = new Map();
    await mapWithConcurrency(uniqueTexts, CONCURRENCY, async (text) => {
        spansByText.set(text, normalizeSpans(await runAnalysis(text)));
    });

    return {
        ...empty,
        units: fields.map((f) => ({
            blockIndex: f.blockIndex,
            path: f.path,
            text: f.text,
            spans: spansByText.get(f.text) || [],
        })),
    };
}

/**
 * Carry a page's redactions across a manual text edit.
 *
 * Automatic detection is a ONE-TIME proposal: it runs after OCR and never
 * again on its own. Re-analyzing after an edit would resurrect spans the user
 * dismissed and discard the ones they added, so instead we re-anchor what is
 * already there - no Presidio call involved.
 *
 * Offsets cannot survive an edit, so each span is relocated by its TEXT. The
 * edit also invalidates the block structure the per-field units were built
 * from (the editor works on the whole page's Markdown), so everything
 * collapses into a single page-level unit over the new text.
 *
 * A span whose text no longer appears - because that is precisely what was
 * edited - cannot be relocated and is dropped; `lost` reports how many, so the
 * caller can say so rather than let a redaction vanish silently.
 *
 * @returns {{deid: object, lost: number}}
 */
export function reanchorAfterEdit(deid, newText) {
    const text = newText || '';
    const key = unitKey(-1, PAGE_UNIT_PATH);
    const empty = { schema: 2, at: deid?.at || Date.now(), units: [], overrides: { off: [], on: [] } };
    if (!isCurrentSchema(deid)) return { deid: empty, lost: 0 };
    if (!text.trim()) return { deid: empty, lost: 0 };

    const spans = [];
    const off = [];
    let lost = 0;
    for (const unit of deid.units || []) {
        const unitK = unitKey(unit.blockIndex, unit.path);
        const dismissedIds = new Set(
            (deid.overrides?.off || []).filter((o) => o.key === unitK).map(spanId),
        );
        for (const s of unit.spans || []) {
            const spanText = unit.text.slice(s.start, s.end);
            const found = occurrencesOf(text, spanText);
            if (!found.length) { lost++; continue; }
            // Every occurrence is taken: after an edit we can no longer tell
            // which one the analyzer meant, and redacting them all is the safe
            // direction.
            const wasDismissed = dismissedIds.has(spanId(s));
            for (const at of found) {
                spans.push({ ...at, entityType: s.entityType, score: s.score });
                if (wasDismissed) off.push({ key, start: at.start, end: at.end });
            }
        }
    }

    const seen = new Set();
    const unique = spans
        .filter((s) => {
            const id = `${s.start}:${s.end}:${s.entityType}`;
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        })
        .sort((a, b) => a.start - b.start || a.end - b.end);

    const seenOff = new Set();
    const uniqueOff = off.filter((o) => {
        const id = spanId(o);
        if (seenOff.has(id)) return false;
        seenOff.add(id);
        return true;
    });

    // Manual redactions are text-anchored already; only their unit changes.
    const seenOn = new Set();
    const on = (deid.overrides?.on || [])
        .filter((o) => o.text && !seenOn.has(o.text) && seenOn.add(o.text) !== undefined)
        .map((o) => ({ key, text: o.text }));

    return {
        deid: {
            schema: 2,
            at: deid.at,
            units: [{ blockIndex: -1, path: PAGE_UNIT_PATH, text, spans: unique }],
            overrides: { off: uniqueOff, on },
        },
        lost,
    };
}

// ---------------------------------------------------------------- derivation

const isPageUnit = (unit) => unit.path?.[0] === PAGE_UNIT_PATH[0];

/** True for the current (evidence-based) storage shape. Older records stored
 *  only a finished redacted string and are re-analyzed on open. */
export function isCurrentSchema(deid) {
    return !!deid && deid.schema === 2 && Array.isArray(deid.units);
}

const spanId = (s) => `${s.start}:${s.end}`;

/**
 * Which spans of one unit are actually redacted, and which the user dismissed.
 *
 * Overlapping spans are merged - the analyzer routinely returns nested hits
 * (a LOCATION covering an address that also contains a UK_POSTCODE), and
 * substituting both would double-replace.
 *
 * @returns {{enabled: Array, dismissed: Array}} both sorted, non-overlapping
 */
export function effectiveSpans(deid, unit, settings = getCachedSettings()) {
    const key = unitKey(unit.blockIndex, unit.path);
    const overrides = deid.overrides || { off: [], on: [] };
    const off = new Set((overrides.off || []).filter((o) => o.key === key).map(spanId));
    const wanted = settings.deidEntities || [];
    const threshold = Number(settings.deidScoreThreshold) || 0;

    const passesFilter = (s) =>
        (!wanted.length || wanted.includes(s.entityType)) && s.score >= threshold;

    const enabled = [];
    const dismissed = [];
    for (const s of unit.spans || []) {
        if (!passesFilter(s)) continue;
        (off.has(spanId(s)) ? dismissed : enabled).push(s);
    }
    // Manual redactions are anchored by TEXT, not offsets: the user selected
    // something in the rendered view, where markdown decoration means DOM
    // positions don't line up with source offsets. Matching the string inside
    // its own unit avoids that mapping entirely, and redacting every
    // occurrence within the unit is the expected reading of "redact this".
    for (const o of overrides.on || []) {
        if (o.key !== key || !o.text) continue;
        for (const at of occurrencesOf(unit.text, o.text)) {
            enabled.push({ ...at, entityType: MANUAL_ENTITY, score: 1 });
        }
    }
    return { enabled: mergeSpans(enabled), dismissed: mergeSpans(dismissed) };
}

/** Every non-overlapping occurrence of `needle` in `text`. */
function occurrencesOf(text, needle) {
    const out = [];
    if (!needle) return out;
    let i = text.indexOf(needle);
    while (i !== -1) {
        out.push({ start: i, end: i + needle.length });
        i = text.indexOf(needle, i + needle.length);
    }
    return out;
}

/** Merge overlapping/touching spans, keeping the contributing entity types. */
function mergeSpans(spans) {
    const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
    const out = [];
    for (const s of sorted) {
        const last = out[out.length - 1];
        if (last && s.start <= last.end) {
            last.end = Math.max(last.end, s.end);
            if (!last.entityTypes.includes(s.entityType)) last.entityTypes.push(s.entityType);
            last.score = Math.max(last.score, s.score);
        } else {
            out.push({ start: s.start, end: s.end, entityTypes: [s.entityType], score: s.score });
        }
    }
    return out;
}

/** Replace each span with `placeholder`, right to left so offsets hold. */
function applySpans(text, spans, placeholder = REDACTION_PLACEHOLDER) {
    let out = text;
    for (let i = spans.length - 1; i >= 0; i--) {
        out = out.slice(0, spans[i].start) + placeholder + out.slice(spans[i].end);
    }
    return out;
}

/**
 * Rebuild a page's text with every enabled redaction applied, using `transform`
 * to decide what each redacted span becomes. Shared by the export path (which
 * substitutes the placeholder) and the review pane (which marks spans up for
 * highlighting instead).
 */
function buildPageText(ocrPage, transform) {
    const deid = ocrPage?.deid;
    const original = ocrPage?.markdown || '';
    if (!isCurrentSchema(deid) || !deid.units.length) return original;
    const settings = getCachedSettings();

    const pageUnit = deid.units.find(isPageUnit);
    if (pageUnit) return transform(pageUnit, settings);

    let blocks = Array.isArray(ocrPage.blocks) ? ocrPage.blocks : [];
    if (!blocks.length) return original;
    let touched = false;
    for (const unit of deid.units) {
        const next = transform(unit, settings);
        if (next === unit.text) continue;
        touched = true;
        blocks = blocks.map((b, i) => (i === unit.blockIndex ? withField(b, unit.path, next) : b));
    }
    if (!touched) return original;
    return renderMarkdown({ blocks, width: ocrPage.width, height: ocrPage.height });
}

/**
 * The text of a page that is allowed to leave the browser - redacted when
 * de-identification has run, otherwise the raw OCR text. Every consumer that
 * exports text or sends it to an LLM must go through this, so a de-identified
 * document can never leak its original PII.
 *
 * Derived on demand, so it always reflects the current entity selection,
 * score threshold and manual edits.
 */
export function pageOutputText(ocrPage) {
    const deid = ocrPage?.deid;
    // Legacy records stored the finished string; honour it until re-analyzed.
    if (deid && !isCurrentSchema(deid)) return deid.markdown ?? ocrPage?.markdown ?? '';
    return buildPageText(ocrPage, (unit, settings) => {
        const { enabled } = effectiveSpans(deid, unit, settings);
        return enabled.length ? applySpans(unit.text, enabled) : unit.text;
    });
}

// ------------------------------------------------------- user overrides
// All four mutate `deid` in place and return it; the caller persists the
// page record afterwards. Redactions are re-derived from the result, so no
// redacted text needs rewriting.

/** Find the analyzed unit a key refers to. */
function findUnit(deid, key) {
    return (deid.units || []).find((u) => unitKey(u.blockIndex, u.path) === key) || null;
}

function ensureOverrides(deid) {
    if (!deid.overrides) deid.overrides = { off: [], on: [] };
    if (!deid.overrides.off) deid.overrides.off = [];
    if (!deid.overrides.on) deid.overrides.on = [];
    return deid.overrides;
}

/** Stop redacting everything in [start, end) of a unit - the user's "this is
 *  not personal information after all". Auto spans are remembered as dismissed
 *  (so they can be shown as a faint outline and restored); manual ones are
 *  simply dropped. */
export function dismissRange(deid, key, start, end) {
    const unit = findUnit(deid, key);
    if (!unit) return deid;
    const overrides = ensureOverrides(deid);
    overrides.on = overrides.on.filter((o) =>
        o.key !== key || !occurrencesOf(unit.text, o.text).some((oc) => oc.start < end && start < oc.end),
    );
    for (const s of unit.spans || []) {
        if (s.start >= end || start >= s.end) continue;
        if (!overrides.off.some((o) => o.key === key && o.start === s.start && o.end === s.end)) {
            overrides.off.push({ key, start: s.start, end: s.end });
        }
    }
    return deid;
}

/** Undo a dismissal, putting the auto spans in [start, end) back into effect. */
export function restoreRange(deid, key, start, end) {
    const overrides = ensureOverrides(deid);
    overrides.off = overrides.off.filter((o) => !(o.key === key && o.start < end && start < o.end));
    return deid;
}

/** Redact a piece of text the analyzer missed, anchored by string within its
 *  unit (see effectiveSpans for why text rather than offsets). */
export function addManualRedaction(deid, key, text) {
    const value = (text || '').trim();
    if (!value) return deid;
    const overrides = ensureOverrides(deid);
    if (!overrides.on.some((o) => o.key === key && o.text === value)) {
        overrides.on.push({ key, text: value });
    }
    return deid;
}

/** Drop every manual decision, returning the page to what Presidio proposed. */
export function resetOverrides(deid) {
    deid.overrides = { off: [], on: [] };
    return deid;
}

/** True when the user has made any manual redaction decision on this page. */
export function hasOverrides(deid) {
    if (!isCurrentSchema(deid)) return false;
    const o = deid.overrides || {};
    return !!((o.off && o.off.length) || (o.on && o.on.length));
}

/** Count of spans currently redacted across a page (for badges). */
export function redactionCount(ocrPage) {
    const deid = ocrPage?.deid;
    if (!isCurrentSchema(deid)) return 0;
    const settings = getCachedSettings();
    return deid.units.reduce((n, u) => n + effectiveSpans(deid, u, settings).enabled.length, 0);
}

/** Entity-type tally of the currently redacted spans, e.g. {PERSON: 3}. */
export function redactionSummary(ocrPage) {
    const deid = ocrPage?.deid;
    const tally = {};
    if (!isCurrentSchema(deid)) return tally;
    const settings = getCachedSettings();
    for (const unit of deid.units) {
        for (const span of effectiveSpans(deid, unit, settings).enabled) {
            for (const t of span.entityTypes) tally[t] = (tally[t] || 0) + 1;
        }
    }
    return tally;
}

export { applySpans, buildPageText, isPageUnit, mergeSpans };
