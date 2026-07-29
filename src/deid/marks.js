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
    isCurrentSchema,
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
const MARK_RX = /(\d+)([\s\S]*?)/;
const UNIT_RX = /([^]*)([\s\S]*?)/;

/**
 * Build the Markdown to display, with sentinels around each unit and each
 * redaction span.
 *
 * @returns {{markdown: string, marks: Array<{id, key, start, end, kind, entityTypes, score}>}}
 *   `kind` is 'on' for spans that will be redacted, 'off' for auto-detected
 *   spans the user has dismissed (shown as a faint outline so a dismissal is
 *   visible rather than silent).
 */
export function markPageText(ocrPage) {
    const deid = ocrPage?.deid;
    if (!isCurrentSchema(deid)) return { markdown: ocrPage?.markdown || '', marks: [] };

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
            marks.push({
                id,
                key,
                start: span.start,
                end: span.end,
                kind: span.kind,
                entityTypes: span.entityTypes,
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

    replaceInTextNodes(root, MARK_RX, (m) => {
        const mark = byId.get(m[1]);
        const el = document.createElement('span');
        el.className = mark?.kind === 'off' ? 'ov-redaction ov-redaction--off' : 'ov-redaction';
        el.dataset.markId = m[1];
        el.textContent = m[2];
        if (mark) {
            const types = (mark.entityTypes || []).join(', ');
            el.title = mark.kind === 'off'
                ? `${types} - dismissed, will NOT be redacted. Click to restore.`
                : `${types}${typeof mark.score === 'number' ? ` (${Math.round(mark.score * 100)}%)` : ''} - will be redacted on export. Click to keep it.`;
        }
        return el;
    });

    // A marker whose text Markdown split across elements never matched; clear
    // its remains so nothing odd shows up.
    stripStraySentinels(root);
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
