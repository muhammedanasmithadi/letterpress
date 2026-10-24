"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.launchTestServer = launchTestServer;
exports.serverOrigin = serverOrigin;
exports.useTestServer = useTestServer;
const bun_test_1 = require("bun:test");
const server_ts_1 = require("../src/server.ts");
async function launchTestServer() {
    return (0, server_ts_1.startServer)({ port: 0 });
}
function serverOrigin(s) {
    return `http://127.0.0.1:${s.port}`;
}
function useTestServer() {
    let server;
    (0, bun_test_1.beforeAll)(async () => {
        server = await launchTestServer();
    }, 90_000);
    (0, bun_test_1.afterAll)(async () => {
        await server?.stop();
    }, 30_000);
    return {
        get origin() {
            return server ? serverOrigin(server) : '';
        },
    };
}
//# sourceMappingURL=servers.js.map