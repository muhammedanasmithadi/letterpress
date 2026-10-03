/**
 * Verification through poppler rather than hand-rolled PDF parsing. Poppler is
 * an independent implementation, so agreement between it and the renderer's own
 * output is real evidence rather than a regex agreeing with itself.
 */
import { rm } from "node:fs/promises";

const TMP = process.env.TMPDIR ?? "/tmp";
let counter = 0;

async function withPdf<T>(bytes: Uint8Array, fn: (path: string) => Promise<T>): Promise<T> {
  const path = `${TMP}/html2pdf-verify-${process.pid}-${counter++}.pdf`;
  await Bun.write(path, bytes);
  try { return await fn(path); } finally { await rm(path, { force: true }).catch(() => {}); }
}

export type PopplerInfo = {
  pages: number;
  pageSize: string;
  encrypted: boolean;
};

export async function pdfInfo(bytes: Uint8Array): Promise<PopplerInfo> {
  return withPdf(bytes, async (path) => {
    const out = await Bun.$`pdfinfo ${path}`.text();
    return {
      pages: Number(out.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0),
      pageSize: out.match(/^Page size:\s+(.+)$/m)?.[1]?.trim() ?? "",
      encrypted: /^Encrypted:\s+yes/m.test(out),
    };
  });
}

export async function pdfText(bytes: Uint8Array): Promise<string> {
  return withPdf(bytes, async (path) => {
    const proc = Bun.spawn(["pdftotext", "-layout", path, "-"], { stdout: "pipe", stderr: "ignore" });
    return new Response(proc.stdout).text();
  });
}

export async function pdfFonts(bytes: Uint8Array): Promise<string> {
  return withPdf(bytes, async (path) => (await Bun.$`pdffonts ${path}`.text()));
}

export type PdfImage = { page: number; width: number; height: number };

export async function pdfImages(bytes: Uint8Array): Promise<PdfImage[]> {
  return withPdf(bytes, async (path) => {
    const out = await Bun.$`pdfimages -list ${path}`.text();
    const rows = out.split("\n").slice(2);
    const images: PdfImage[] = [];
    for (const row of rows) {
      const m = row.trim().match(/^(\d+)\s+(\d+)\s+.*?(\d+)\s+(\d+)\s/);
      if (m) images.push({ page: Number(m[1]), width: Number(m[3]), height: Number(m[4]) });
    }
    return images;
  });
}

/** Rasterise pages to PNG for visual checks. */
export async function pdfToPng(bytes: Uint8Array, { dpi = 110, prefix }: { dpi?: number; prefix?: string } = {}) {
  const base = prefix ?? `${TMP}/html2pdf-png-${process.pid}-${counter++}`;
  return withPdf(bytes, async (path) => {
    await Bun.$`pdftoppm -png -r ${dpi} ${path} ${base}`.quiet();
    const files: string[] = [];
    for (let i = 0; true; i++) {
      const candidate = `${base}-${String(i + 1).padStart(2, "0")}.png`;
      if (!(await Bun.file(candidate).exists())) break;
      files.push(candidate);
    }
    return files;
  });
}