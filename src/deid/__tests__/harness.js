/**
 * The whole test harness: a comparison, a heading, and a tally.
 *
 * Deliberately not a framework. These suites assert on plain return values of
 * pure functions, so a runner that only has to say which one differed from what
 * was expected is the entire requirement - and one file of it stays readable
 * next to the code it checks.
 *
 * Counts are module state, which works because scripts/run-tests.mjs bundles
 * each suite separately: every suite gets its own copy and its own tally.
 */

let passed = 0;
let failed = 0;

/** Announce a group of related checks. */
export const section = (title) => console.log(`\n== ${title}`);

/**
 * Compare by value, not identity - almost everything under test returns arrays
 * or plain objects, and serializing both sides is enough to tell them apart
 * while printing something readable when they differ.
 */
export function check(name, got, want) {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g === w) {
        passed++;
        console.log(`  ok   ${name}`);
        return;
    }
    failed++;
    console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`);
}

export const totals = () => ({ passed, failed });
