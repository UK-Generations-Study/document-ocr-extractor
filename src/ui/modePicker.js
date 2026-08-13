/**
 * First-run setup: which halves of the pipeline this machine runs, and whether
 * de-identification is on.
 *
 * Shown once, before anything else mounts, when no mode has been chosen and the
 * build ships no default (src/core/mode.js). It asks which halves of the
 * pipeline this machine runs: reading (OCR + de-identification), extracting
 * (LLM fields), or both.
 *
 * De-identification is asked here rather than in the setup wizard because the
 * wizard only runs where extraction does, and Read mode is exactly where
 * de-identification matters most.
 *
 * Deliberately NOT dismissible. Every other module reads the mode while it is
 * still loading, so there is no coherent "no mode yet" state to run in - the
 * app can only start once the question is answered. It resolves by reloading,
 * which is also how Settings applies a later change.
 *
 * This runs before the workspace mounts, so it renders standalone rather than
 * reusing the modal helpers in toast.js (which assume the shell exists).
 */
import { MODE_COPY, PIPELINE_MODES, setPipelineMode } from '../core/mode.js';
import { getSettings, saveSettings } from '../core/settings.js';
import { isAnalyzerAvailable } from '../deid/presidio.js';

const MOUNT_ID = 'mode-picker-mount';

/** Shown wherever de-identification cannot be switched on. */
export const DEID_UNAVAILABLE_HINT =
    'This application does not support de-identification unless run through Docker, for now.';

function mountEl() {
    let mount = document.getElementById(MOUNT_ID);
    if (!mount) {
        mount = document.createElement('div');
        mount.id = MOUNT_ID;
        document.body.appendChild(mount);
    }
    return mount;
}

const shell = (title, sub, body) => `
<div class="fixed inset-0 z-[60] flex items-center justify-center bg-gray-900/50 p-4">
    <div class="w-full max-w-xl rounded-lg bg-white shadow-xl border border-gray-200" role="dialog" aria-modal="true"
         aria-labelledby="mp-title">
        <div class="px-6 pt-5 pb-3 border-b border-gray-100">
            <h2 id="mp-title" class="text-lg font-semibold text-gray-900">${title}</h2>
            <p class="mt-1 text-sm text-gray-600">${sub}</p>
        </div>
        ${body}
    </div>
</div>`;

/**
 * Render the picker and never resolve - the last step reloads the page.
 * @returns {Promise<never>}
 */
export function openModePicker() {
    const mount = mountEl();

    mount.innerHTML = shell(
        'How will this machine be used?',
        'This tool has two halves and they can run on separate machines. Pick what this one does. You can change it later in Settings.',
        `<div class="p-4 space-y-2">
            ${Object.values(PIPELINE_MODES).map((id) => `
            <button type="button" data-mode="${id}"
                    class="mp-choice w-full text-left rounded-md border border-gray-300 p-3 hover:border-green-600 hover:bg-green-50 focus:outline-none focus:ring-2 focus:ring-green-600">
                <span class="block text-sm font-semibold text-gray-900">${MODE_COPY[id].title}</span>
                <span class="block text-xs text-gray-600 mt-0.5">${MODE_COPY[id].desc}</span>
                <span class="block text-xs text-gray-400 mt-0.5">${MODE_COPY[id].forWhom}</span>
            </button>`).join('')}
        </div>`,
    );

    return new Promise(() => {
        mount.querySelectorAll('.mp-choice').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const mode = btn.dataset.mode;
                // The mirror first: it is what the next boot reads, and it is
                // synchronous, so a failed IndexedDB write cannot leave the app
                // asking the same question forever.
                setPipelineMode(mode);
                try {
                    await saveSettings({ pipelineMode: mode });
                } catch {
                    // Non-fatal - the mirror carries the choice regardless.
                }
                // Extract mode receives text that was de-identified on the
                // machine that read it, so there is nothing to ask about.
                if (mode === PIPELINE_MODES.EXTRACT) {
                    location.reload();
                    return;
                }
                await askDeidentification(mount);
            });
        });
    });
}

/**
 * Second step: de-identification, offered only where an analyzer answers.
 *
 * Availability is probed rather than inferred from the deployment, because the
 * question is whether this page can actually reach an analyzer through its
 * same-origin `/presidio` path. A static host (GitHub Pages) has nothing behind
 * that path; the Docker image has nginx forwarding to the analyzer container;
 * a dev server forwards to whatever the developer is running. Probing gets all
 * three right without the app having to recognise where it is deployed.
 */
async function askDeidentification(mount) {
    const settings = await getSettings();

    mount.innerHTML = shell(
        'Remove personal identifiers?',
        'After OCR, each recognized text region is analyzed and any detected identifiers are replaced with [REDACTED]. Exports and the LLM only ever see the redacted text.',
        `<div class="p-4 space-y-3">
            <label id="mp-deid-label" class="flex items-start gap-3 rounded-md border border-gray-300 p-3">
                <input id="mp-deid" type="checkbox" disabled
                       class="mt-0.5 h-4 w-4 rounded text-green-600 focus:ring-green-500"/>
                <span>
                    <span class="block text-sm font-medium text-gray-900">Remove personal identifiers with Presidio</span>
                    <span id="mp-deid-note" class="block text-xs text-gray-500 mt-0.5">Checking whether an analyzer is available&hellip;</span>
                </span>
            </label>
            <div class="flex justify-end">
                <button id="mp-deid-continue" type="button" disabled
                        class="rounded-md bg-green-800 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-green-700 disabled:opacity-50">
                    Continue
                </button>
            </div>
        </div>`,
    );

    const box = mount.querySelector('#mp-deid');
    const note = mount.querySelector('#mp-deid-note');
    const label = mount.querySelector('#mp-deid-label');
    const go = mount.querySelector('#mp-deid-continue');

    const available = await isAnalyzerAvailable({ base: settings.deidBaseUrl });

    box.disabled = !available;
    box.checked = available;   // on by default wherever it can run
    label.title = available ? '' : DEID_UNAVAILABLE_HINT;
    note.textContent = available
        ? 'An analyzer is available. Leave this on unless you have a reason not to.'
        : DEID_UNAVAILABLE_HINT;
    if (!available) label.classList.add('opacity-60');
    go.disabled = false;

    go.addEventListener('click', async () => {
        go.disabled = true;
        try {
            await saveSettings({ deidEnabled: box.checked });
        } catch {
            // Non-fatal: the default stands and Settings can still change it.
        }
        location.reload();
    });
}
