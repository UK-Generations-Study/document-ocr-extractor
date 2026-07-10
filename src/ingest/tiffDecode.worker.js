/**
 * TIFF -> PNG decode worker. Receives { id, buffer, name }, decodes the first
 * IFD with utif, paints it onto an OffscreenCanvas, and posts back
 * { id, ok, blob, width, height } (or { id, ok: false, error }).
 *
 * Runs in a worker so decoding a large metadata-CSV batch doesn't freeze the
 * main thread; metadataIngest.js keeps a small pool of these.
 */
import UTIF from 'utif';

self.onmessage = async (e) => {
    const { id, buffer, name } = e.data;
    try {
        const ifds = UTIF.decode(buffer);
        if (!ifds || !ifds.length) throw new Error(`no TIFF pages in ${name}`);
        const ifd = ifds[0];
        UTIF.decodeImage(buffer, ifd);
        const rgba = UTIF.toRGBA8(ifd);
        const width = ifd.width;
        const height = ifd.height;
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        self.postMessage({ id, ok: true, blob, width, height });
    } catch (err) {
        self.postMessage({ id, ok: false, error: err?.message || String(err) });
    }
};
