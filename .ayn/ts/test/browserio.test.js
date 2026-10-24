"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const browser_ts_1 = require("../src/browser.ts");
function silentStderr() {
    let ctl;
    const stream = new ReadableStream({
        start(c) {
            ctl = c;
        },
    });
    return { stream, release: () => ctl?.error(new Error('released')) };
}
function fakeProc(stderr) {
    return { stderr, exited: new Promise(() => { }) };
}
function deadProc(stderr) {
    return { stderr, exited: Promise.resolve(1) };
}
(0, bun_test_1.describe)('readDevToolsPort', () => {
    (0, bun_test_1.test)('a Chromium that never speaks is bounded by the timeout it was given', async () => {
        const { stream, release } = silentStderr();
        const started = Date.now();
        try {
            await (0, bun_test_1.expect)((0, browser_ts_1.readDevToolsPort)(fakeProc(stream), 400)).rejects.toThrow(/no DevTools endpoint in 400ms/);
        }
        finally {
            release();
        }
        const elapsed = Date.now() - started;
        (0, bun_test_1.expect)(elapsed, `took ${elapsed}ms`).toBeLessThan(3_000);
    }, 10_000);
    (0, bun_test_1.test)('the port is returned as soon as it appears', async () => {
        let push;
        const stderr = new ReadableStream({
            start(c) {
                push = c;
            },
        });
        const started = Date.now();
        const call = (0, browser_ts_1.readDevToolsPort)(fakeProc(stderr), 5_000);
        push.enqueue(new TextEncoder().encode('DevTools listening on ws://127.0.0.1:9222/\n'));
        (0, bun_test_1.expect)(await call).toBe(9222);
        (0, bun_test_1.expect)(Date.now() - started).toBeLessThan(4_000);
    }, 10_000);
    (0, bun_test_1.test)('a Chromium that has already died is not a Chromium that hung', async () => {
        const { stream } = silentStderr();
        const started = Date.now();
        await (0, bun_test_1.expect)((0, browser_ts_1.readDevToolsPort)(deadProc(stream), 30_000)).rejects.toThrow(/exited before it exposed a DevTools endpoint/);
        (0, bun_test_1.expect)(Date.now() - started).toBeLessThan(2_000);
    });
    (0, bun_test_1.test)('stderr keeps being drained after the port is known', async () => {
        const TOTAL = 64;
        let push;
        let produced = 0;
        const stderr = new ReadableStream({
            start(c) {
                push = c;
            },
            pull(c) {
                if (produced >= TOTAL)
                    return;
                produced++;
                c.enqueue(new TextEncoder().encode('y'.repeat(64 * 1024)));
            },
        });
        try {
            const call = (0, browser_ts_1.readDevToolsPort)(fakeProc(stderr), 5_000);
            push.enqueue(new TextEncoder().encode('DevTools listening on ws://127.0.0.1:9333/\n'));
            (0, bun_test_1.expect)(await call).toBe(9333);
            for (let i = 0; i < TOTAL + 20; i++)
                push.enqueue(new TextEncoder().encode('y'.repeat(1024)));
            await new Promise((r) => setTimeout(r, 300));
            (0, bun_test_1.expect)(produced).toBe(TOTAL);
        }
        finally {
            push.close();
        }
    }, 10_000);
});
//# sourceMappingURL=browserio.test.js.map