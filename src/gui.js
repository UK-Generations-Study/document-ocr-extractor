/**
 * Application shell. Renders a persistent header (title + gear), a main flex
 * column split into two vertical zones (top: left/right panes; bottom: report
 * list), and empty mount points for the wizard overlay and settings modal.
 * The panels themselves are populated by later phases:
 *   left  (#report-viewer)      -> Phase 3 (uploaded pages)
 *   right (#work-surface)       -> Phase 4 (OCR text) / Phase 5 (edit form)
 *   bottom (#report-list)       -> Phase 3 (report rows + status)
 */
const marieLogoUrl = 'https://raw.githubusercontent.com/jeyabbalas/medical-report-information-extractor/refs/heads/main/assets/marie_logo.svg';
const githubLogoUrl = 'https://raw.githubusercontent.com/jeyabbalas/medical-report-information-extractor/refs/heads/main/assets/github.svg';
const sourceCodeUrl = 'https://github.com/jeyabbalas/medical-report-information-extractor';

const emptyPanelSvg = `
<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1" class="w-10 h-10 mb-2 opacity-40">
  <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
</svg>`;

function ui(divID) {
    const divUI = divID ? document.getElementById(divID) : document.createElement('div');

    divUI.innerHTML = `
<div class="flex flex-col h-screen bg-gray-50">
    <!-- Header -->
    <header class="flex items-center justify-between px-4 py-2 bg-green-900 text-white shadow-sm shrink-0">
        <div class="flex items-center gap-3 min-w-0">
            <img src="${marieLogoUrl}" class="h-9 w-9 shrink-0" alt="" />
            <h1 class="text-lg font-semibold truncate">Medical Report Information Extractor</h1>
        </div>
        <div class="flex items-center gap-2 shrink-0">
            <button id="open-settings" type="button"
                    class="p-2 rounded-md hover:bg-green-800 focus:outline-none focus:ring-2 focus:ring-green-300"
                    title="Settings" aria-label="Settings">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.75" stroke="currentColor" class="w-5 h-5">
                    <path stroke-linecap="round" stroke-linejoin="round"
                          d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z"/>
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                </svg>
            </button>
            <a title="Source code" target="_blank" href="${sourceCodeUrl}" class="p-2 rounded-md hover:bg-green-800">
                <img src="${githubLogoUrl}" class="h-5 w-5" alt="GitHub" />
            </a>
        </div>
    </header>

    <!-- Main workspace: two vertical zones -->
    <main class="flex-1 flex flex-col min-h-0">
        <!-- Top zone: split left / right -->
        <div class="flex-1 flex min-h-0 divide-x divide-gray-300">
            <!-- Left pane: report viewer (populated by Phase 3) -->
            <section id="report-viewer" class="w-1/2 bg-white overflow-auto p-4 flex items-center justify-center text-gray-400">
                <div class="text-center">
                    ${emptyPanelSvg}
                    <p class="text-sm">Report pages will appear here once uploaded.</p>
                </div>
            </section>

            <!-- Right pane: OCR text / extraction form (populated by Phases 4 & 5) -->
            <section id="work-surface" class="w-1/2 bg-white overflow-auto p-4 flex items-center justify-center text-gray-400">
                <div class="text-center">
                    ${emptyPanelSvg}
                    <p class="text-sm">OCR text and extracted fields will appear here.</p>
                </div>
            </section>
        </div>

        <!-- Bottom zone: report list (populated by Phase 3) -->
        <section id="report-list" class="h-64 border-t-2 border-gray-300 bg-white overflow-auto shrink-0">
            <div class="w-full h-full flex items-center justify-center text-gray-400">
                <div class="text-center">
                    ${emptyPanelSvg}
                    <p class="text-sm">Queued and processed reports will appear here.</p>
                </div>
            </div>
        </section>
    </main>

    <!-- Mount points: filled in on demand by wizard.js / settings modals -->
    <div id="wizard-mount"></div>
    <div id="settings-mount"></div>
</div>
    `;
}

export { ui };
