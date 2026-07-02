/**
 * Right-pane extraction form (Phase 5).
 *
 * When the selected doc has status extraction-done, extraction-running,
 * confirmed, or exported, this view owns the right pane. It:
 *   - shows an inline progress readout while extraction runs;
 *   - renders one collapsible section per schema, with a schema-driven
 *     editable form inside;
 *   - persists edits back into doc.extractions[schemaId].data on blur/change;
 *   - offers a "Confirm extraction" button that transitions extraction-done
 *     -> confirmed. Once confirmed the form is read-only until Reopen.
 *
 * The form recognises the target-style JSON Schema shapes:
 *   - "type": ["string", "null"] + enum -> select with a null option
 *   - array with items.enum -> multi-select (tag list of buttons)
 *   - boolean -> tri-state select (true / false / null)
 *   - number/integer -> number input (blank = null)
 *   - string (no enum) -> text input
 * `x-enumDescriptions` become inline hints under the enum select.
 * `x-unit` shows next to the number label. `description` becomes a
 * subtitle under the field label.
 */
import { getConfigRecord, getDocument, putDocument } from '../db.js';
import { enqueueExtraction, subscribeExtract } from '../extract/extract.js';

const MOUNT_ID = 'work-surface';

let currentDocId = null;
// Per-doc scratchpad of extraction lifecycle info (progress, error).
const extractState = new Map();
let ownsPane = false;

export function initExtractionView() {
    subscribeExtract((ev) => {
        if (!ev.docId) return;
        const st = extractState.get(ev.docId) || {};
        if (ev.type === 'doc-start') { st.running = true; st.done = false; st.error = null; st.completed = 0; }
        if (ev.type === 'schema-start') { st.schemaIndex = ev.schemaIndex; st.schemaCount = ev.schemaCount; st.schemaTitle = ev.schemaTitle; }
        if (ev.type === 'schema-done') { st.completed = (st.completed || 0) + 1; }
        if (ev.type === 'schema-error') { st.completed = (st.completed || 0) + 1; st.lastError = ev.error?.message || String(ev.error); }
        if (ev.type === 'doc-done') { st.running = false; st.done = true; st.load = null; }
        if (ev.type === 'doc-error') { st.error = ev.error?.message || String(ev.error); st.running = false; }
        if (ev.type === 'load-progress') {
            st.load = { progress: ev.progress, text: ev.text };
        }
        extractState.set(ev.docId, st);
        if (ownsPane && currentDocId === ev.docId) render();
    });
}

/** Called by the workPane router when the extraction view should be visible. */
export async function showExtractionFor(docId) {
    ownsPane = true;
    currentDocId = docId;
    await render();
}

export function releaseExtractionPane() {
    ownsPane = false;
    currentDocId = null;
}

async function render() {
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;
    if (!currentDocId) return;
    const doc = await getDocument(currentDocId);
    if (!doc || currentDocId !== doc.id) return;

    mount.classList.remove('items-center', 'justify-center');
    mount.classList.add('items-stretch');

    const st = extractState.get(doc.id) || {};

    // ocr-confirmed shows a "waiting to start" state; extraction-running
    // shows progress; extraction-done / confirmed / exported show the form.
    if (doc.status === 'ocr-confirmed' && !st.running) {
        mount.innerHTML = waitingStateHtml(doc);
        wireStartHandlers(mount, doc);
        return;
    }
    if (doc.status === 'extraction-running' || st.running) {
        mount.innerHTML = progressHtml(doc, st);
        return;
    }
    // Fetch the schemas from appConfig so the form can render typed inputs.
    const appConfig = await getConfigRecord('appConfig');
    const schemas = appConfig?.schemaFiles || [];
    mount.innerHTML = formHtml(doc, st, schemas);
    wireFormHandlers(mount, doc);
}

function waitingStateHtml(doc) {
    return `
<div class="max-w-3xl mx-auto space-y-3">
    ${headerHtml(doc, { label: 'OCR confirmed - ready to extract.', tone: 'text-green-700', controls: `
<button id="ex-start" type="button"
    class="rounded-md bg-green-800 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-green-700">
    Extract fields
</button>
<button id="ex-reopen" type="button"
    class="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
    Reopen OCR
</button>`})}
    <div class="text-sm text-gray-600 border border-gray-200 rounded p-4 bg-gray-50">
        The confirmed OCR text will be sent to the configured LLM once per schema.
    </div>
</div>`;
}

