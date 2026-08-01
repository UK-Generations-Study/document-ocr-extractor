/**
 * Carrying offsets across an edit.
 *
 * The property that matters is that a span follows its OWN characters, rather
 * than being re-found by what it says: two identical values stay independent,
 * which is what lets one occurrence of a string be redacted and the next not.
 */
import { matchedRuns, mapSpan } from '../textDiff.js';
import { check, section, totals } from './harness.js';

export { totals };

// Helper: map a span given by its text occurrence index.
function remap(oldText, newText, start, end) {
    const runs = matchedRuns(oldText, newText);
    const m = mapSpan(runs, start, end);
    return m ? newText.slice(m.start, m.end) : null;
}

section('identical text');
check('unchanged', remap('Name: John Smith', 'Name: John Smith', 6, 16), 'John Smith');

section('insertion before the span');
check('shift right', remap('Name: John Smith', 'Patient Name: John Smith', 6, 16), 'John Smith');

section('deletion before the span');
check('shift left', remap('Patient Name: John Smith', 'Name: John Smith', 14, 24), 'John Smith');

section('edit after the span');
check('unmoved', remap('John Smith, aged 40', 'John Smith, aged 41', 0, 10), 'John Smith');

section('THE KEY CASE: identical occurrences stay distinguishable');
const oldT = 'Ref 1234\nOther 1234\nFinal 1234';
const newT = 'Ref 1234\nOther 1234 (revised)\nFinal 1234';
// second occurrence, offsets 15..19
check('2nd occurrence tracked', oldT.slice(15, 19), '1234');
const runs = matchedRuns(oldT, newT);
check('2nd occurrence maps to 2nd', mapSpan(runs, 15, 19), { start: 15, end: 19 });
check('3rd occurrence follows the insert', newT.slice(mapSpan(runs, 26, 30).start, mapSpan(runs, 26, 30).end), '1234');
check('1st occurrence unmoved', mapSpan(runs, 4, 8), { start: 4, end: 8 });

section('span text deleted entirely');
check('lost', remap('Name: John Smith\nDOB: 1970', 'DOB: 1970', 6, 16), null);

section('edit inside the span widens it');
check('widen', remap('John Smyth', 'John Smith', 0, 10), 'John Smith');

section('multiple separate edits in one save');
const a = 'Line one\nLine two\nLine three\nLine four';
const b = 'Line ONE\nLine two\nLine three\nLine FOUR';
check('middle survives edits at both ends',
    remap(a, b, 9, 17), 'Line two');

section('whole lines inserted above');
check('span pushed down',
    remap('A\nB\nTarget\n', 'A\nNEW\nNEW2\nB\nTarget\n', 4, 10), 'Target');

section('reordered lines');
check('line moved', remap('X\nTarget\nY\n', 'Y\nX\nTarget\n', 2, 8), 'Target');
