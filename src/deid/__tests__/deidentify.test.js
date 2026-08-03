/**
 * The redaction model: what is redacted, how far each decision reaches, and
 * what survives an edit.
 *
 * These are rules the review pane presents but does not own. Several are
 * EMERGENT - they fall out of how offsets are mapped through a diff rather than
 * being stated anywhere - so they are pinned here, where a change to
 * textDiff.js that quietly altered one would be caught.
 */
import {
    addManualRedaction,
    countExceptions,
    countLiveMatches,
    countOccurrences,
    dismissSpans,
    dismissMatchingSpans,
    effectiveSpans,
    exceptNthOccurrenceInPage,
    hasOverrides,
    markComposition,
    normalizeDeid,
    occurrenceIndexInPage,
    pageOutputText,
    reanchorAfterEdit,
    redactInstance,
    redactNthOccurrenceInPage,
    removeManualRedaction,
    resetOverrides,
    restoreSpans,
    sourceRangesFromRendered,
    unexceptMatching,
    unexceptSpans,
} from '../deidentify.js';
import { check, section, totals } from './harness.js';

export { totals };


const SETTINGS = { deidEntities: ['PERSON', 'PHONE_NUMBER'], deidScoreThreshold: 0.5 };

// A page with no block structure -> one page-level unit over the markdown.
const PAGE = 'Ref 1234 for J Smith.\nSecond line 1234 here.\nThird line 1234 end.';
function pageRecord() {
    return {
        markdown: PAGE,
        blocks: [],
        deid: {
            schema: 3,
            at: 1,
            units: [{
                blockIndex: -1,
                path: ['__page__'],
                text: PAGE,
                spans: [{ id: 'a1', start: 13, end: 20, entityType: 'PERSON', score: 0.9 }],
            }],
            overrides: { off: [], on: [] },
        },
    };
}
const enabledTexts = (rec) => {
    const d = rec.deid;
    return d.units.flatMap((u) =>
        effectiveSpans(d, u, SETTINGS).enabled.map((s) => u.text.slice(s.start, s.end)));
};

section('reach: everywhere vs one instance');
{
    const rec = pageRecord();
    addManualRedaction(rec.deid, '1234');
    check('everywhere redacts all three', enabledTexts(rec), ['1234', 'J Smith', '1234', '1234']);
}
{
    const rec = pageRecord();
    check('index of the 2nd occurrence', redactNthOccurrenceInPage(rec.deid, 1, '1234'), true);
    check('only one instance redacted', enabledTexts(rec), ['J Smith', '1234']);
    const spans = effectiveSpans(rec.deid, rec.deid.units[0], SETTINGS).enabled;
    check('and it is the second one', spans.find((s) => s.sources.includes('instance')).start, 34);
}
{
    const rec = pageRecord();
    check('out-of-range index refuses', redactNthOccurrenceInPage(rec.deid, 9, '1234'), false);
    check('nothing added', enabledTexts(rec), ['J Smith']);
}

section('instance redaction survives an edit elsewhere');
{
    const rec = pageRecord();
    redactNthOccurrenceInPage(rec.deid, 1, '1234');
    // Edit the FIRST line, well away from the redacted occurrence.
    const edited = PAGE.replace('Ref 1234 for J Smith.', 'Reference 1234 for J Smith, MD.');
    rec.deid = reanchorAfterEdit(rec, rec.deid, edited);
    rec.markdown = edited;
    check('still exactly one instance', enabledTexts(rec).filter((t) => t === '1234').length, 1);
    const spans = effectiveSpans(rec.deid, rec.deid.units[0], SETTINGS).enabled;
    const inst = spans.find((s) => s.sources.includes('instance'));
    check('still the 2nd occurrence', edited.slice(inst.start, inst.end), '1234');
    check('and it moved with the text', inst.start, edited.indexOf('1234', edited.indexOf('1234') + 4));
    check('the auto PERSON span survived too', enabledTexts(rec).includes('J Smith'), true);
}

