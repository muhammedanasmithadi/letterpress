import { readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const TMP = process.env.TMPDIR ?? '/tmp';
let counter = 0;

async function withPdf<T>(bytes: Uint8Array, fn: (path: string) => Promise<T>): Promise<T> {
  const path = `${TMP}/letterpress-verify-${process.pid}-${counter++}.pdf`;
  await Bun.write(path, bytes);
  try {
    return await fn(path);
  } finally {
    await rm(path, { force: true }).catch(() => {});
  }
}

export type PopplerInfo = {
  pages: number;
  pageSize: string;
  encrypted: boolean;

  title: string;
};

export async function pdfInfo(bytes: Uint8Array): Promise<PopplerInfo> {
  return withPdf(bytes, async (path) => {
    const out = await Bun.$`pdfinfo ${path}`.quiet().text();
    return {
      pages: Number(out.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0),
      pageSize: out.match(/^Page size:\s+(.+)$/m)?.[1]?.trim() ?? '',
      encrypted: /^Encrypted:\s+yes/m.test(out),
      title: out.match(/^Title:\s+(.*)$/m)?.[1] ?? '',
    };
  });
}

export async function pdfText(bytes: Uint8Array): Promise<string> {
  return withPdf(bytes, async (path) => {
    const proc = Bun.spawn(['pdftotext', '-layout', path, '-'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });

    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return out;
  });
}

export async function pdfFonts(bytes: Uint8Array): Promise<string> {
  return withPdf(bytes, async (path) => await Bun.$`pdffonts ${path}`.quiet().text());
}

/** One word as poppler places it, to three decimals. */
export type PdfWord = { xMin: number; yMin: number; xMax: number; yMax: number; text: string };

/**
 * Where poppler thinks every word sits.
 *
 * Text extraction alone will not notice a glyph that moved: poppler reads the word and
 * reports it correctly whatever the coordinates. Comparing the boxes is what catches a
 * position that is wrong while the characters are right.
 */
export async function pdfWords(bytes: Uint8Array): Promise<PdfWord[]> {
  const xml = await withPdf(bytes, async (path) => {
    const proc = Bun.spawn(['pdftotext', '-bbox', path, '-'], { stdout: 'pipe', stderr: 'ignore' });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return out;
  });
  return [
    ...xml.matchAll(
      /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)<\/word>/g,
    ),
  ].map((m) => ({
    xMin: Number(m[1]),
    yMin: Number(m[2]),
    xMax: Number(m[3]),
    yMax: Number(m[4]),
    text: m[5]!,
  }));
}

export type PdfImage = { page: number; type: string; width: number; height: number };

export async function pdfImages(bytes: Uint8Array): Promise<PdfImage[]> {
  return withPdf(bytes, async (path) => {
    const out = await Bun.$`pdfimages -list ${path}`.quiet().text();
    const rows = out.split('\n').slice(2);
    const images: PdfImage[] = [];
    for (const row of rows) {
      const m = row.trim().match(/^(\d+)\s+(\d+)\s+(\w+)\s+(\d+)\s+(\d+)\s/);
      if (m) {
        images.push({
          page: Number(m[1]),

          type: m[3],
          width: Number(m[4]),
          height: Number(m[5]),
        });
      }
    }
    return images;
  });
}

export async function pdfToPng(
  bytes: Uint8Array,
  { dpi = 110, prefix }: { dpi?: number; prefix?: string } = {},
) {
  const base = prefix ?? `${TMP}/letterpress-png-${process.pid}-${counter++}`;
  return withPdf(bytes, async (path) => {
    await Bun.$`pdftoppm -png -r ${dpi} ${path} ${base}`.quiet();

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
