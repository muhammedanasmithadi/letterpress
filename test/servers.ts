import { afterAll, beforeAll } from 'bun:test';

import { startServer } from '../src/server.ts';

export type TestServer = Awaited<ReturnType<typeof startServer>>;

export async function launchTestServer(): Promise<TestServer> {
  return startServer({ port: 0 });
}

export function serverOrigin(s: TestServer): string {
  return `http://127.0.0.1:${s.port}`;
}

export function useTestServer(): { origin: string } {
  let server: TestServer | undefined;
  beforeAll(async () => {
    server = await launchTestServer();
  }, 90_000);
  afterAll(async () => {
    await server?.stop();
  }, 30_000);
  return {
    get origin() {
      return server ? serverOrigin(server) : '';
    },
  };
}
