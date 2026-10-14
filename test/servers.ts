/**
 * A server for a test file, torn down with the file.
 *
 * The launch boilerplate (import, handle type, origin URL, start, stop) sat
 * identical in every server-driven suite, and the duplication gate counts it
 * once per file. Same reason test/browser.ts exists for browsers.
 */
import { startServer } from '../src/server.ts';

export type TestServer = Awaited<ReturnType<typeof startServer>>;

export async function launchTestServer(): Promise<TestServer> {
  return startServer({ port: 0 });
}

export function serverOrigin(s: TestServer): string {
  return `http://127.0.0.1:${s.port}`;
}
