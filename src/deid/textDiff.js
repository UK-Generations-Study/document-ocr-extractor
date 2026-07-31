/**
 * Carrying character offsets across a text edit.
 *
 * When the abstractor edits a page, every redaction on it is described by
 * offsets into the text that just changed. Re-finding each one by searching for
 * its string is a guess: if "1234" appears three times and the user meant the
 * second, a search cannot tell which one, and the ambiguity has to be resolved
 * by redacting all of them or none.
 *
 * So instead of re-deriving positions after the fact, we MAP them through the
 * edit. A diff of the old and new text tells us which characters survived and
 * where they moved to; a span is then relocated by following its own
 * characters, never by looking for text that resembles it. Identical
 * occurrences stay distinguishable because they are never compared - each one
 * is tracked individually. This is the same technique a text editor uses to
 * keep a bookmark pinned to the right line while you type above it.
 *
 * The diff is expressed as MATCHED RUNS - stretches of text present in both
 * versions, in order - which is all the mapping needs. Anything not covered by
 * a run was deleted (if it was in the old text) or inserted (if it is in the
 * new one), and neither case needs naming.
 *
 * Granularity narrows as it goes: an LCS over LINES finds the structure that
 * survived, each gap between two matched lines gets an LCS over WORDS, and
 * whatever is still unmatched contributes its common prefix and suffix. Three
 * cheap passes rather than one character-level diff of the whole page - and
 * the word pass is what stops an edit at one end of a line from taking every
 * redaction on that line with it.
 */

/** Above this many items on either side of a comparison, skip the LCS (it is
 *  quadratic) and fall back to the next refinement alone. An OCR page is rarely
 *  more than a couple of hundred lines, so this is a guard, not a normal path. */
const LCS_LIMIT = 600;

/**
 * Stretches of text common to both versions, ordered and non-overlapping.
 *
 * @returns {Array<{oldStart: number, newStart: number, len: number}>}
 */
export function matchedRuns(oldText, newText) {
    const a = String(oldText ?? '');
    const b = String(newText ?? '');
    if (!a || !b) return [];
    if (a === b) return [{ oldStart: 0, newStart: 0, len: a.length }];

    // Trim what is identical at each end first. An edit is almost always local,
    // so this alone usually reduces the problem to a handful of lines.
    const prefix = commonPrefix(a, b, 0, 0);
    const suffix = commonSuffix(a, b, prefix);

    const runs = [];
    if (prefix) runs.push({ oldStart: 0, newStart: 0, len: prefix });
    runs.push(...middleRuns(
        a.slice(prefix, a.length - suffix), prefix,
        b.slice(prefix, b.length - suffix), prefix,
    ));
    if (suffix) {
        runs.push({ oldStart: a.length - suffix, newStart: b.length - suffix, len: suffix });
    }
    return mergeRuns(runs);
}

/**
 * Where a span of the old text ends up in the new one, or null if every
 * character of it was deleted.
 *
 * The result spans from the first surviving character to the last. When the
 * MIDDLE of a span was edited, that pulls the replacement text inside the span
 * - a redaction over "John Smith" whose surname is corrected still covers the
 * whole name. Widening is the safe direction here: the alternative is a
 * redaction that quietly stops covering part of what it was drawn over.
 */
export function mapSpan(runs, start, end) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const run of runs) {
        const from = Math.max(start, run.oldStart);
        const to = Math.min(end, run.oldStart + run.len);
        if (to <= from) continue;
        const shift = run.newStart - run.oldStart;
        lo = Math.min(lo, from + shift);
        hi = Math.max(hi, to + shift);
    }
    if (hi <= lo) return null;
    return { start: lo, end: hi };
}

// ---------------------------------------------------------------- internals

function commonPrefix(a, b, aFrom, bFrom) {
    const max = Math.min(a.length - aFrom, b.length - bFrom);
    let i = 0;
    while (i < max && a[aFrom + i] === b[bFrom + i]) i++;
    return i;
}

/** Length of the shared suffix, never reaching back into the shared prefix. */
function commonSuffix(a, b, prefix) {
    const max = Math.min(a.length - prefix, b.length - prefix);
    let i = 0;
    while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
    return i;
}

/** Split into lines, each keeping its trailing newline and its start offset. */
function splitLines(text) {
    const out = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '\n') continue;
        out.push({ text: text.slice(start, i + 1), start });
        start = i + 1;
    }
    if (start < text.length) out.push({ text: text.slice(start), start });
    return out;
}

