/**
 * PP-DocLayoutV3 ceil_mode patch (ported from private-eye/scripts/patch-layout.ts).
 *
 * ORT-web 1.26's WebGPU EP claims MaxPool at partition time and then throws
 * "using ceil() in shape computation is not yet supported for MaxPool"
 * (microsoft/onnxruntime#20938). The graph's single MaxPool - the HGNetV2 stem
 * pool - is kernel [2,2], strides [1,1], pads [0,0,0,0]: at stride 1 the
 * ceil/floor output-shape formulas coincide (ceil((x-2)/1) == floor((x-2)/1)),
 * so flipping ceil_mode 1 -> 0 is bit-exact for every input size. Same-length
 * varint edit (1 byte), so every protobuf offset stays valid.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ORIGINAL_NAME = 'PP-DocLayoutV3.onnx';
export const PATCHED_NAME = 'PP-DocLayoutV3.patched.onnx';

const ORIGINAL_SHA256 = 'c0721928ff08741bb208ebed539c77170db5234a68cb7e546e6cc9bc172a695b';
const PATCHED_SHA256 = 'f3ac013cce39d9f180db17d6f303b3b4892cf8acdcd8510efbc7edf0214489ae';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function findUnique(buf, pattern, what) {
    const first = buf.indexOf(pattern);
    if (first === -1 || buf.indexOf(pattern, first + 1) !== -1) {
        throw new Error(`${what} not found (or ambiguous) in ${ORIGINAL_NAME} - re-verify the ceil_mode patch`);
    }
    return first;
}

function expectBytes(buf, at, expected, what) {
    for (let i = 0; i < expected.length; i++) {
        if (buf[at + i] !== expected[i]) {
            throw new Error(
                `${what}: expected ${expected.map((b) => b.toString(16).padStart(2, '0')).join(' ')} at offset ${at}, ` +
                `found ${buf.subarray(at, at + expected.length).toString('hex')}`,
            );
        }
    }
}

function attrBytes(name, ints) {
    return Buffer.concat([
        Buffer.from([0x0a, name.length]),
        Buffer.from(name, 'ascii'),
        Buffer.from(ints.flatMap((v) => [0x40, v])),
    ]);
}

/**
 * Patch the original PP-DocLayoutV3.onnx graph at `dir`. Returns the path to
 * the patched file. Idempotent - returns the cached patched file if present.
 */
export function ensurePatchedLayoutModel(dir) {
    const originalPath = join(dir, ORIGINAL_NAME);
    const patchedPath = join(dir, PATCHED_NAME);
    if (!existsSync(originalPath)) {
        throw new Error(`${originalPath} does not exist; fetch it first`);
    }
    if (existsSync(patchedPath) && sha256(readFileSync(patchedPath)) === PATCHED_SHA256) {
        return patchedPath;
    }

    const buf = readFileSync(originalPath);
    const origSha = sha256(buf);
    if (origSha !== ORIGINAL_SHA256) {
        throw new Error(
            `${ORIGINAL_NAME} sha256 ${origSha} != pinned ${ORIGINAL_SHA256} - ` +
            'upstream model changed; re-verify the MaxPool ceil_mode patch before re-pinning',
        );
    }

    // Locate the single ceil_mode AttributeProto:
    //   2a 10            NodeProto.attribute, len 16
    //   0a 09 ceil_mode  AttributeProto.name
    //   18 01            AttributeProto.i = 1   <-- byte to flip
    //   a0 01 02         AttributeProto.type = INT
    const s = findUnique(buf, Buffer.from('ceil_mode', 'ascii'), 'ceil_mode attribute');
    expectBytes(buf, s - 4, [0x2a, 0x10, 0x0a, 0x09], 'attribute header');
    expectBytes(buf, s + 9, [0x18, 0x01, 0xa0, 0x01, 0x02], 'attribute value/type');

    const before = buf.subarray(Math.max(0, s - 64), s);
    const after = buf.subarray(s, s + 96);
    const opType = Buffer.concat([Buffer.from([0x22, 0x07]), Buffer.from('MaxPool', 'ascii')]);
    const nodeName = Buffer.concat([Buffer.from([0x1a, 0x0f]), Buffer.from('node_max_pool2d', 'ascii')]);
    if (!before.includes(opType) || !before.includes(nodeName)) {
        throw new Error('ceil_mode attribute is not on MaxPool "node_max_pool2d" - re-verify the patch');
    }
    if (!after.includes(attrBytes('strides', [1, 1]))) {
        throw new Error('MaxPool strides != [1,1] - flip is only bit-exact at stride 1');
    }
    if (!after.includes(attrBytes('kernel_shape', [2, 2]))) {
        throw new Error('MaxPool kernel_shape != [2,2] - graph changed');
    }

    const out = Buffer.from(buf);
    out[s + 10] = 0x00; // AttributeProto.i: 1 -> 0
    const patchedSha = sha256(out);
    if (patchedSha !== PATCHED_SHA256) {
        throw new Error(`patched sha256 ${patchedSha} != pinned ${PATCHED_SHA256}`);
    }
    writeFileSync(patchedPath, out);
    return patchedPath;
}
