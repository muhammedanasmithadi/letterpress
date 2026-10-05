/**
 * Verification through poppler rather than hand-rolled PDF parsing. Poppler is
 * an independent implementation, so agreement between it and the renderer's own
 * output is real evidence rather than a regex agreeing with itself.
 */
import { readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const TMP = process.env.TMPDIR ?? "/tmp";
let counter = 0;

async function withPdf<T>(bytes: Uint8Array, fn: (path: string) => Promise<T>): Promise<T> {
  const path = `${TMP}/letterpress-verify-${process.pid}-${counter++}.pdf`;
  await Bun.write(path, bytes);
  try { return await fn(path); } finally { await rm(path, { force: true }).catch(() => {}); }
}

export type PopplerInfo = {
  pages: number;
  pageSize: string;
  encrypted: boolean;
  /** Document title from the metadata. Chromium takes this from the page URL. */
  title: string;
};

export async function pdfInfo(bytes: Uint8Array): Promise<PopplerInfo> {
  return withPdf(bytes, async (path) => {
    const out = await Bun.$`pdfinfo ${path}`.quiet().text();
    return {
      pages: Number(out.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0),
      pageSize: out.match(/^Page size:\s+(.+)$/m)?.[1]?.trim() ?? "",
      encrypted: /^Encrypted:\s+yes/m.test(out),
      title: out.match(/^Title:\s+(.*)$/m)?.[1] ?? "",
    };
  });
}

export async function pdfText(bytes: Uint8Array): Promise<string> {
  return withPdf(bytes, async (path) => {
    const proc = Bun.spawn(["pdftotext", "-layout", path, "-"], { stdout: "pipe", stderr: "ignore" });
    // Drain the pipe and wait for exit. Reading the stream to end without
    // awaiting the process races: under load pdftotext has not finished writing
    // when the reader closes, which returns truncated text and fails a test for
    // no reason.
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return out;
  });
}

export async function pdfFonts(bytes: Uint8Array): Promise<string> {
  return withPdf(bytes, async (path) => (await Bun.$`pdffonts ${path}`.quiet().text()));
}

export type PdfImage = { page: number; type: string; width: number; height: number };

export async function pdfImages(bytes: Uint8Array): Promise<PdfImage[]> {
  return withPdf(bytes, async (path) => {
    const out = await Bun.$`pdfimages -list ${path}`.quiet().text();
    const rows = out.split("\n").slice(2);
    const images: PdfImage[] = [];
    for (const row of rows) {
      const m = row.trim().match(/^(\d+)\s+(\d+)\s+(\w+)\s+(\d+)\s+(\d+)\s/);
      if (m) {
        images.push({
          page: Number(m[1]),
          // pdfimages lists a soft mask beside every picture with an alpha
          // channel, at the same dimensions. Without the type a caller counting
          // "how many images are in this pdf" gets two for one picture.
          type: m[3],
          width: Number(m[4]),
          height: Number(m[5]),
        });
      }
    }
    return images;
  });
}

/** Rasterise pages to PNG for visual checks. */
export async function pdfToPng(bytes: Uint8Array, { dpi = 110, prefix }: { dpi?: number; prefix?: string } = {}) {
  const base = prefix ?? `${TMP}/letterpress-png-${process.pid}-${counter++}`;
  return withPdf(bytes, async (path) => {
    await Bun.$`pdftoppm -png -r ${dpi} ${path} ${base}`.quiet();
    // The output files are found by matching, not by counting. An earlier version
    // probed for `<base>-01.png`, `-02.png` and so on, which was how older poppler
    // padded, but poppler 26.01 writes `<base>-1.png` with no padding. The probe
    // therefore matched nothing and this function returned an empty list for every
    // document, silently: a caller comparing two page-image lists compared nothing
    // and passed. Padding also stops being two digits past page 99, so a count-based
    // probe is wrong for a long document whichever way it is written.
    const dir = dirname(base);
    const stem = basename(base);
    const entries = await readdir(dir).catch(() => [] as string[]);
    const pages: Array<{ page: number; path: string }> = [];
    for (const name of entries) {
      if (!name.startsWith(`${stem}-`)) continue;
      const m = /^(\d+)\.png$/.exec(name.slice(stem.length + 1));
      if (m) pages.push({ page: Number(m[1]), path: join(dir, name) });
    }
    return pages.sort((a, b) => a.page - b.page).map((x) => x.path);
  });
}