/** Split into words and the runs of punctuation and space between them.
 *  Chunky on purpose: single characters would match each other all over the
 *  place and drag a span's edges towards whichever stray space matched. */
const TOKEN_RX = /[A-Za-z0-9_]+|[^A-Za-z0-9_]+/g;
function splitTokens(text) {
    const out = [];
    for (const m of text.matchAll(TOKEN_RX)) out.push({ text: m[0], start: m.index });
    return out;
}

/** Matched runs for the part left over after the ends were trimmed. */
function middleRuns(oldText, oldBase, newText, newBase) {
    return lcsRuns(splitLines, tokenRuns, oldText, oldBase, newText, newBase);
}

/** Matched runs within one changed stretch, word by word. */
function tokenRuns(oldSeg, oldBase, newSeg, newBase) {
    return lcsRuns(splitTokens, charRuns, oldSeg, oldBase, newSeg, newBase);
}

/**
 * Match two stretches by the units `split` yields, handing whatever is left
 * between matches down to `refine`.
 *
 * Both refinement levels have the same shape, so they share this: line-level
 * matching leaves gaps of changed lines, word-level matching leaves gaps of
 * changed words, and each is a smaller instance of the same problem.
 */
function lcsRuns(split, refine, oldText, oldBase, newText, newBase) {
    if (!oldText || !newText) return [];
    const a = split(oldText);
    const b = split(newText);
    if (a.length > LCS_LIMIT || b.length > LCS_LIMIT) {
        return refine(oldText, oldBase, newText, newBase);
    }

    const runs = [];
    let oldGap = 0;
    let newGap = 0;
    const closeGap = (oldEnd, newEnd) => {
        runs.push(...refine(
            oldText.slice(oldGap, oldEnd), oldBase + oldGap,
            newText.slice(newGap, newEnd), newBase + newGap,
        ));
    };

    for (const [i, j] of lcsPairs(a, b)) {
        closeGap(a[i].start, b[j].start);
        runs.push({
            oldStart: oldBase + a[i].start,
            newStart: newBase + b[j].start,
            len: a[i].text.length,
        });
        oldGap = a[i].start + a[i].text.length;
        newGap = b[j].start + b[j].text.length;
    }
    closeGap(oldText.length, newText.length);
    return runs;
}

/** The shared prefix and suffix of two changed stretches, as runs. */
function charRuns(oldSeg, oldBase, newSeg, newBase) {
    if (!oldSeg || !newSeg) return [];
    const runs = [];
    const prefix = commonPrefix(oldSeg, newSeg, 0, 0);
    if (prefix) runs.push({ oldStart: oldBase, newStart: newBase, len: prefix });
    const suffix = commonSuffix(oldSeg, newSeg, prefix);
    if (suffix) {
        runs.push({
            oldStart: oldBase + oldSeg.length - suffix,
            newStart: newBase + newSeg.length - suffix,
            len: suffix,
        });
    }
    return runs;
}

/**
 * Longest common subsequence over items, as [oldIndex, newIndex] pairs.
 *
 * Plain O(n*m) dynamic programming, bounded by LCS_LIMIT above. dp[i][j] is
 * the LCS length of a[i..] and b[j..], held in one flat array because a page's
 * worth of lines or words makes a table small enough not to bother with the
 * rolling-row trick, and the full table is what lets the walk below stay
 * simple.
 */
function lcsPairs(a, b) {
    const n = a.length;
    const m = b.length;
    const width = m + 1;
    const dp = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i * width + j] = a[i].text === b[j].text
                ? dp[(i + 1) * width + (j + 1)] + 1
                : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
        }
    }

    const pairs = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i].text === b[j].text) {
            pairs.push([i, j]);
            i++;
            j++;
        } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
            i++;
        } else {
            j++;
        }
    }
    return pairs;
}

/** Join runs that are contiguous in both texts, and drop empty ones. */
function mergeRuns(runs) {
    const out = [];
    for (const run of runs) {
        if (run.len <= 0) continue;
        const last = out[out.length - 1];
        if (last
            && last.oldStart + last.len === run.oldStart
            && last.newStart + last.len === run.newStart) {
            last.len += run.len;
        } else {
            out.push({ ...run });
        }
    }
    return out;
}
