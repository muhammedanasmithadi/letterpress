/**
 * A browser and a scratch profile for a test file, torn down with the file.
 *
 * Extracted because eight lines of `beforeAll`/`afterAll` per file is the single most
 * duplicated block in this directory, and the duplication gate counts it every time a new
 * test file lands. The gate is right to: this is boilerplate that says nothing about what
 * any test is checking.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser, type Tab } from '../src/browser.ts';

export type TestBrowser = {
  browser: Browser;
  profile: string;
};

export async function launchTestBrowser(
  name: string,
  extraArgs: string[] = [],
): Promise<TestBrowser> {
  const profile = await mkdtemp(join(tmpdir(), `letterpress-${name}-`));
  return { browser: await Browser.launch({ profile, extraArgs }), profile };
}

export async function closeTestBrowser(t: TestBrowser): Promise<void> {
  await t.browser.close();
  await rm(t.profile, { recursive: true, force: true }).catch(() => {});
}

/**
 * A tab holding exactly the markup given, with the domains enabled.
 *
 * Same reason as `launchTestBrowser`, one step further on: `Page.enable`,
 * `getFrameTree` and `setDocumentContent` in a row is a sequence every test
 * that drives a tab by hand has to get right in the same order, and the
 * duplication gate counted the third copy of it rather than the reason it is
 * there.
 */
export async function tabWithHtml(browser: Browser, html: string): Promise<Tab> {
  const tab = await browser.newTab();
  await tab.send('Page.enable');
  await tab.send('Runtime.enable');
  const { frameTree } = (await tab.send('Page.getFrameTree')) as {
    frameTree: { frame: { id: string } };
  };
  await tab.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
  return tab;
}