section('a dismissal survives an edit (ids, not offsets)');
{
    const rec = pageRecord();
    dismissSpans(rec.deid, ['a1']);
    check('dismissed now', enabledTexts(rec), []);
    const edited = 'PREFIX ADDED\n' + PAGE;
    rec.deid = reanchorAfterEdit(rec, rec.deid, edited);
    rec.markdown = edited;
    check('still dismissed after the edit', enabledTexts(rec), []);
    check('the off entry still points at a live span', rec.deid.overrides.off.length, 1);
    restoreSpans(rec.deid, rec.deid.units[0].spans.map((s) => s.id));
    check('restorable', enabledTexts(rec), ['J Smith']);
}

section('deleting the redacted text drops the redaction');
{
    const rec = pageRecord();
    const edited = PAGE.replace(' for J Smith', '');
    rec.deid = reanchorAfterEdit(rec, rec.deid, edited);
    check('span gone', rec.deid.units[0].spans.length, 0);
}

section('unredact everywhere');
{
    const rec = pageRecord();
    // Three auto spans with the same text, one per line.
    const at1234 = [];
    for (let i = PAGE.indexOf('1234'); i !== -1; i = PAGE.indexOf('1234', i + 4)) at1234.push(i);
    check('three occurrences to work with', at1234.length, 3);
    rec.deid.units[0].spans = at1234.map((at, i) =>
        ({ id: `p${i}`, start: at, end: at + 4, entityType: 'PHONE_NUMBER', score: 0.9 }));
    check('all three redacted', enabledTexts(rec).length, 3);
    dismissMatchingSpans(rec.deid, '1234');
    check('none redacted', enabledTexts(rec).length, 0);
    const dismissed = effectiveSpans(rec.deid, rec.deid.units[0], SETTINGS).dismissed;
    check('all three shown as dismissed', dismissed.length, 3);
}

// The analyzer readily returns more than one detection over the same words - a
// date, and the year inside it - and a veil is the merge of all of them. Naming
// only the span that spells the whole thing left the shorter one in force, the
// veil still drawn, and lifting looking as though it had done nothing.
section('unredact everywhere, where two detections share the words');
{
    const rec = pageRecord();
    const first = PAGE.indexOf('1234');
    const second = PAGE.indexOf('1234', first + 4);
    rec.deid.units[0].spans = [
        { id: 'whole1', start: first, end: first + 4, entityType: 'PHONE_NUMBER', score: 0.85 },
        { id: 'part1', start: first, end: first + 2, entityType: 'PHONE_NUMBER', score: 0.6 },
        { id: 'whole2', start: second, end: second + 4, entityType: 'PHONE_NUMBER', score: 0.85 },
    ];
    check('two veils, the first merged from two spans', enabledTexts(rec), ['1234', '1234']);
    dismissMatchingSpans(rec.deid, '1234');
    check('both lift, sub-span and all', enabledTexts(rec), []);
}

// ...but a detection reaching BEYOND the words stays: lifting these words is no
// reason to stop redacting the rest of a longer finding somewhere else.
section('a longer finding around the same words is left alone');
{
    const rec = pageRecord();
    const at = PAGE.indexOf('1234');
    rec.deid.units[0].spans = [
        { id: 'inner', start: at, end: at + 4, entityType: 'PHONE_NUMBER', score: 0.9 },
        { id: 'outer', start: at - 4, end: at + 4, entityType: 'PERSON', score: 0.9 },
    ];
    dismissMatchingSpans(rec.deid, '1234');
    check('the longer one still redacts', enabledTexts(rec), ['Ref 1234']);
}

section('narrowing everywhere -> here, and widening back');
{
    const rec = pageRecord();
    addManualRedaction(rec.deid, '1234');
    check('three manual hits', enabledTexts(rec).filter((t) => t === '1234').length, 3);
    // The user clicks the middle veil and picks "Only here".
    const index = occurrenceIndexInPage(rec.deid, '-1:__page__', 34, 38, '1234');
    check('middle veil is occurrence 1', index, 1);
    redactNthOccurrenceInPage(rec.deid, index, '1234');
    removeManualRedaction(rec.deid, '1234');
    check('now just the one', enabledTexts(rec).filter((t) => t === '1234').length, 1);
    const inst = effectiveSpans(rec.deid, rec.deid.units[0], SETTINGS).enabled
        .find((s) => s.sources.includes('instance'));
    check('and it is the middle one', inst.start, 34);

    // Now widen it back.
    dismissSpans(rec.deid, inst.ids);
    addManualRedaction(rec.deid, '1234');
    check('back to all three', enabledTexts(rec).filter((t) => t === '1234').length, 3);
}

