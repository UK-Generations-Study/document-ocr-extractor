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
 *   - spans the user dismissed          (overrides.off, overrides.offText)
 *   + spans the user added by hand      (overrides.on, and manual unit spans)
 *
 * That is what makes the entity toggles and the score slider live: changing
 * them re-filters stored data instead of re-calling Presidio, so it is
 * instant, works offline, and stays consistent for documents analyzed weeks
 * ago. It also means the redacted text is never stored, so it can never go
 * stale relative to the current settings.
 *
 * EVERY SPAN HAS AN ID. A redaction is a thing, not a position: its identity
 * does not depend on where it sits or what it says. That is what lets a
 * dismissal survive an edit (it names a span, not a range), and what lets two
 * identical strings on the same page be redacted independently.
 *
 * HOW FAR A MANUAL REDACTION REACHES is decided by WHERE IT IS STORED, so
 * there is no scope flag to interpret and no way for the two to disagree:
 *
 *   overrides.on   {id, text}   redact this string everywhere in the report.
 *                               Text-anchored, replicated onto every page by
 *                               the caller, and immune to edits by nature.
 *   unit.spans     {manual:true} redact THIS occurrence and no other. Stored
 *                               as an ordinary span - same shape as anything
 *                               Presidio found, exempt from the entity/score
 *                               filter - so it is carried across edits by the
 *                               same machinery, with no special case.
 *
 * The dismissals mirror that pairing exactly: overrides.off names spans by id
 * (this one, here), overrides.offText names a string (this text, anywhere in
 * the report).
 *
 * Substitution is a local splice with a fixed `[REDACTED]` placeholder -
 * identical to what Presidio's anonymizer `replace` operator would return, but
 * without a network round-trip per field on every export.
 *
 * Only text is redacted; page images are left untouched, since the text is the
 * only thing that gets exported.
 */
import { analyze, CANDIDATE_SCORE_FLOOR, REDACTION_PLACEHOLDER } from './presidio.js';
import { mapSpan, matchedRuns } from './textDiff.js';
import { renderMarkdown } from '../ocr/structure/blocks.ts';
import { getCachedSettings } from '../core/settings.js';

/** Analyze at most this many distinct field texts concurrently. */
const CONCURRENCY = 4;

/** Marks the single unit used when a page has no block structure to work with. */
export const PAGE_UNIT_PATH = ['__page__'];

/** Entity type recorded for a span the user added by hand. */
export const MANUAL_ENTITY = 'MANUAL';

/** Current storage shape. See the header for what changed and why. */
const SCHEMA = 3;

/** Stable identifier for one analyzed unit of text. */
export function unitKey(blockIndex, path) {
    return `${blockIndex}:${path.join('.')}`;
}

/** Identity for one redaction, stable for the life of the record. */
const newId = () => crypto.randomUUID();

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

/** Fresh copy of a span list with an id on each. Analysis de-duplicates by
 *  text, so several units can be handed the same result array - they must not
 *  end up sharing span objects, or sharing ids. */
const withIds = (spans) => (spans || []).map((s) => ({ ...s, id: newId() }));

const emptyDeid = () => ({
    schema: SCHEMA,
    at: Date.now(),
    units: [],
    overrides: { off: [], offText: [], on: [] },
});

/**
 * Analyze one page and record every candidate PII span.
 *
 * @param {object} ocrPage  a record from the ocrPages store (markdown, blocks)
 * @param {object} opts     { base, signal }
 * @returns {Promise<object>} a schema-3 deid record
 */
export async function deidentifyPage(ocrPage, opts = {}) {
    const { base, signal } = opts;
    const blocks = Array.isArray(ocrPage?.blocks) ? ocrPage.blocks : [];
    const markdown = ocrPage?.markdown || '';

    // Deliberately unfiltered: no `entities`, and only the storage floor for a
    // threshold. Filtering happens at render time (see effectiveSpans).
    const runAnalysis = (text) =>
        analyze(text, { base, scoreThreshold: CANDIDATE_SCORE_FLOOR, signal });

    const empty = emptyDeid();

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
                spans: withIds(normalizeSpans(await runAnalysis(markdown))),
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
            spans: withIds(spansByText.get(f.text)),
        })),
    };
}

// ---------------------------------------------------------------- migration

/**
 * Bring a stored record up to the current shape, or null if it holds no usable
 * evidence.
 *
 * Schema 2 kept the same evidence but identified spans by position: a
 * dismissal was `{key, start, end}` and a manual redaction was a bare `{text}`.
 * Both convert without loss - assign ids, then re-point the dismissals at them
 * - so nobody's review decisions are thrown away by the upgrade.
 *
 * Returns the SAME object when it is already current, so callers can normalize
 * freely without churning garbage.
 */
