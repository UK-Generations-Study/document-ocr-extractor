/**
 * Turning redaction spans into something the rendered Markdown view can show.
 *
 * The review pane displays the ORIGINAL text with a translucent veil over the
 * spans that will be redacted on export, so the abstractor can read what is
 * being removed and correct it. That means we need character-accurate
 * highlights inside HTML produced by micromark - and mapping source offsets
 * onto rendered HTML is unreliable, because Markdown syntax (`**`, `|`, `#`)
 * doesn't survive into the output.
 *
 * Instead we insert PRIVATE-USE sentinel characters into the text *before*
 * Markdown rendering, then convert them to elements in a DOM pass afterwards.
 * Sentinels are inert plain text as far as Markdown is concerned, so they
 * carry the mapping through the renderer untouched. U+E000..U+E005 are in the
 * Unicode Private Use Area and will never occur in OCR output.
 *
 * Two kinds of marker are inserted:
 *   unit    wraps one analyzed unit of text (a block field, or the whole page)
 *           so a text selection can be attributed back to it;
 *   mark    wraps one redaction span, enabled (veiled) or dismissed (outlined).
 */
import {
    buildPageText,
    effectiveSpans,
    normalizeDeid,
    unitKey,
} from './deidentify.js';

const MARK_OPEN = '';
const MARK_SEP = '';
const MARK_CLOSE = '';
const UNIT_OPEN = '';
const UNIT_SEP = '';
const UNIT_CLOSE = '';

/** Any sentinel, for cleaning up stragglers. */
const ANY_SENTINEL = /[-]/g;

const MARK_HEAD_RX = /\uE000\d+\uE001/g;
const UNIT_HEAD_RX = /\uE003[^\uE004]*\uE004/g;
const UNIT_RX = /([^]*)([\s\S]*?)/;

/**
 * Build the Markdown to display, with sentinels around each unit and each
 * redaction span.
 *
 * @param {Map<string, number>} [reportCounts]  how many times each report-wide
 *   redaction's text actually occurs in the whole report. A redaction is only
 *   worth marking as far-reaching if there is somewhere else for it to reach:
 *   stored reach and observable reach differ when a string happens to appear
 *   just once, and it is the observable one the reader needs.
 *
 * @returns {{markdown: string, marks: Array<object>}}
 *   Each mark carries `kind` - 'on' for spans that will be redacted, 'off' for
 *   spans the user has dismissed (shown as a faint outline so a dismissal is
 *   visible rather than silent) - along with the `sources` and `ids` that went
 *   into it and the `text` it covers, which is what the pane needs to offer
 *   actions whose reach matches how the redaction was made.
 */
export function markPageText(ocrPage, reportCounts) {
    const deid = normalizeDeid(ocrPage?.deid);
    if (!deid) return { markdown: ocrPage?.markdown || '', marks: [] };

    const marks = [];
    const markdown = buildPageText(ocrPage, (unit, settings) => {
        const key = unitKey(unit.blockIndex, unit.path);
        const { enabled, dismissed } = effectiveSpans(deid, unit, settings);
        // A dismissed span sitting under an enabled one has nothing to show.
        const visibleDismissed = dismissed.filter(
            (d) => !enabled.some((e) => e.start < d.end && d.start < e.end),
        );
        const spans = [
            ...enabled.map((s) => ({ ...s, kind: 'on' })),
            ...visibleDismissed.map((s) => ({ ...s, kind: 'off' })),
        ].sort((a, b) => a.start - b.start);

        let body = '';
        let pos = 0;
        for (const span of spans) {
            const id = marks.length;
            const text = unit.text.slice(span.start, span.end);
            marks.push({
                id,
                key,
                start: span.start,
                end: span.end,
                kind: span.kind,
                entityTypes: span.entityTypes,
                sources: span.sources,
                ids: span.ids,
                text,
                // Reach worth pointing out: stored as report-wide AND with
                // somewhere else in the report to reach. A string that occurs
                // once behaves identically however it was stored, so calling
                // it out would describe a difference the reader cannot act on.
                // An exception is only meaningful because a report-wide
                // redaction covers this string, so it counts as reaching the
                // report just as a live match does.
                spansReport: !!span.sources?.some((s) => s === 'doc' || s === 'except')
                    && (reportCounts?.get(text) ?? 0) > 1,
                score: span.score,
            });
            body += unit.text.slice(pos, span.start);
            body += MARK_OPEN + id + MARK_SEP + unit.text.slice(span.start, span.end) + MARK_CLOSE;
            pos = span.end;
        }
        body += unit.text.slice(pos);

        // Wrap the unit itself so a selection can be attributed to it. Skipped
        // for the whole-page unit: it spans many block elements, so no single
        // element could contain it - and with only one unit there is nothing
        // to disambiguate anyway.
        if (unit.blockIndex < 0) return body;
        return UNIT_OPEN + key + UNIT_SEP + body + UNIT_CLOSE;
    });

    return { markdown, marks };
}