section('markComposition reports what a veil is made of');
{
    const rec = pageRecord();
    addManualRedaction(rec.deid, 'J Smith');   // overlaps the auto PERSON span
    const parts = markComposition(rec.deid, '-1:__page__', 13, 20);
    check('auto id', parts.autoIds, ['a1']);
    check('doc text', parts.docTexts, ['J Smith']);
    check('no instance', parts.instanceIds, []);
    const merged = effectiveSpans(rec.deid, rec.deid.units[0], SETTINGS).enabled;
    check('merged into one veil', merged.length, 1);
    check('carrying both sources', merged[0].sources.sort(), ['auto', 'doc']);
}

section('contradictions are not storable');
{
    const rec = pageRecord();
    addManualRedaction(rec.deid, '1234');
    dismissMatchingSpans(rec.deid, '1234');
    check('lifting everywhere withdraws the redact-everywhere', rec.deid.overrides.on, []);
    check('and nothing is redacted', enabledTexts(rec).filter(t => t === '1234').length, 0);
    addManualRedaction(rec.deid, '1234');
    check('asking again redacts all three', enabledTexts(rec).filter(t => t === '1234').length, 3);
}

// Three detections of the same string; lifting them together must not weld
// them into one decision that can only be undone as a whole.
function detectedThrice() {
    const rec = pageRecord();
    const at = [];
    for (let i = PAGE.indexOf('1234'); i !== -1; i = PAGE.indexOf('1234', i + 4)) at.push(i);
    rec.deid.units[0].spans = at.map((start, i) =>
        ({ id: `d${i}`, start, end: start + 4, entityType: 'PHONE_NUMBER', score: 0.9 }));
    return rec;
}

section('unredact all, then restore just one');
{
    const rec = detectedThrice();
    dismissMatchingSpans(rec.deid, '1234');
    check('all lifted', enabledTexts(rec).length, 0);
    restoreSpans(rec.deid, ['d1']);
    check('exactly one back', enabledTexts(rec).length, 1);
    const back = effectiveSpans(rec.deid, rec.deid.units[0], SETTINGS).enabled[0];
    check('and it is the one asked for', back.start, rec.deid.units[0].spans[1].start);
    check('the others stay lifted', rec.deid.overrides.off.map(o => o.id).sort(), ['d0', 'd2']);
}

section('a veil can be a kept detection AND a report-wide exception');
{
    const rec = detectedThrice();
    dismissMatchingSpans(rec.deid, '1234');          // lift all three detections
    addManualRedaction(rec.deid, '1234');            // then redact the string report-wide
    check('all redacted again, report-wide', enabledTexts(rec).filter(t => t === '1234').length, 3);
    // Keep the middle one out of it.
    exceptNthOccurrenceInPage(rec.deid, 1, '1234');
    const { enabled, dismissed } = effectiveSpans(rec.deid, rec.deid.units[0], SETTINGS);
    check('two still redacted', enabled.filter(s => s.sources.includes('doc')).length, 2);
    const kept = dismissed.find(d => d.sources.includes('except'));
    check('the kept one is reported as an exception', !!kept, true);
    check('AND as a detection that was dismissed', kept.sources.includes('auto'), true);
}

