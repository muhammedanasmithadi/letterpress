export const CHROMIUM = process.env.HTML2PDF_CHROMIUM ?? "chromium";

export function resolveChromium(): string {
  try {
    return Bun.which(CHROMIUM) ?? CHROMIUM;
  } catch {
    throw new Error(
      `cannot find "${CHROMIUM}" on PATH. Install Chromium, or set HTML2PDF_CHROMIUM to its absolute path.`,
    );
  }
}

export type Subprocess = {
  pid: number;
  stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  readonly killed: boolean;
  kill(signal?: number | NodeJS.Signals): void;
};

export type CdpEvent = (params: any) => void;
