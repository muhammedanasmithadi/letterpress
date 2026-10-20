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
