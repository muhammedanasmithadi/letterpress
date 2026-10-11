/**
 * JavaScript that runs inside the page, as functions rather than template literals.
 *
 * A template literal is invisible to `tsc`. A free identifier inside one is not a compile
 * error, it is a `ReferenceError` thrown by the browser after the page has rendered, and the
 * CDP call returns nothing so the caller sees an empty result and carries on. That is
 * exactly how `report.push({ at: i, ... })` sat in this file for a commit with no `i` in
 * scope: `bun run typecheck` passed, the tree looked clean, and every document silently
 * stopped being downsampled.
 *
 * Writing these as functions makes the compiler check them, and `Function.prototype
 * .toString` sends the checked source. Each one takes everything it needs as a parameter and
 * references nothing at module scope, so the only names in the shipped source are parameters,
 * locals and DOM globals -- all of which exist in the page for the same reason.
 *
 * The caller interpolates only JSON-encoded literals into the call, so there is no longer any
 * way for a value to leak in from module scope by accident. `tools/lint-ts.mjs` fails the
 * build if a new interpolated page expression appears anywhere in `src`.
 */

/** One image the downsampler measured, with the index it was measured at. */
export type ImageMeasurement = {
  at: number;
  from: number;
  to: number;
  ppi: number;
  url: string;
};

export type ImageReplacement = { at: number; url: string };

/**
 * Measure every image that is both visible and over the cap, and return a JPEG of each at
 * the cap's resolution. Images that cannot be measured are skipped, so the results are a
 * subsequence of `document.images` -- which is why `applyImageReplacements` matches on the
 * index recorded here rather than on position in the returned list.
 */
export function measureImages(MAX: number): string {
  const report: ImageMeasurement[] = [];
  for (let i = 0; i < document.images.length; i++) {
    const img = document.images[i];
    if (!img || !img.naturalWidth) continue;
    const wIn = img.getBoundingClientRect().width / 96;
    if (!wIn) continue;
    const ppi = img.naturalWidth / wIn;
    if (ppi <= MAX) continue;
    const targetW = Math.max(1, Math.round(wIn * MAX));
    const scale = targetW / img.naturalWidth;
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    report.push({
      at: i,
      from: img.naturalWidth,
      to: canvas.width,
      ppi: Math.round(ppi),
      url: canvas.toDataURL('image/jpeg', 0.9),
    });
  }
  return JSON.stringify(report);
}

/** Put each replacement on the image it was measured from, and nothing on any other. */
export function applyImageReplacements(swaps: ImageReplacement[]): boolean {
  for (const e of swaps) {
    const img = document.images[e.at];
    if (img) img.src = e.url;
  }
  return true;
}