section('withdrawing exceptions: one, or all of them');
{
    const rec = pageRecord();
    addManualRedaction(rec.deid, '1234');
    exceptNthOccurrenceInPage(rec.deid, 0, '1234');
    exceptNthOccurrenceInPage(rec.deid, 2, '1234');
    check('two held out', countExceptions(rec.deid, '1234'), 2);
    check('one still redacted', countLiveMatches(rec.deid, '1234'), 1);

    // Withdraw just one of them.
    const kept = effectiveSpans(rec.deid, rec.deid.units[0], SETTINGS).dismissed
        .filter(d => d.sources.includes('except'));
    unexceptSpans(rec.deid, kept[0].ids);
    check('one back, one still held out', countExceptions(rec.deid, '1234'), 1);
    check('two redacted now', enabledTexts(rec).filter(t => t === '1234').length, 2);

    // And now all of them.
    unexceptMatching(rec.deid, '1234');
    check('none held out', countExceptions(rec.deid, '1234'), 0);
    check('all three redacted', enabledTexts(rec).filter(t => t === '1234').length, 3);
}

section('a redaction excepted out of existence covers nothing');
{
    const rec = pageRecord();
    addManualRedaction(rec.deid, '1234');
    check('covers three', countLiveMatches(rec.deid, '1234'), 3);
    exceptNthOccurrenceInPage(rec.deid, 0, '1234');
    check('covers two', countLiveMatches(rec.deid, '1234'), 2);
    exceptNthOccurrenceInPage(rec.deid, 1, '1234');
    exceptNthOccurrenceInPage(rec.deid, 2, '1234');
    check('covers nothing - the caller collapses it here', countLiveMatches(rec.deid, '1234'), 0);
    // What the UI then does, across every page:
    removeManualRedaction(rec.deid, '1234');
    check('redaction gone', rec.deid.overrides.on, []);
    check('and its exceptions with it', countExceptions(rec.deid, '1234'), 0);
    check('nothing marked, nothing redacted', enabledTexts(rec), ['J Smith']);
    check('no leftover decisions', hasOverrides(rec.deid), false);
}

section('an exception dies with the redaction it excepts');
{
    const rec = pageRecord();
    addManualRedaction(rec.deid, '1234');
    exceptNthOccurrenceInPage(rec.deid, 1, '1234');
    check('one exception', rec.deid.units[0].spans.filter(s => s.except).length, 1);
    removeManualRedaction(rec.deid, '1234');
    check('gone with it', rec.deid.units[0].spans.filter(s => s.except).length, 0);
}

section('schema 3 records with a text-rule dismissal migrate');
{
    const rec = detectedThrice();
    rec.deid.overrides = { off: [], offText: [{ text: '1234' }], on: [] };
    const up = normalizeDeid(rec.deid);
    check('expanded to span ids', up.overrides.off.map(o => o.id).sort(), ['d0', 'd1', 'd2']);
    check('rule dropped', up.overrides.offText, undefined);
    check('still nothing redacted', enabledTexts({ ...rec, deid: up }).length, 0);
    restoreSpans(up, ['d1']);
    check('and now one can be restored alone', enabledTexts({ ...rec, deid: up }).length, 1);
}

section('schema 2 records migrate without losing decisions');
{
    const legacy = {
        schema: 2,
        at: 5,
        units: [{
            blockIndex: -1,
            path: ['__page__'],
            text: PAGE,
            spans: [
                { start: 4, end: 8, entityType: 'PHONE_NUMBER', score: 0.9 },
                { start: 13, end: 20, entityType: 'PERSON', score: 0.9 },
            ],
        }],
        overrides: { off: [{ key: '-1:__page__', start: 4, end: 8 }], on: [{ text: 'here' }] },
    };
    const up = normalizeDeid(legacy);
    check('schema bumped', up.schema, 3);
    check('spans have ids', up.units[0].spans.every((s) => !!s.id), true);
    check('dismissal re-pointed at the right span', up.units[0].spans[0].id, up.overrides.off[0].id);
    check('manual redaction kept', up.overrides.on.map((o) => o.text), ['here']);
    const rec = { markdown: PAGE, blocks: [], deid: up };
    check('and it still derives correctly', enabledTexts(rec), ['J Smith', 'here']);
    check('idempotent', normalizeDeid(up), up);
}

section('reset clears both kinds');
{
    const rec = pageRecord();
    addManualRedaction(rec.deid, '1234');
    redactNthOccurrenceInPage(rec.deid, 0, 'Second');
    check('has overrides', hasOverrides(rec.deid), true);
    resetOverrides(rec.deid);
    check('reset', enabledTexts(rec), ['J Smith']);
    check('no overrides left', hasOverrides(rec.deid), false);
}

