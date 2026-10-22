import { describe, expect, test } from 'bun:test';
import { readDevToolsPort } from '../src/browser.ts';

function silentStderr(): {
  stream: ReadableStream<Uint8Array>;
  release: () => void;
} {
  let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
    },
  });
  return { stream, release: () => ctl?.error(new Error('released')) };
}

function fakeProc(stderr: ReadableStream<Uint8Array>): Parameters<typeof readDevToolsPort>[0] {
  return { stderr, exited: new Promise<number>(() => {}) } as unknown as Parameters<
    typeof readDevToolsPort
  >[0];
}

function deadProc(stderr: ReadableStream<Uint8Array>): Parameters<typeof readDevToolsPort>[0] {
  return { stderr, exited: Promise.resolve(1) } as unknown as Parameters<
    typeof readDevToolsPort
  >[0];
}

describe('readDevToolsPort', () => {
  test('a Chromium that never speaks is bounded by the timeout it was given', async () => {
    const { stream, release } = silentStderr();
    const started = Date.now();
    try {
      await expect(readDevToolsPort(fakeProc(stream), 400)).rejects.toThrow(
        /no DevTools endpoint in 400ms/,
      );
    } finally {
      release();
    }
    const elapsed = Date.now() - started;
    expect(elapsed, `took ${elapsed}ms`).toBeLessThan(3_000);
  }, 10_000);

  test('the port is returned as soon as it appears', async () => {
    let push: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stderr = new ReadableStream<Uint8Array>({
      start(c) {
        push = c;
      },
    });
    const started = Date.now();
    const call = readDevToolsPort(fakeProc(stderr), 5_000);
    push!.enqueue(new TextEncoder().encode('DevTools listening on ws://127.0.0.1:9222/\n'));
    expect(await call).toBe(9222);
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 10_000);

  test('a Chromium that has already died is not a Chromium that hung', async () => {
    const { stream } = silentStderr();
    const started = Date.now();
    await expect(readDevToolsPort(deadProc(stream), 30_000)).rejects.toThrow(
      /exited before it exposed a DevTools endpoint/,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('stderr keeps being drained after the port is known', async () => {
    const TOTAL = 64;
    let push: ReadableStreamDefaultController<Uint8Array> | undefined;
    let produced = 0;
    const stderr = new ReadableStream<Uint8Array>({
      start(c) {
        push = c;
      },
      pull(c) {
        if (produced >= TOTAL) return;
        produced++;
        c.enqueue(new TextEncoder().encode('y'.repeat(64 * 1024)));
      },
    });
    try {
      const call = readDevToolsPort(fakeProc(stderr), 5_000);
      push!.enqueue(new TextEncoder().encode('DevTools listening on ws://127.0.0.1:9333/\n'));
      expect(await call).toBe(9333);

      for (let i = 0; i < TOTAL + 20; i++)
        push!.enqueue(new TextEncoder().encode('y'.repeat(1024)));
      await new Promise((r) => setTimeout(r, 300));
      expect(produced).toBe(TOTAL);
    } finally {
      push!.close();
    }
  }, 10_000);
});
