"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bun_test_1 = require("bun:test");
const browser_ts_1 = require("../src/browser.ts");
function fakeSocket() {
    const socket = {
        onmessage: null,
        onclose: null,
        sent: [],
        send(s) {
            socket.sent.push(s);
        },
        close() { },
    };
    return socket;
}
(0, bun_test_1.describe)('a message from the browser', () => {
    (0, bun_test_1.test)('a message that is not an object is ignored', () => {
        const socket = fakeSocket();
        new browser_ts_1.Tab('t1', socket);
        for (const raw of ['null', '123', '"a string"', 'true', '[]', 'not json']) {
            (0, bun_test_1.expect)(() => socket.onmessage?.({ data: raw })).not.toThrow();
        }
    });
    (0, bun_test_1.test)('a command is still answered after a message that is not an object', async () => {
        const socket = fakeSocket();
        const tab = new browser_ts_1.Tab('t2', socket);
        const pending = tab.send('Page.enable');
        (0, bun_test_1.expect)(socket.sent.length).toBe(1);
        socket.onmessage?.({ data: 'null' });
        const id = JSON.parse(socket.sent[0]).id;
        socket.onmessage?.({ data: JSON.stringify({ id, result: { ok: true } }) });
        (0, bun_test_1.expect)(await pending).toEqual({ ok: true });
    });
});
//# sourceMappingURL=cdpmessage.test.js.map