/**
 * Convert sentinels in already-rendered HTML into elements.
 *
 * Call after setting innerHTML. Redaction spans become
 * `<span class="ov-redaction" data-mark-id>`; unit wrappers become
 * `<span class="ov-unit" data-unit-key>`, whose textContent is exactly the
 * unit's source text - which is what lets a selection inside it be turned
 * back into a plain substring of that unit.
 */
export function decorateMarks(root, marks) {
    if (!root) return;
    const byId = new Map(marks.map((m) => [String(m.id), m]));

    // Outermost markers first. A unit wrapper encloses its redaction markers,
    // so converting the inner ones first would split the unit's text across
    // elements and leave its opening marker unmatched.
    replaceInTextNodes(root, UNIT_RX, (m) => {
        const el = document.createElement('span');
        el.className = 'ov-unit';
        el.dataset.unitKey = m[1];
        // Redaction sentinels inside are still plain text at this point; the
        // pass below turns them into elements.
        el.textContent = m[2];
        return el;
    });

    wrapMarkedText(root, byId);

    // A marker whose text Markdown split across elements never matched; clear
    // its remains so nothing odd shows up.
    stripStraySentinels(root);
}

/**
 * The veil elements this module actually drew.
 *
 * A veil the browser copied - pasted from the clipboard, or left behind when a
 * block was split around the caret - is a different object wearing the same
 * class and the same data attributes. Attributes cannot tell the two apart:
 * they are precisely what a copy brings with it. Membership of this set is not
 * serialized into HTML and is not carried by cloneNode, so it is.
 */
const drawnVeils = new WeakSet();

/** Whether this element is a redaction, as opposed to a copy of one. */
export const isDrawnVeil = (el) => drawnVeils.has(el);

const isException = (mark) => !!mark?.sources?.includes('except');

/** A detection the abstractor decided against - as distinct from text they are
 *  holding out of a redaction they made themselves. Both can be true of the
 *  same words at once, which is why they are separate questions. */
const isKeptDetection = (mark) => mark?.kind === 'off' && !!mark?.sources?.includes('auto');

/**
 * Three independent facts, three classes, any of which may combine: whether
 * these words are being redacted, whether a detection here was overruled, and
 * whether a report-wide redaction covers them. Choosing just one - as this
 * used to - silently drops whichever fact came second, so a detection kept out
 * of a report-wide redaction lost the outline that said it was ever detected.
 */
function markClass(mark) {
    const cls = ['ov-redaction'];
    if (mark?.kind === 'off') cls.push('ov-redaction--off');
    if (isKeptDetection(mark)) cls.push('ov-redaction--detected');
    // Marked because its reach is the surprising part: a veil that carries no
    // marker affects only the text under it.
    if (mark?.spansReport) cls.push('ov-redaction--doc');
    return cls.join(' ');
}

function markTitle(mark) {
    const types = (mark.entityTypes || []).join(', ');
    if (mark.kind === 'off') {
        const detected = isKeptDetection(mark) ? 'detected, but ' : '';
        return isException(mark)
            ? `${types} - ${detected}redacted elsewhere in this report and kept here. Click to change.`
            : `${types} - ${detected}not being redacted. Click to change.`;
    }
    if (mark.spansReport) return `${types} - redacted everywhere in this report. Click to change.`;
    // A hand-placed redaction that reaches no further than this one occurrence,
    // whether because it was scoped that way or because there is nothing else
    // to reach. Either way there is one place, and one thing a click can do.
    if (mark.sources?.some((s) => s === 'doc' || s === 'instance')) {
        return `${types} - redacted. Click to change.`;
    }
    const score = typeof mark.score === 'number' ? ` (${Math.round(mark.score * 100)}%)` : '';
    return `${types}${score} - will be redacted on export. Click to change.`;
}