export function normalizeDeid(deid) {
    if (!deid || !Array.isArray(deid.units)) return null;
    if (deid.schema === SCHEMA) {
        const o = deid.overrides;
        if (o && Array.isArray(o.off) && Array.isArray(o.offText) && Array.isArray(o.on)) return deid;
        deid.overrides = {
            off: o?.off || [],
            offText: o?.offText || [],
            on: o?.on || [],
        };
        return deid;
    }
    if (deid.schema !== 2) return null;

    const units = deid.units.map((u) => ({ ...u, spans: withIds(u.spans) }));
    const off = [];
    for (const o of deid.overrides?.off || []) {
        const unit = units.find((u) => unitKey(u.blockIndex, u.path) === o.key);
        const span = (unit?.spans || []).find((s) => s.start === o.start && s.end === o.end);
        if (span) off.push({ id: span.id });
    }
    const on = (deid.overrides?.on || [])
        .filter((o) => o.text)
        .map((o) => ({ id: newId(), text: o.text }));
    return { schema: SCHEMA, at: deid.at || Date.now(), units, overrides: { off, offText: [], on } };
}

// ---------------------------------------------------------------- edits

/**
 * Carry a page's redactions across a manual text edit.
 *
 * Automatic detection is a ONE-TIME proposal: it runs after OCR and never
 * again on its own. Re-analyzing after an edit would resurrect spans the user
 * dismissed and discard the ones they added, so instead we carry what is
 * already there across the change - no Presidio call involved.
 *
 * Offsets are MAPPED THROUGH THE EDIT rather than re-derived from it: a diff
 * says which characters survived and where they moved, and each span follows
 * its own characters (see textDiff.js). Nothing is matched by string, so two
 * identical values stay independent and a span is only ever lost when the text
 * under it was genuinely deleted - in which case there is nothing left to
 * redact. Dismissals name spans by id, so they need no mapping at all.
 *
 * The edit does invalidate the block structure the per-field units were built
 * from - the editor works on the whole page's Markdown - so everything
 * collapses into a single page-level unit over the new text.
 */
export function reanchorAfterEdit(ocrPage, deid, newText) {
    const text = newText || '';
    const current = normalizeDeid(deid);
    if (!current) return emptyDeid();

    // Document-wide overrides describe the report, not this page's text, so
    // they survive verbatim even when the page is emptied.
    const overrides = {
        off: [...(current.overrides.off || [])],
        offText: [...(current.overrides.offText || [])],
        on: [...(current.overrides.on || [])],
    };
    if (!text.trim()) return { ...emptyDeid(), at: current.at, overrides };

    const { text: oldText, offsets } = flattenUnits(ocrPage, current);
    const runs = matchedRuns(oldText, text);

    const spans = [];
    for (const unit of current.units) {
        const base = offsets.get(unitKey(unit.blockIndex, unit.path));
        if (base === undefined) continue;
        for (const s of unit.spans || []) {
            const at = mapSpan(runs, base + s.start, base + s.end);
            if (!at) continue; // its text was deleted - nothing left to redact
            spans.push({ ...s, start: at.start, end: at.end });
        }
    }
    spans.sort((a, b) => a.start - b.start || a.end - b.end);

    const live = new Set(spans.map((s) => s.id));
    return {
        schema: SCHEMA,
        at: current.at,
        units: [{ blockIndex: -1, path: PAGE_UNIT_PATH, text, spans }],
        overrides: { ...overrides, off: overrides.off.filter((o) => live.has(o.id)) },
    };
}

/**
 * The page's units laid end to end in page-text coordinates: the text every
 * span offset should be read against, plus where each unit starts within it.
 *
 * After any edit there is a single page-level unit and this is trivial. Before
 * one, spans are relative to individual block fields, which have to be located
 * inside the page's Markdown. That lookup is exact rather than a guess:
 * renderMarkdown interpolates field text verbatim (`## ${text}`, `| ${cell} |`),
 * so every unit's text appears in the page character for character, and in
 * block order - which is why the cursor only ever moves forward, keeping two
 * fields that happen to hold the same value from resolving to the same place.
 */
