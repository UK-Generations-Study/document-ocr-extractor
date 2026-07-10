/**
 * Shared "needs a human look" heuristics over the OCR uncertainty layer
 * (src/ocr/structure/uncertainty.ts). Used by the OCR review view (per-page
 * badge), the report viewer (position overlays on the
 * page image), and the OCR queue (doc-level flag driving the 'flagged'
 * review mode's auto-confirm decision).
 *
 * Three signals are combined into one list of attention regions:
 *   - 'low-conf'     recognized lines whose calibrated confidence is weak,
 *                    by p10 (robust-worst char) OR by the single worst char -
 *                    a clean line with one smudged word still gets flagged;
 *   - 'coverage-gap' OCR text that landed OUTSIDE every recognized layout
 *                    region (orphan clusters). This is the typical signature
 *                    of scribbles/noise: the detector reads *something* but
 *                    layout can't place it, so it may be mangled or missing
 *                    from the assembled text entirely;
 *   - 'disagreement' cross-model review items from Deep OCR (numeric
 *                    conflicts between the OCR and VLM readings).
 */
import { getCachedSettings } from '../core/settings.js';

/**
 * The user-tunable line threshold lives in settings (lowConfThreshold,
 * default 0.6). The worst-character bar scales with it at 60% so one badly
 * smudged character still flags an otherwise-confident line; at the default
 * that is 0.36.
 */
function thresholds() {
    const t = Number(getCachedSettings().lowConfThreshold);
    const line = Number.isFinite(t) && t > 0 && t < 1 ? t : 0.6;
    return { line, worstChar: line * 0.6 };
}

/** The confidence scalar we triage a line by. Null when the line has none.
 *  Legacy avgConf/conf fields kept for records written by older sessions. */
function lineConfidence(line) {
    if (typeof line?.p10 === 'number') return line.p10;
    if (typeof line?.meanLogProb === 'number') return line.meanLogProb;
    if (typeof line?.avgConf === 'number') return line.avgConf;
    if (typeof line?.conf === 'number') return line.conf;
    return null;
}

/**
 * Everything on one page the abstractor should look at, with page-pixel
 * boxes for overlays and the implicated text for tooltips.
 * @returns {Array<{kind: 'low-conf'|'coverage-gap'|'disagreement',
 *                  box: object|null, text: string, conf: number|null, tip: string}>}
 */
export function attentionRegions(uncertainty) {
    if (!uncertainty) return [];
    const out = [];
    const lines = Array.isArray(uncertainty.lines) ? uncertainty.lines : [];
    const { line: lineThreshold, worstChar } = thresholds();

    for (const line of lines) {
        const conf = lineConfidence(line);
        const worst = typeof line?.min === 'number' ? line.min : null;
        const weak = (typeof conf === 'number' && conf < lineThreshold)
            || (typeof worst === 'number' && worst < worstChar);
        if (!weak) continue;
        const shown = Math.round(((conf ?? worst) || 0) * 100);
        out.push({
            kind: 'low-conf',
            box: line.box || null,
            text: line.text || '',
            conf: conf ?? worst,
            tip: `Low OCR confidence (${shown}%)`,
        });
    }

    const gaps = Array.isArray(uncertainty.coverageGaps) ? uncertainty.coverageGaps : [];
    for (const gap of gaps) {
        const texts = (gap.lineIds || []).map((i) => lines[i]?.text).filter(Boolean);
        out.push({
            kind: 'coverage-gap',
            box: gap.box || null,
            text: texts.join(' '),
            conf: null,
            tip: 'Text outside the recognized layout - check it was captured correctly.',
        });
    }

    const items = Array.isArray(uncertainty.reviewItems) ? uncertainty.reviewItems : [];
    for (const item of items) {
        out.push({
            kind: 'disagreement',
            box: item.box || null,
            text: item.ocrReading || item.vlmReading || '',
            conf: null,
            severity: item.severity,
            tip: `OCR and Deep OCR disagree - OCR read "${item.ocrReading ?? '(nothing)'}", Deep OCR read "${item.vlmReading}".`,
        });
    }

    return out;
}

/** Count of attention regions on one page (badge + doc-level flag). */
export function countLowConfLines(uncertainty) {
    return attentionRegions(uncertainty).length;
}

/** Sum attention regions across a document's OCR page records. */
export function countDocLowConfLines(ocrPages) {
    let n = 0;
    for (const rec of ocrPages || []) n += countLowConfLines(rec?.uncertainty);
    return n;
}