section('exceptions to a report-wide redaction');
{
    const rec = pageRecord();
    addManualRedaction(rec.deid, '1234');
    check('all three redacted', enabledTexts(rec).filter(t => t === '1234').length, 3);

    // Keep the middle one; the other two stay redacted.
    const index = occurrenceIndexInPage(rec.deid, '-1:__page__', 34, 38, '1234');
    check('middle is occurrence 1', index, 1);
    check('excepted', exceptNthOccurrenceInPage(rec.deid, index, '1234'), true);
    check('two still redacted', enabledTexts(rec).filter(t => t === '1234').length, 2);
    check('and it is the middle one that is kept',
        pageOutputText(rec).includes('Second line 1234 here'), true);

    // It shows as its own thing, not as a dismissed detection.
    const { dismissed } = effectiveSpans(rec.deid, rec.deid.units[0], SETTINGS);
    const exc = dismissed.find(d => d.sources.includes('except'));
    check('reported as an exception', !!exc, true);
    check('and not as a dismissal', exc.sources.includes('auto'), false);

    // Withdraw it: back under the report-wide redaction.
    unexceptSpans(rec.deid, exc.ids);
    check('back to three', enabledTexts(rec).filter(t => t === '1234').length, 3);
}

section('an exception survives an edit, on its own characters');
{
    const rec = pageRecord();
    addManualRedaction(rec.deid, '1234');
    exceptNthOccurrenceInPage(rec.deid, 1, '1234');       // keep the middle one
    const edited = 'PREAMBLE ADDED HERE\n' + PAGE.replace('Ref 1234', 'Reference 1234');
    rec.deid = reanchorAfterEdit(rec, rec.deid, edited);
    rec.markdown = edited;
    check('still exactly two redacted', enabledTexts(rec).filter(t => t === '1234').length, 2);
    check('still the middle one kept', pageOutputText(rec).includes('Second line 1234 here'), true);
    check('first still redacted', pageOutputText(rec).includes('Reference [REDACTED]'), true);
}

section('redacting everywhere again clears exceptions');
{
    const rec = pageRecord();
    addManualRedaction(rec.deid, '1234');
    exceptNthOccurrenceInPage(rec.deid, 1, '1234');
    check('two redacted', enabledTexts(rec).filter(t => t === '1234').length, 2);
    addManualRedaction(rec.deid, '1234');                  // explicit "everywhere" again
    check('exception withdrawn', enabledTexts(rec).filter(t => t === '1234').length, 3);
}

section('reset clears exceptions too');
{
    const rec = pageRecord();
    addManualRedaction(rec.deid, '1234');
    exceptNthOccurrenceInPage(rec.deid, 1, '1234');
    check('has overrides', hasOverrides(rec.deid), true);
    resetOverrides(rec.deid);
    check('back to Presidio only', enabledTexts(rec), ['J Smith']);
    check('no overrides', hasOverrides(rec.deid), false);
}

section('a rendered selection across blocks maps back to the source');
{
    const md = '## FINAL DIAGNOSIS\n\nA. Breast, right, core needle biopsy:\n\n-   Intraductal papilloma.\n-   No atypia.\n\nEnd of report.';
    const rec = {
        markdown: md, blocks: [],
        deid: { schema: 3, at: 1, units: [{ blockIndex: -1, path: ['__page__'], text: md, spans: [] }], overrides: { off: [], on: [] } },
    };
    // What the Rendered pane's textContent looks like: no "## ", no "-   ".
    const rendered = 'FINAL DIAGNOSISA. Breast, right, core needle biopsy:Intraductal papilloma.No atypia.End of report.';
    const from = rendered.indexOf('FINAL');
    const to = rendered.indexOf('End of report.');
    const ranges = sourceRangesFromRendered(rec, rec.deid, rendered, from, to);
    check('one range, in the page unit', ranges.map(r => r.key), ['-1:__page__']);
    const covered = md.slice(ranges[0].start, ranges[0].end);
    check('starts at the heading text', covered.startsWith('FINAL DIAGNOSIS'), true);
    check('reaches the last list item', covered.includes('No atypia.'), true);
    check('and stops before the untouched block', covered.includes('End of report'), false);

    for (const at of ranges) redactInstance(rec.deid, at.key, at.start, at.end);
    const out = pageOutputText(rec);
    check('the whole region is replaced', out.includes('[REDACTED]'), true);
    check('the block after it survives', out.trim().endsWith('End of report.'), true);
    check('and the heading marker is not left dangling', out.includes('## [REDACTED]') || out.startsWith('## '), true);
}

