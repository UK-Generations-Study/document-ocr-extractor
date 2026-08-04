/**
 * First-run pipeline-mode picker.
 *
 * Shown once, before anything else mounts, when no mode has been chosen and the
 * build ships no default (src/core/mode.js). It asks which halves of the
 * pipeline this machine runs: reading (OCR + de-identification), extracting
 * (LLM fields), or both.
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
import { saveSettings } from '../core/settings.js';

const MOUNT_ID = 'mode-picker-mount';

/**
 * Render the picker and never resolve - the choice reloads the page.
 * @returns {Promise<never>}
 */
export function openModePicker() {
    let mount = document.getElementById(MOUNT_ID);
    if (!mount) {
        mount = document.createElement('div');
        mount.id = MOUNT_ID;
        document.body.appendChild(mount);
    }

    mount.innerHTML = `
<div class="fixed inset-0 z-[60] flex items-center justify-center bg-gray-900/50 p-4">
    <div class="w-full max-w-xl rounded-lg bg-white shadow-xl border border-gray-200" role="dialog" aria-modal="true"
         aria-labelledby="mp-title">
        <div class="px-6 pt-5 pb-3 border-b border-gray-100">
            <h2 id="mp-title" class="text-lg font-semibold text-gray-900">How will this machine be used?</h2>
            <p class="mt-1 text-sm text-gray-600">
                This tool has two halves and they can run on separate machines. Pick what
                this one does. You can change it later in Settings.
            </p>
        </div>
        <div class="p-4 space-y-2">
            ${Object.values(PIPELINE_MODES).map((id) => `
            <button type="button" data-mode="${id}"
                    class="mp-choice w-full text-left rounded-md border border-gray-300 p-3 hover:border-green-600 hover:bg-green-50 focus:outline-none focus:ring-2 focus:ring-green-600">
                <span class="block text-sm font-semibold text-gray-900">${MODE_COPY[id].title}</span>
                <span class="block text-xs text-gray-600 mt-0.5">${MODE_COPY[id].desc}</span>
                <span class="block text-xs text-gray-400 mt-0.5">${MODE_COPY[id].forWhom}</span>
            </button>`).join('')}
        </div>
    </div>
</div>`;

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
                location.reload();
            });
        });
    });
}