/**
 * Wrap everything between an opening and closing redaction sentinel, however
 * many elements it turns out to span.
 *
 * A redaction is NOT always one element. Selecting a heading, a paragraph and a
 * list redacts one contiguous stretch of source, but Markdown renders it as
 * several sibling blocks - so the two sentinels come out in different text
 * nodes and no single element could ever hold both. The earlier pass looked for
 * an opening and its closing sentinel within one text node, found neither, and
 * the veil silently never appeared: the Rendered pane showed text as untouched
 * that the export was in fact removing.
 *
 * So the sentinels are read as a stream instead. Each text node contributes
 * whatever part of it lies inside an open mark, wrapped in its own element, and
 * every one of them carries the same data-mark-id - which is all the pane needs,
 * since a click resolves an element back to its mark by that id.
 */
function wrapMarkedText(root, byId) {
    // An unmatched opening sentinel would otherwise leave the rest of the page
    // wrapped as redacted. Nothing renders rather than everything.
    const all = root.textContent || '';
    const opens = (all.match(//g) || []).length;
    const closes = (all.match(//g) || []).length;
    if (!opens || opens !== closes) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);

    let openId = null;   // the mark we are inside, carried across nodes
    for (const target of nodes) {
        const tokens = readSentinels(target.data);
        // Untouched text outside any mark: by far the common case.
        if (openId === null && tokens.length === 1 && tokens[0].type === 'text') continue;

        const frag = document.createDocumentFragment();
        for (const token of tokens) {
            if (token.type === 'open') { openId = token.id; continue; }
            if (token.type === 'close') { openId = null; continue; }
            if (!token.value) continue;
            // Whitespace between two blocks belongs to neither; veiling it
            // would draw a black sliver in the gap.
            if (openId === null || !token.value.trim()) {
                frag.appendChild(document.createTextNode(token.value));
                continue;
            }
            const mark = byId.get(openId);
            const el = document.createElement('span');
            el.className = markClass(mark);
            el.dataset.markId = openId;
            // The words THIS element was drawn over, which is not the whole
            // redaction when one spans several blocks. The pane compares
            // against it to notice when editing has moved text into or out of
            // a veil (see detachTypedText).
            el.dataset.veilText = token.value;
            el.textContent = token.value;
            if (mark) el.title = markTitle(mark);
            drawnVeils.add(el);
            frag.appendChild(el);
        }
        target.replaceWith(frag);
    }
}

/** One text node's worth of sentinel stream: plain text, mark openings (which
 *  carry the id) and mark closings, in the order they appear. */
function readSentinels(data) {
    const out = [];
    let i = 0;
    while (i < data.length) {
        if (data[i] === MARK_OPEN) {
            const sep = data.indexOf(MARK_SEP, i + 1);
            if (sep !== -1) {
                out.push({ type: 'open', id: data.slice(i + 1, sep) });
                i = sep + 1;
                continue;
            }
        }
        if (data[i] === MARK_CLOSE) {
            out.push({ type: 'close' });
            i++;
            continue;
        }
        let j = i;
        while (j < data.length && data[j] !== MARK_OPEN && data[j] !== MARK_CLOSE) j++;
        out.push({ type: 'text', value: data.slice(i, j) });
        i = j;
    }
    return out;
}

/**
 * Replace every regex match inside `root`'s text nodes with a built element.
 * The replacement's text content is taken from the match, so nested markers
 * must be processed innermost-first.
 */
function replaceInTextNodes(root, regex, build) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const targets = [];
    let node;
    while ((node = walker.nextNode())) {
        if (regex.test(node.data)) targets.push(node);
    }
    for (const target of targets) {
        const frag = document.createDocumentFragment();
        let rest = target.data;
        let m;
        while ((m = regex.exec(rest))) {
            if (m.index) frag.appendChild(document.createTextNode(rest.slice(0, m.index)));
            frag.appendChild(build(m));
            rest = rest.slice(m.index + m[0].length);
        }
        if (rest) frag.appendChild(document.createTextNode(rest));
        target.replaceWith(frag);
    }
}

function stripStraySentinels(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const targets = [];
    let node;
    while ((node = walker.nextNode())) {
        if (ANY_SENTINEL.test(node.data)) targets.push(node);
        ANY_SENTINEL.lastIndex = 0;
    }
    for (const target of targets) {
        target.data = stripSentinels(target.data);
    }
}

/**
 * Remove every sentinel from a string.
 *
 * An unmatched opening marker carries a payload - a unit key or a mark id -
 * between its sentinels, so dropping only the sentinel characters would leave
 * that payload behind as visible text. Remove whole headers first.
 */
export function stripSentinels(text) {
    return String(text || '')
        .replace(UNIT_HEAD_RX, '')
        .replace(MARK_HEAD_RX, '')
        .replace(ANY_SENTINEL, '');
}