// Moving redacted text must not move its redaction with it, wherever it lands.
// This is a property of the diff rather than of any rule about pasting: an LCS
// prefers the longer alignment, so matching the moved words in their new place
// would mean giving up the alignment of everything in between, which is longer.
// Pinned here because a change to textDiff could quietly alter it.
section('cut and paste loses the redaction, wherever it goes');
{
    const NAME = 'J Smith';
    const move = (to) => {
        const rec = pageRecord();
        const edited = to(PAGE.replace(`for ${NAME}.`, 'for .'));
        rec.deid = reanchorAfterEdit(rec, rec.deid, edited);
        rec.markdown = edited;
        return enabledTexts(rec).filter((t) => t === NAME).length;
    };
    check('pasted later', move((t) => t.replace('Third line', `Third ${NAME} line`)), 0);
    check('pasted earlier', move((t) => `${NAME}\n${t}`), 0);
    check('pasted into the same line', move((t) => t.replace('Ref 1234', `Ref ${NAME} 1234`)), 0);

    // Copying it, by contrast, leaves the original redacted and the copy not.
    const rec = pageRecord();
    const copied = PAGE.replace('Third line', `Third ${NAME} line`);
    rec.deid = reanchorAfterEdit(rec, rec.deid, copied);
    rec.markdown = copied;
    check('a copy leaves exactly one redacted', enabledTexts(rec).filter((t) => t === NAME).length, 1);
    check('and it is the original', pageOutputText(rec).startsWith('Ref 1234 for [REDACTED].'), true);
}

section('export substitutes the placeholder');
{
    const rec = pageRecord();
    redactNthOccurrenceInPage(rec.deid, 2, '1234');
    const out = pageOutputText(rec);
    check('third occurrence only', out, 'Ref 1234 for [REDACTED].\nSecond line 1234 here.\nThird line [REDACTED] end.');
}

section('per-field units: spans locate through the page markdown');
{
    const blocks = [
        { kind: 'kv', label: 'Name', value: 'J Smith' },
        { kind: 'paragraph', text: 'Contact 1234 or 1234.' },
    ];
    const markdown = '**Name:** J Smith\n\nContact 1234 or 1234.\n';
    const rec = {
        markdown,
        blocks,
        deid: {
            schema: 3, at: 1,
            units: [
                { blockIndex: 0, path: ['label'], text: 'Name', spans: [] },
                { blockIndex: 0, path: ['value'], text: 'J Smith', spans: [{ id: 'v1', start: 0, end: 7, entityType: 'PERSON', score: 0.9 }] },
                { blockIndex: 1, path: ['text'], text: 'Contact 1234 or 1234.', spans: [] },
            ],
            overrides: { off: [], on: [] },
        },
    };
    check('export redacts the field', pageOutputText(rec), '**Name:** [REDACTED]\n\nContact 1234 or 1234.\n');
    // Redact the SECOND 1234 in the paragraph, then edit the first line.
    redactNthOccurrenceInPage(rec.deid, 1, '1234');
    check('one instance', pageOutputText(rec), '**Name:** [REDACTED]\n\nContact 1234 or [REDACTED].\n');
    const edited = markdown.replace('**Name:** J Smith', '**Patient name:** J Smith');
    rec.deid = reanchorAfterEdit(rec, rec.deid, edited);
    rec.markdown = edited;
    check('both survive the edit across unit collapse',
        pageOutputText(rec), '**Patient name:** [REDACTED]\n\nContact 1234 or [REDACTED].\n');
}
