/**
 * Local Network Access: letting the browser ask before we call a local LLM.
 *
 * Chrome 142 gates requests from a public page into the loopback or local
 * address space behind a permission ("Apps on device" in Chrome and Edge site
 * settings). The catch is that the decision happens BEFORE DNS resolution, so
 * the browser cannot tell that a hostname like `localhost` will resolve into
 * the loopback space. It cannot classify the request, so it refuses it instead
 * of prompting, and the page sees an opaque "Failed to fetch".
 *
 * `targetAddressSpace` on a fetch declares the destination up front. Chrome
 * then knows the request is local, prompts for permission, and exempts it from
 * mixed-content blocking. Without it an operator has to know to find a browser
 * setting they have never heard of; with it they get a prompt they can accept.
 *
 * Only ever declared when the base URL is unambiguously local. Chrome verifies
 * the declaration against the address the host actually resolves to and blocks
 * on a mismatch, so guessing would be worse than saying nothing: a hostname
 * like `llm.internal` gets no declaration, because it could resolve anywhere.
 *
 * Browsers that do not implement this ignore the unknown option, so it is
 * inert everywhere else.
 *
 * https://developer.chrome.com/blog/local-network-access
 * https://github.com/WICG/local-network-access/blob/main/explainer.md
 */

/** 10/8, 172.16/12, 192.168/16 - the RFC 1918 private ranges. */
function isPrivateIPv4(host) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    // 169.254/16 link-local counts as local too.
    return a === 169 && b === 254;
}

function isLoopbackIPv4(host) {
    const m = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(host);
    return !!m && Number(m[1]) === 127;   // all of 127.0.0.0/8
}

/**
 * The address space a URL unambiguously targets, or null when it cannot be
 * known without resolving the name.
 *
 * @param {string} url
 * @returns {'loopback' | 'local' | null}
 */
export function targetAddressSpaceFor(url) {
    let host;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return null;   // not a URL we can reason about
    }
    // URL strips the brackets from an IPv6 literal.
    const bare = host.replace(/^\[|\]$/g, '');

    if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
    if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return 'loopback';
    if (isLoopbackIPv4(host)) return 'loopback';

    if (host.endsWith('.local')) return 'local';
    if (isPrivateIPv4(host)) return 'local';
    // fc00::/7 unique local addresses: first byte fc or fd.
    if (/^f[cd][0-9a-f]{2}:/.test(bare)) return 'local';

    return null;
}

/**
 * A fetch that declares the address space, or undefined to use the browser's.
 *
 * Undefined rather than a pass-through wrapper so callers can hand the result
 * straight to a client that treats `fetch: undefined` as "use the default".
 *
 * @param {string} baseUrl
 * @returns {((input: any, init?: any) => Promise<Response>) | undefined}
 */
export function localNetworkFetch(baseUrl) {
    const targetAddressSpace = targetAddressSpaceFor(baseUrl);
    if (!targetAddressSpace) return undefined;
    return (input, init) => fetch(input, { ...(init || {}), targetAddressSpace });
}
