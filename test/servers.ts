import { startServer } from '../src/server.ts';

export type TestServer = Awaited<ReturnType<typeof startServer>>;

export async function launchTestServer(): Promise<TestServer> {
  return startServer({ port: 0 });
}

export function serverOrigin(s: TestServer): string {
  return `http://127.0.0.1:${s.port}`;
}
