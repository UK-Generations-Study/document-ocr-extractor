/**
 * Run the `*.test.js` suites under src/, and report.
 *
 * They cannot simply be imported: the modules under test reach into `.ts` for
 * the Markdown serializer, which Node will not load. esbuild is already a
 * devDependency for the build, so each suite is bundled the same way the app is
 * and the result is imported from memory - no transform config, no test
 * framework, and the suites run against exactly what ships.
 *
 * A suite is a module that performs its checks on import and exports `totals`.
 * Bundling them separately is what keeps each one's tally its own.
 */
import { build } from 'esbuild-wasm';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every *.test.js under src/, wherever it sits. */
async function findSuites(dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...await findSuites(full));
        else if (entry.name.endsWith('.test.js')) out.push(full);
    }
    return out.sort();
}

const suites = await findSuites(path.join(root, 'src'));
if (!suites.length) {
    console.error('No *.test.js files found under src/.');
    process.exit(1);
}

let passed = 0;
let failed = 0;

for (const suite of suites) {
    console.log(`\n── ${path.relative(root, suite).replace(/\\/g, '/')}`);
    const result = await build({
        entryPoints: [suite],
        bundle: true,
        platform: 'node',
        format: 'esm',
        write: false,
        absWorkingDir: root,
        logLevel: 'silent',
    });
    // Imported as a data URL rather than written to disk: the bundle is
    // self-contained, so there is nothing to leave behind or clean up.
    const code = result.outputFiles[0].text;
    const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
    const totals = module.totals();
    passed += totals.passed;
    failed += totals.failed;
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
