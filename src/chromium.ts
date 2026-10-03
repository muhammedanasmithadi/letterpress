/** Binary name or absolute path for the Chromium that does the printing. */
export const CHROMIUM = process.env.HTML2PDF_CHROMIUM ?? "chromium";

/**
 * Bun.which resolves the binary and throws a usable message when it is missing,
 * which beats a bare "spawn ENOENT" from deep inside a render.
 */
export function resolveChromium(): string {
  try {
    return Bun.which(CHROMIUM) ?? CHROMIUM;
  } catch {
    throw new Error(
      `cannot find "${CHROMIUM}" on PATH. Install Chromium, or set HTML2PDF_CHROMIUM to its absolute path.`,
    );
  }
}

/** The slice of Bun.spawn's return value this codebase depends on. */
export type Subprocess = {
  pid: number;
  stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  readonly killed: boolean;
  kill(signal?: number | NodeJS.Signals): void;
};

export type CdpEvent = (params: any) => void;