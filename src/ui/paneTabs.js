/**
 * Text / Fields tabs shown top-right of the work pane, in both the OCR view
 * and the extraction view, so the abstractor can flip between the report's
 * OCR text and its extracted fields at any time.
 *
 * The Fields tab is greyed out until the document has entered the extraction
 * side of the pipeline (EXTRACTION_PANE_STATUSES). Clicks emit `set-pane`;
 * app.js owns the per-doc override that routeWorkPane consults.
 */
import { emitAppEvent } from '../core/bus.js';
import { EXTRACTION_PANE_STATUSES } from '../core/status.js';

export function paneTabsHtml(doc, active) {
    const fieldsEnabled = EXTRACTION_PANE_STATUSES.has(doc.status);
    const base = 'px-2.5 py-1 text-[11px] font-medium whitespace-nowrap';
    const on = 'bg-green-800 text-white';
    const off = 'bg-white text-gray-600 hover:bg-gray-50';
    const disabled = 'bg-white text-gray-300 cursor-not-allowed';
    return `
<div class="inline-flex rounded-md ring-1 ring-gray-300 overflow-hidden shadow-sm" role="tablist" aria-label="Work pane view">
    <button type="button" data-pane-tab="ocr" role="tab" aria-selected="${active === 'ocr'}"
            title="The report's OCR text"
            class="${base} ${active === 'ocr' ? on : off}">Text</button>
    <button type="button" data-pane-tab="fields" role="tab" aria-selected="${active === 'fields'}"
            ${fieldsEnabled ? '' : 'disabled'}
            title="${fieldsEnabled ? 'The extracted fields' : 'No extraction yet - confirm the text first'}"
            class="${base} border-l border-gray-200 ${active === 'fields' ? on : fieldsEnabled ? off : disabled}">Fields</button>
</div>`;
}

export function wirePaneTabs(mount, docId) {
    mount.querySelectorAll('[data-pane-tab]').forEach((btn) => {
        btn.addEventListener('click', () => {
            emitAppEvent({
                source: 'ui',
                type: 'set-pane',
                docId,
                pane: btn.dataset.paneTab === 'ocr' ? 'ocr' : null,
            });
        });
    });
}
