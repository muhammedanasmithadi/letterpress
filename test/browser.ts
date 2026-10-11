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
import { Browser } from '../src/browser.ts';

export type TestBrowser = {
  browser: Browser;
  profile: string;
};

export async function launchTestBrowser(name: string): Promise<TestBrowser> {
  const profile = await mkdtemp(join(tmpdir(), `letterpress-${name}-`));
  return { browser: await Browser.launch({ profile }), profile };
}

export async function closeTestBrowser(t: TestBrowser): Promise<void> {
  await t.browser.close();
  await rm(t.profile, { recursive: true, force: true }).catch(() => {});
}