function flattenUnits(ocrPage, deid) {
    const pageUnit = (deid.units || []).find(isPageUnit);
    if (pageUnit) {
        return {
            text: pageUnit.text,
            offsets: new Map([[unitKey(pageUnit.blockIndex, pageUnit.path), 0]]),
        };
    }
    const text = ocrPage?.markdown || '';
    const offsets = new Map();
    let cursor = 0;
    for (const unit of deid.units || []) {
        let at = text.indexOf(unit.text, cursor);
        if (at === -1) at = text.indexOf(unit.text); // reordered somehow; take the first
        if (at === -1) continue;                     // not in the page at all; its spans drop
        offsets.set(unitKey(unit.blockIndex, unit.path), at);
        cursor = at + unit.text.length;
    }
    return { text, offsets };
}

// ---------------------------------------------------------------- derivation

const isPageUnit = (unit) => unit.path?.[0] === PAGE_UNIT_PATH[0];

/** True for a record holding usable evidence - current shape or upgradable.
 *  Older records stored only a finished redacted string and are honoured as-is. */
export function isCurrentSchema(deid) {
    return !!deid && Array.isArray(deid.units) && (deid.schema === SCHEMA || deid.schema === 2);
}

/**
 * Which spans of one unit are actually redacted, and which the user dismissed.
 *
 * Overlapping spans are merged - the analyzer routinely returns nested hits
 * (a LOCATION covering an address that also contains a UK_POSTCODE), and
 * substituting both would double-replace. The merged result keeps the ids and
 * the reach of everything that went into it, because one veil on screen can be
 * several redactions underneath and an action on it has to address them all.
 *
 * @returns {{enabled: Array, dismissed: Array}} both sorted, non-overlapping
 */
