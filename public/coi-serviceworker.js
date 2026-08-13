/*! coi-serviceworker v0.1.7 — https://github.com/gzuidhof/coi-serviceworker — MIT License
 *
 * GitHub Pages cannot send COOP/COEP headers, so this service worker synthesizes
 * cross-origin isolation: it re-serves the navigation + subresources with
 * Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy:
 * require-corp, and adds Cross-Origin-Resource-Policy: cross-origin to
 * cross-origin responses (so the HuggingFace model downloads pass COEP). With
 * isolation active, wllama runs multithreaded (~3x faster). On the first visit
 * the page reloads once through the worker to become isolated.
 */
let coepCredentialless = false;
if (typeof window === 'undefined') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener('message', (ev) => {
    if (!ev.data) return;
    if (ev.data.type === 'deregister') {
      self.registration
        .unregister()
        .then(() => self.clients.matchAll())
        .then((clients) => clients.forEach((client) => client.navigate(client.url)));
    } else if (ev.data.type === 'coepCredentialless') {
      coepCredentialless = ev.data.value;
    }
  });

  /**
   * LOCAL PATCH (not upstream): is this URL in the loopback or local address
   * space? Mirrors src/core/localNetwork.js, which a worker script cannot
   * import. Keep the two in step.
   */
  const isLocalAddressSpace = (url) => {
    let host;
    try {
      host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    } catch {
      return false;
    }
    return (
      host === 'localhost' || host.endsWith('.localhost') ||
      host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) ||
      host.endsWith('.local') ||
      /^127\.\d+\.\d+\.\d+$/.test(host) ||
      /^10\.\d+\.\d+\.\d+$/.test(host) ||
      /^192\.168\.\d+\.\d+$/.test(host) ||
      /^169\.254\.\d+\.\d+$/.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host)
    );
  };

  self.addEventListener('fetch', function (event) {
    const r = event.request;
    if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;

    // LOCAL PATCH (not upstream). Leave cross-origin requests into the local
    // or loopback address space entirely alone.
    //
    // Chrome gates those behind the Local Network Access permission, and a
    // request only gets a prompt if it declares where it is going via the
    // `targetAddressSpace` fetch option (src/core/localNetwork.js sets it for
    // a local LLM endpoint). That option lives on the fetch INIT, not on the
    // Request object. Re-issuing the request below as `fetch(request)` drops
    // it, so the declared request the page made arrives at the network
    // undeclared and Chrome refuses it: "Permission was denied for this
    // request to access the loopback address space".
    //
    // Nothing is lost by skipping them. This worker exists to synthesize
    // COOP/COEP on a host that cannot send headers, and neither header changes
    // anything about a cross-origin API call the page makes.
    //
    // Deliberately narrow: same-origin requests still go through (the document
    // needs the headers), and so do cross-origin PUBLIC ones, which need the
    // Cross-Origin-Resource-Policy added below for the model downloads to pass
    // COEP in require-corp mode.
    if (r.url.indexOf(self.location.origin) !== 0 && isLocalAddressSpace(r.url)) return;

    const request =
      coepCredentialless && r.mode === 'no-cors' ? new Request(r, { credentials: 'omit' }) : r;
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.status === 0) return response;
          const newHeaders = new Headers(response.headers);
          newHeaders.set('Cross-Origin-Embedder-Policy', coepCredentialless ? 'credentialless' : 'require-corp');
          if (!coepCredentialless) newHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');
          newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        })
        // Returning undefined here made respondWith throw "Failed to convert
        // value to 'Response'", burying the real error under a second one.
        // Response.error() surfaces it to the page as a plain network failure.
        .catch((e) => {
          console.error(e);
          return Response.error();
        }),
    );
  });
} else {
  (() => {
    const reloadedBySelf = window.sessionStorage.getItem('coiReloadedBySelf');
    window.sessionStorage.removeItem('coiReloadedBySelf');
    const coepDegrading = reloadedBySelf == 'coepdegrade';

    const n = navigator;
    if (n.serviceWorker && n.serviceWorker.controller) {
      n.serviceWorker.controller.postMessage({
        type: 'coepCredentialless',
        value: coepDegrading || (window.coi && typeof window.coi.coepCredentialless === 'function' && window.coi.coepCredentialless()),
      });
    }

    if (!window.crossOriginIsolated && !coepDegrading) {
      if (n.serviceWorker && n.serviceWorker.controller) {
        if (window.sessionStorage.getItem('coiReloadedBySelf') == null) {
          window.sessionStorage.setItem('coiReloadedBySelf', 'coepdegrade');
        }
      }
    }

    const coi = {
      shouldRegister: () => !reloadedBySelf,
      shouldDeregister: () => false,
      coepCredentialless: () => !(window.chrome !== undefined || window.netscape !== undefined),
      doReload: () => window.location.reload(),
      quiet: false,
      ...window.coi,
    };

    const controlling = n.serviceWorker && n.serviceWorker.controller;
    if (controlling && coi.shouldDeregister()) {
      n.serviceWorker.controller.postMessage({ type: 'deregister' });
    }

    if (window.crossOriginIsolated !== false || !coi.shouldRegister()) return;

    if (!window.isSecureContext) {
      !coi.quiet && console.log('COOP/COEP Service Worker not registered, a secure context is required.');
      return;
    }

    if (n.serviceWorker) {
      n.serviceWorker.register(window.document.currentScript.src).then(
        (registration) => {
          !coi.quiet && console.log('COOP/COEP Service Worker registered', registration.scope);
          registration.addEventListener('updatefound', () => {
            !coi.quiet && console.log('Reloading page to make use of updated COOP/COEP Service Worker.');
            window.sessionStorage.setItem('coiReloadedBySelf', 'updatefound');
            coi.doReload();
          });
          if (registration.active && !n.serviceWorker.controller) {
            !coi.quiet && console.log('Reloading page to make use of COOP/COEP Service Worker.');
            window.sessionStorage.setItem('coiReloadedBySelf', 'notcontrolling');
            coi.doReload();
          }
        },
        (err) => {
          !coi.quiet && console.error('COOP/COEP Service Worker failed to register:', err);
        },
      );
    }
  })();
}