function progressHtml(doc, st) {
    // If a WebLLM load is in flight, that dominates - the model download
    // and the (empty) extraction share the same UI slot, but downloading
    // matters more visually.
    if (st.load && (st.load.progress ?? 0) < 1) {
        const loadPct = Math.max(1, Math.round((st.load.progress ?? 0) * 100));
        return `
<div class="max-w-3xl mx-auto space-y-3">
    ${headerHtml(doc, { label: 'Loading in-browser model...', tone: 'text-purple-700' })}
    <div class="border border-purple-200 rounded p-4 bg-purple-50 text-sm text-purple-900 space-y-2">
        <div>${escapeHtml(st.load.text || 'Downloading and initializing the model.')}</div>
        <div class="w-full h-1.5 bg-purple-200 rounded overflow-hidden">
            <div class="h-full bg-purple-500 transition-all" style="width:${loadPct}%"></div>
        </div>
        <div class="text-xs text-purple-700">First run only. Later runs reuse the cached model.</div>
    </div>
</div>`;
    }
    const pct = st.schemaCount ? Math.round(((st.completed || 0) / st.schemaCount) * 100) : 5;
    return `
<div class="max-w-3xl mx-auto space-y-3">
    ${headerHtml(doc, { label: 'Extracting fields...', tone: 'text-amber-700' })}
    <div class="border border-amber-200 rounded p-4 bg-amber-50 text-sm text-amber-900 space-y-2">
        <div>${st.schemaTitle ? `Extracting ${escapeHtml(st.schemaTitle)}` : 'Preparing extraction'}
            ${st.schemaCount ? ` (${(st.completed || 0)} / ${st.schemaCount} schemas)` : ''}</div>
        <div class="w-full h-1.5 bg-amber-200 rounded overflow-hidden">
            <div class="h-full bg-amber-500 transition-all" style="width:${pct}%"></div>
        </div>
        ${st.lastError ? `<div class="text-xs text-red-700">Last schema failed: ${escapeHtml(st.lastError)}</div>` : ''}
    </div>
</div>`;
}

function formHtml(doc, st, schemas) {
    const confirmed = ['confirmed', 'exported'].includes(doc.status);
    const controls = confirmed
        ? `<button id="ex-reopen-confirmed" type="button"
                class="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
                Reopen for edit
            </button>`
        : `<button id="ex-confirm" type="button"
                class="rounded-md bg-green-800 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-green-700">
                Confirm extraction
            </button>
            <button id="ex-rerun" type="button"
                class="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
                Re-run extraction
            </button>`;

    const statusLine = confirmed
        ? { label: 'Extraction confirmed.', tone: 'text-green-700' }
        : { label: 'Extraction complete - review and edit.', tone: 'text-amber-700' };

    const bodies = (doc.extractions || []).map((extraction, idx) => {
        const schema = schemas[extraction.schemaId] || schemas[idx] || null;
        return `<section class="border border-gray-200 rounded bg-white shadow-sm">
    <header class="px-3 py-2 border-b border-gray-100 flex items-center justify-between">
        <div class="text-sm font-medium text-gray-800">${escapeHtml(schema?.title || extraction.schemaTitle || `Schema ${idx + 1}`)}</div>
        ${extraction.error ? `<div class="text-xs text-red-700">${escapeHtml(extraction.error)}</div>` : ''}
    </header>
    <div class="p-4 space-y-4" data-schema-index="${idx}">
        ${renderFieldsHtml(schema, extraction.data || {}, confirmed)}
    </div>
</section>`;
    }).join('');

    return `
<div class="max-w-3xl mx-auto space-y-3">
    ${headerHtml(doc, { ...statusLine, controls })}
    ${bodies || '<div class="text-sm text-gray-500 border border-gray-200 rounded p-4">No extraction data.</div>'}
    ${st.lastError ? `<div class="text-xs text-red-700 border border-red-200 rounded p-3 bg-red-50">${escapeHtml(st.lastError)}</div>` : ''}
</div>`;
}

function headerHtml(doc, { label, tone, controls }) {
    return `
<div class="sticky top-0 z-10 -mx-4 px-4 py-2 bg-white/90 backdrop-blur border-b border-gray-200 flex items-center justify-between">
    <div class="text-xs text-gray-500 truncate">${escapeHtml(doc.name)}</div>
    <div class="flex items-center gap-2">
        <span class="text-xs ${tone || 'text-gray-500'}">${label}</span>
        ${controls || ''}
    </div>
</div>`;
}

// ---------- schema-driven field rendering ----------

function renderFieldsHtml(schema, data, readonly) {
    if (!schema?.properties) {
        // No schema loaded (or the appConfig has since changed): render generic KV.
        const keys = Object.keys(data || {});
        if (!keys.length) return '<div class="text-sm text-gray-500">No fields extracted.</div>';
        return keys.map((k) => genericFieldHtml(k, data[k], readonly)).join('');
    }
    return Object.entries(schema.properties).map(([key, prop]) => fieldHtml(key, prop, data?.[key], readonly)).join('');
}

