"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.launchTestBrowser = launchTestBrowser;
exports.closeTestBrowser = closeTestBrowser;
exports.tabWithHtml = tabWithHtml;
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const browser_ts_1 = require("../src/browser.ts");
async function launchTestBrowser(name, extraArgs = []) {
    const profile = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), `letterpress-${name}-`));
    return { browser: await browser_ts_1.Browser.launch({ profile, extraArgs }), profile };
}
async function closeTestBrowser(t) {
    await t.browser.close();
    await (0, promises_1.rm)(t.profile, { recursive: true, force: true }).catch(() => { });
}
async function tabWithHtml(browser, html) {
    const tab = await browser.newTab();
    await tab.send('Page.enable');
    await tab.send('Runtime.enable');
    const { frameTree } = (await tab.send('Page.getFrameTree'));
    await tab.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
    return tab;
}
//# sourceMappingURL=browser.js.map