export function effectiveSpans(deid, unit, settings = getCachedSettings()) {
    const overrides = deid.overrides || {};
    const off = new Set((overrides.off || []).map((o) => o.id));
    const offText = new Set((overrides.offText || []).map((o) => o.text).filter(Boolean));
    const wanted = settings.deidEntities || [];
    const threshold = Number(settings.deidScoreThreshold) || 0;

    // A hand-placed span is a decision, not a detection: the entity toggles and
    // the score slider filter what Presidio proposed, and must not silently
    // discard what the user asked for.
    const passesFilter = (s) =>
        s.manual || ((!wanted.length || wanted.includes(s.entityType)) && s.score >= threshold);

    const enabled = [];
    const dismissed = [];
    for (const s of unit.spans || []) {
        if (!passesFilter(s)) continue;
        const lifted = off.has(s.id) || offText.has(unit.text.slice(s.start, s.end));
        const entry = { ...s, source: s.manual ? 'instance' : 'auto' };
        (lifted ? dismissed : enabled).push(entry);
    }

    // Document-wide manual redactions are anchored by TEXT, not offsets: the
    // user selected something in a rendered view, where markdown decoration
    // means DOM positions don't line up with source offsets. Matching the
    // string avoids that mapping entirely - and is what "everywhere" means.
    // The caller applies each entry to every page of the document; here it
    // applies to every occurrence in this unit.
    for (const o of overrides.on || []) {
        if (!o.text) continue;
        for (const at of occurrencesOf(unit.text, o.text)) {
            enabled.push({ ...at, id: o.id, entityType: MANUAL_ENTITY, score: 1, source: 'doc' });
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

/** Merge overlapping/touching spans, keeping what each one contributed. */
function mergeSpans(spans) {
    const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
    const out = [];
    for (const s of sorted) {
        const source = s.source || 'auto';
        const last = out[out.length - 1];
        if (last && s.start <= last.end) {
            last.end = Math.max(last.end, s.end);
            if (!last.entityTypes.includes(s.entityType)) last.entityTypes.push(s.entityType);
            if (!last.sources.includes(source)) last.sources.push(source);
            if (s.id && !last.ids.includes(s.id)) last.ids.push(s.id);
            last.score = Math.max(last.score, s.score);
        } else {
            out.push({
                start: s.start,
                end: s.end,
                entityTypes: [s.entityType],
                sources: [source],
                ids: s.id ? [s.id] : [],
                score: s.score,
            });
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
    const deid = normalizeDeid(ocrPage?.deid);
    const original = ocrPage?.markdown || '';
    if (!deid || !deid.units.length) return original;
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
    const normalized = normalizeDeid(deid);
    return buildPageText(ocrPage, (unit, settings) => {
        const { enabled } = effectiveSpans(normalized, unit, settings);
        return enabled.length ? applySpans(unit.text, enabled) : unit.text;
    });
}

// ------------------------------------------------------- user overrides
// These mutate `deid` in place and return it; the caller persists the page
// record afterwards. Redactions are re-derived from the result, so no redacted
// text needs rewriting.
//
// Each pair is "here" / "everywhere in this report". The everywhere half only
// ever touches this page's copy - the caller replays it onto the others.

/** Find the analyzed unit a key refers to. */
function findUnit(deid, key) {
    return (deid.units || []).find((u) => unitKey(u.blockIndex, u.path) === key) || null;
}

function ensureOverrides(deid) {
    if (!deid.overrides) deid.overrides = { off: [], offText: [], on: [] };
    if (!deid.overrides.off) deid.overrides.off = [];
    if (!deid.overrides.offText) deid.overrides.offText = [];
    if (!deid.overrides.on) deid.overrides.on = [];
    return deid.overrides;
}

/**
 * What a veil is actually made of, so the UI can offer actions that match.
 *
 * One veil can be several redactions at once - an automatic hit the user then
 * extended by hand, say - and the reach of each half differs, so they are
 * reported separately rather than flattened.
 *
 * @returns {{text: string, autoIds: string[], instanceIds: string[], docTexts: string[]}}
 */
export function markComposition(deid, key, start, end) {
    const out = { text: '', autoIds: [], instanceIds: [], docTexts: [] };
    const unit = findUnit(deid, key);
    if (!unit) return out;
    out.text = unit.text.slice(start, end);
    for (const s of unit.spans || []) {
        if (s.start >= end || start >= s.end) continue;
        (s.manual ? out.instanceIds : out.autoIds).push(s.id);
    }
    for (const o of deid.overrides?.on || []) {
        if (!o.text) continue;
        const hit = occurrencesOf(unit.text, o.text).some((oc) => oc.start < end && start < oc.end);
        if (hit && !out.docTexts.includes(o.text)) out.docTexts.push(o.text);
    }
    return out;
}

/** Redact one occurrence and no other, as a span of its own unit. */
export function redactInstance(deid, key, start, end) {
    const unit = findUnit(deid, key);
    if (!unit || end <= start) return deid;
    ensureOverrides(deid);
    const text = unit.text.slice(start, end);
    // An identical instance span already here would render as one veil anyway.
    const already = (unit.spans || []).some((s) => s.manual && s.start === start && s.end === end);
    if (already) return deid;
    // A dismissal of this exact text, made "everywhere", would immediately undo
    // what is being asked for here.
    deid.overrides.offText = deid.overrides.offText.filter((o) => o.text !== text);
    unit.spans = [...(unit.spans || []), {
        id: newId(), start, end, entityType: MANUAL_ENTITY, score: 1, manual: true,
    }];
    unit.spans.sort((a, b) => a.start - b.start || a.end - b.end);
    return deid;
}

/**
 * ONE PLACE ON A PAGE IS NAMED BY AN OCCURRENCE INDEX - the nth appearance of
 * a string, counting across the page's units in order.
 *
 * Offsets cannot cross the gap between the pane and the record: the rendered
 * view has dropped the Markdown syntax that source offsets are measured
 * against, so a DOM position there means nothing here. What the pane CAN say
 * is which occurrence of a string the user picked, by counting the ones above
 * it - and an index survives the round trip intact.
 *
 * Both directions are checked against the stored text rather than trusted, so
 * a caller that has drifted out of step is told so and can fall back to acting
 * on the whole report, instead of quietly veiling the wrong words.
 */

/** Which occurrence of `text` the span at [start, end) of a unit is. -1 if the
 *  range does not line up with an occurrence at all. */
export function occurrenceIndexInPage(deid, key, start, end, text) {
    if (!text) return -1;
    let index = 0;
    for (const unit of deid.units || []) {
        const here = unitKey(unit.blockIndex, unit.path) === key;
        for (const at of occurrencesOf(unit.text, text)) {
            if (here && at.start < end && start < at.end) return index;
            index++;
        }
    }
    return -1;
}

/** Redact the `index`th occurrence of `text` on this page and no other.
 *  @returns {boolean} whether that occurrence existed */
export function redactNthOccurrenceInPage(deid, index, text) {
    if (!text || index < 0) return false;
    let n = 0;
    for (const unit of deid.units || []) {
        for (const at of occurrencesOf(unit.text, text)) {
            if (n++ !== index) continue;
            redactInstance(deid, unitKey(unit.blockIndex, unit.path), at.start, at.end);
            return true;
        }
    }
    return false;
}

/** Redact a string everywhere in the report - the caller replays this onto
 *  every page. Anchored by text rather than offset (see effectiveSpans). */
export function addManualRedaction(deid, text) {
    const value = (text || '').trim();
    if (!value) return deid;
    const overrides = ensureOverrides(deid);
    overrides.offText = overrides.offText.filter((o) => o.text !== value);
    if (!overrides.on.some((o) => o.text === value)) overrides.on.push({ id: newId(), text: value });
    return deid;
}

/** Stop redacting a string that was redacted everywhere. */
export function removeManualRedaction(deid, text) {
    if (!text) return deid;
    const overrides = ensureOverrides(deid);
    overrides.on = overrides.on.filter((o) => o.text !== text);
    return deid;
}

/** Stop redacting particular spans, remembering the decision so the veil can
 *  be shown as a faint outline and restored rather than vanishing silently.
 *  Hand-placed instance spans are deleted outright instead - they exist only
 *  because the user asked for them, so there is no proposal left to dissent
 *  from once that is withdrawn. */
export function dismissSpans(deid, ids) {
    const wanted = new Set(ids || []);
    if (!wanted.size) return deid;
    const overrides = ensureOverrides(deid);
    for (const unit of deid.units || []) {
        for (const s of unit.spans || []) {
            if (!wanted.has(s.id)) continue;
            if (s.manual) continue;
            if (!overrides.off.some((o) => o.id === s.id)) overrides.off.push({ id: s.id });
        }
        unit.spans = (unit.spans || []).filter((s) => !(s.manual && wanted.has(s.id)));
    }
    return deid;
}

/** Undo a dismissal, putting those spans back into effect. */
export function restoreSpans(deid, ids) {
    const wanted = new Set(ids || []);
    if (!wanted.size) return deid;
    const overrides = ensureOverrides(deid);
    overrides.off = overrides.off.filter((o) => !wanted.has(o.id));
    return deid;
}

/** Stop redacting every span whose text matches, anywhere in the report - the
 *  caller replays this onto every page. The counterpart of addManualRedaction:
 *  same reach, opposite direction. */
export function dismissTextEverywhere(deid, text) {
    const value = text || '';
    if (!value) return deid;
    const overrides = ensureOverrides(deid);
    // Lifting a string everywhere has to withdraw the request to redact it
    // everywhere, or the two would sit in the record contradicting each other.
    overrides.on = overrides.on.filter((o) => o.text !== value);
    if (!overrides.offText.some((o) => o.text === value)) overrides.offText.push({ text: value });
    return deid;
}

/** Undo a document-wide dismissal. */
export function restoreTextEverywhere(deid, text) {
    if (!text) return deid;
    const overrides = ensureOverrides(deid);
    overrides.offText = overrides.offText.filter((o) => o.text !== text);
    return deid;
}

/** Drop every manual decision, returning the page to what Presidio proposed. */
export function resetOverrides(deid) {
    deid.overrides = { off: [], offText: [], on: [] };
    for (const unit of deid.units || []) {
        unit.spans = (unit.spans || []).filter((s) => !s.manual);
    }
    return deid;
}

/** True when the user has made any redaction decision on this page. */
export function hasOverrides(deid) {
    const d = normalizeDeid(deid);
    if (!d) return false;
    const o = d.overrides;
    if (o.off.length || o.offText.length || o.on.length) return true;
    return d.units.some((u) => (u.spans || []).some((s) => s.manual));
}

/** Whether a string appears in any analyzed unit of this page. A selection can
 *  run across unit boundaries or over Markdown syntax, and such a string
 *  matches nothing - worth telling the user rather than appearing to do
 *  nothing at all. */
export function textOccursInPage(deid, text) {
    const d = normalizeDeid(deid);
    if (!d || !text) return false;
    return d.units.some((u) => u.text.includes(text));
}

/** How many times a string occurs across this page's analyzed text. Summed
 *  over pages, this is what tells the user whether "everywhere" differs from
 *  "here" before they choose. */
export function countOccurrences(deid, text) {
    const d = normalizeDeid(deid);
    if (!d || !text) return 0;
    return d.units.reduce((n, u) => n + occurrencesOf(u.text, text).length, 0);
}

/** Count of spans currently redacted across a page (for badges). */
export function redactionCount(ocrPage) {
    const deid = normalizeDeid(ocrPage?.deid);
    if (!deid) return 0;
    const settings = getCachedSettings();
    return deid.units.reduce((n, u) => n + effectiveSpans(deid, u, settings).enabled.length, 0);
}

/** Entity-type tally of the currently redacted spans, e.g. {PERSON: 3}. */
export function redactionSummary(ocrPage) {
    const deid = normalizeDeid(ocrPage?.deid);
    const tally = {};
    if (!deid) return tally;
    const settings = getCachedSettings();
    for (const unit of deid.units) {
        for (const span of effectiveSpans(deid, unit, settings).enabled) {
            for (const t of span.entityTypes) tally[t] = (tally[t] || 0) + 1;
        }
    }
    return tally;
}

export { applySpans, buildPageText, isPageUnit, mergeSpans, occurrencesOf };