function fieldHtml(key, prop, value, readonly) {
    const types = Array.isArray(prop.type) ? prop.type : (prop.type ? [prop.type] : []);
    const nullable = types.includes('null');
    const desc = prop.description ? `<div class="text-xs text-gray-500 mt-0.5 leading-snug">${escapeHtml(prop.description)}</div>` : '';
    const unit = prop['x-unit'] ? `<span class="text-xs text-gray-400 ml-2">(${escapeHtml(prop['x-unit'])})</span>` : '';
    const labelHtml = `<label class="block text-sm font-medium text-gray-800">${escapeHtml(key)}${unit}</label>${desc}`;

    // enum (string or number) - <select>.
    if (Array.isArray(prop.enum)) {
        const options = prop.enum.map((v) => {
            const label = v === null ? '(null)' : String(v);
            const selected = value === v || (value == null && v == null) ? 'selected' : '';
            return `<option value="${v === null ? '__null__' : escapeAttr(String(v))}" ${selected}>${escapeHtml(label)}</option>`;
        }).join('');
        const enumDescs = prop['x-enumDescriptions'];
        const enumDescHtml = Array.isArray(enumDescs)
            ? `<details class="mt-1"><summary class="text-xs text-gray-500 cursor-pointer select-none">what each value means</summary><ul class="mt-1 pl-4 list-disc text-xs text-gray-500 space-y-0.5">${enumDescs.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul></details>`
            : '';
        return `
<div class="space-y-1" data-field="${escapeAttr(key)}" data-kind="enum">
    ${labelHtml}
    <select class="ex-input w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600" ${readonly ? 'disabled' : ''}>
        ${options}
    </select>
    ${enumDescHtml}
</div>`;
    }

    // array<enum> - a tag list with each enum value being toggleable.
    if (types.includes('array') && prop.items?.enum) {
        const current = Array.isArray(value) ? new Set(value) : new Set();
        const chips = prop.items.enum.map((v) => {
            const on = current.has(v);
            return `<button type="button" data-arr-val="${escapeAttr(String(v))}"
                class="ex-chip rounded-md border ${on ? 'bg-green-100 border-green-400 text-green-800' : 'bg-white border-gray-300 text-gray-700'} px-2 py-1 text-xs"
                ${readonly ? 'disabled' : ''}>${escapeHtml(String(v))}</button>`;
        }).join(' ');
        return `
<div class="space-y-1" data-field="${escapeAttr(key)}" data-kind="array-enum">
    ${labelHtml}
    <div class="flex flex-wrap gap-1">${chips}</div>
</div>`;
    }

    // boolean - tri-state select if nullable, else checkbox.
    if (types.includes('boolean')) {
        if (nullable) {
            const opts = [
                { v: 'true', label: 'true', match: value === true },
                { v: 'false', label: 'false', match: value === false },
                { v: '__null__', label: '(null)', match: value == null },
            ].map((o) => `<option value="${o.v}" ${o.match ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
            return `
<div class="space-y-1" data-field="${escapeAttr(key)}" data-kind="bool-nullable">
    ${labelHtml}
    <select class="ex-input w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600" ${readonly ? 'disabled' : ''}>${opts}</select>
</div>`;
        }
        return `
<div class="flex items-center gap-2" data-field="${escapeAttr(key)}" data-kind="bool">
    <input type="checkbox" class="ex-input h-4 w-4 rounded text-green-600 focus:ring-green-500" ${value === true ? 'checked' : ''} ${readonly ? 'disabled' : ''}/>
    ${labelHtml}
</div>`;
    }

    // number / integer - number input; blank means null when nullable.
    if (types.includes('number') || types.includes('integer')) {
        const step = types.includes('integer') ? '1' : 'any';
        const val = value == null ? '' : String(value);
        return `
<div class="space-y-1" data-field="${escapeAttr(key)}" data-kind="number">
    ${labelHtml}
    <input type="number" step="${step}" value="${escapeAttr(val)}"
        class="ex-input w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"
        ${readonly ? 'readonly' : ''} placeholder="${nullable ? '(leave blank for null)' : ''}"/>
</div>`;
    }

    // string (no enum) - text input; blank means null when nullable.
    const val = value == null ? '' : String(value);
    return `
<div class="space-y-1" data-field="${escapeAttr(key)}" data-kind="string">
    ${labelHtml}
    <input type="text" value="${escapeAttr(val)}"
        class="ex-input w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"
        ${readonly ? 'readonly' : ''} placeholder="${nullable ? '(leave blank for null)' : ''}"/>
</div>`;
}

function genericFieldHtml(key, value, readonly) {
    const label = `<label class="block text-sm font-medium text-gray-800">${escapeHtml(key)}</label>`;
    if (Array.isArray(value)) {
        return `
<div class="space-y-1" data-field="${escapeAttr(key)}" data-kind="generic-array">
    ${label}
    <input type="text" value="${escapeAttr(JSON.stringify(value))}" class="ex-input w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm font-mono" ${readonly ? 'readonly' : ''}/>
</div>`;
    }
    if (typeof value === 'boolean') {
        return `
<div class="flex items-center gap-2" data-field="${escapeAttr(key)}" data-kind="bool">
    <input type="checkbox" class="ex-input h-4 w-4" ${value ? 'checked' : ''} ${readonly ? 'disabled' : ''}/>
    ${label}
</div>`;
    }
    const val = value == null ? '' : String(value);
    return `
<div class="space-y-1" data-field="${escapeAttr(key)}" data-kind="string">
    ${label}
    <input type="text" value="${escapeAttr(val)}" class="ex-input w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm" ${readonly ? 'readonly' : ''}/>
</div>`;
}

// ---------- handlers ----------

function wireStartHandlers(mount, doc) {
    mount.querySelector('#ex-start')?.addEventListener('click', () => {
        enqueueExtraction(doc.id);
    });
    mount.querySelector('#ex-reopen')?.addEventListener('click', async () => {
        const d = await getDocument(doc.id);
        if (!d) return;
        d.status = 'ocr-done';
        await putDocument(d);
        // The router will notice the status flip and swap back to the OCR view.
    });
}

function wireFormHandlers(mount, doc) {
    mount.querySelector('#ex-confirm')?.addEventListener('click', async () => {
        const d = await getDocument(doc.id);
        if (!d) return;
        d.status = 'confirmed';
        await putDocument(d);
        render();
    });
    mount.querySelector('#ex-reopen-confirmed')?.addEventListener('click', async () => {
        const d = await getDocument(doc.id);
        if (!d) return;
        d.status = 'extraction-done';
        await putDocument(d);
        render();
    });
    mount.querySelector('#ex-rerun')?.addEventListener('click', async () => {
        const d = await getDocument(doc.id);
        if (!d) return;
        d.status = 'ocr-confirmed';
        await putDocument(d);
        enqueueExtraction(doc.id);
        render();
    });

    // Field edits: persist on change/blur.
    mount.querySelectorAll('[data-schema-index]').forEach((section) => {
        const schemaIndex = Number(section.dataset.schemaIndex);
        section.querySelectorAll('[data-field]').forEach((fieldEl) => {
            const key = fieldEl.dataset.field;
            const kind = fieldEl.dataset.kind;
            const input = fieldEl.querySelector('.ex-input');
            if (input) {
                const commit = async () => {
                    const d = await getDocument(doc.id);
                    if (!d) return;
                    const ext = d.extractions?.[schemaIndex];
                    if (!ext) return;
                    ext.data = ext.data || {};
                    ext.data[key] = readValue(kind, input);
                    await putDocument(d);
                };
                input.addEventListener('change', commit);
                input.addEventListener('blur', commit);
            }
            if (kind === 'array-enum') {
                fieldEl.querySelectorAll('.ex-chip').forEach((btn) => {
                    btn.addEventListener('click', async () => {
                        btn.classList.toggle('bg-green-100');
                        btn.classList.toggle('border-green-400');
                        btn.classList.toggle('text-green-800');
                        btn.classList.toggle('bg-white');
                        btn.classList.toggle('border-gray-300');
                        btn.classList.toggle('text-gray-700');
                        const on = Array.from(fieldEl.querySelectorAll('.ex-chip')).filter((b) => b.classList.contains('bg-green-100'));
                        const values = on.map((b) => b.dataset.arrVal);
                        const d = await getDocument(doc.id);
                        if (!d) return;
                        const ext = d.extractions?.[schemaIndex];
                        if (!ext) return;
                        ext.data = ext.data || {};
                        ext.data[key] = values.length ? values : null;
                        await putDocument(d);
                    });
                });
            }
        });
    });
}

function readValue(kind, input) {
    if (kind === 'bool') return !!input.checked;
    if (kind === 'bool-nullable') {
        const v = input.value;
        if (v === 'true') return true;
        if (v === 'false') return false;
        return null;
    }
    if (kind === 'enum') {
        const v = input.value;
        return v === '__null__' ? null : v;
    }
    if (kind === 'number') {
        const v = input.value.trim();
        if (v === '') return null;
        const n = Number(v);
        return Number.isNaN(n) ? null : n;
    }
    if (kind === 'string') {
        const v = input.value;
        return v === '' ? null : v;
    }
    if (kind === 'generic-array') {
        try { return JSON.parse(input.value); } catch { return input.value; }
    }
    return input.value;
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
