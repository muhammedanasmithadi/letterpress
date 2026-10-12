/**
 * Process and socket hygiene in the browser driver.
 *
 * Every finding here was invisible from the outside. A launch that failed left a headless
 * Chromium running for the life of the machine -- which is where an afternoon of 48 orphaned
 * processes came from -- and `close()`, the one function guaranteed to clean up, could wait
 * for ever on a wedged socket with its own SIGKILL escalation sitting unreachable behind the
 * await.
 *
 * These are tested against fakes rather than a real Chromium, because the failures are all
 * "the thing that should have stopped, did not", and a real browser is not the reliable way
 * to produce one.
 */
import { describe, expect, test } from 'bun:test';
import { readDevToolsPort } from '../src/browser.ts';

/**
 * A stderr stream that never yields and never closes: a Chromium that starts and says
 * nothing. The controller is returned so the test can settle the pending read afterwards --
 * a stream with a reader still parked on it keeps the process alive, and the suite hangs
 * after passing rather than reporting.
 */
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
  return { stderr, exited: Promise.resolve(0) } as unknown as Parameters<
    typeof readDevToolsPort
  >[0];
}

describe('readDevToolsPort', () => {
  test('a Chromium that never speaks is bounded by the timeout it was given', async () => {
    // The deadline was only checked between reads, so a process holding stderr open parked
    // in `reader.read()` indefinitely and the thrown error claimed a wait that had not
    // happened. This is the first thing that runs on every single launch.
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
    // Generous on the upper bound, because a loaded machine is a real condition. Tight on
    // the lower one, because hanging is the defect.
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
    // Chromium prints its line with a newline; the newline is what the pattern needs.
    push!.enqueue(new TextEncoder().encode('DevTools listening on ws://127.0.0.1:9222/\n'));
    expect(await call).toBe(9222);
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 10_000);

  test('stderr keeps being drained after the port is known', async () => {
    // Nobody read the pipe again once the port was found, and Chromium's children inherit
    // it, so a full 64 KB buffer blocks the writer and the browser stalls for the life of
    // the process with no error anywhere.
    //
    // Finite on purpose. A producer that keeps producing while a background reader consumes
    // is a busy loop that outlives the test and hangs the suite on exit; the first version
    // did exactly that and looked like a failure of the code under test.
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

      // Well past a 64 KB pipe buffer, which is where a writer with no reader stops dead.
      for (let i = 0; i < TOTAL + 20; i++)
        push!.enqueue(new TextEncoder().encode('y'.repeat(1024)));
      await new Promise((r) => setTimeout(r, 300));
      expect(produced).toBe(TOTAL);
    } finally {
      push!.close();
    }
  }, 10_000);
});
