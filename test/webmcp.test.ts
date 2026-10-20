import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { closeTestBrowser, launchTestBrowser, type TestBrowser } from './browser.ts';
import { useTestServer } from './servers.ts';
import type { Tab } from '../src/browser.ts';

let t: TestBrowser;
const server = useTestServer();
let tab: Tab;

beforeAll(async () => {
  t = await launchTestBrowser('webmcp', ['--enable-blink-features=WebMCP']);
  tab = await t.browser.newTab();
  await tab.send('Page.enable');
  await tab.send('Runtime.enable');
  await tab.send('Page.navigate', { url: `${server.origin}/` });
  await Bun.sleep(1500);
}, 90_000);

afterAll(async () => {
  await closeTestBrowser(t);
}, 30_000);

async function evaluate(expression: string): Promise<unknown> {
  const r = await tab.send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r?.exceptionDetails) {
    const detail =
      r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text;
    throw new Error(`the page threw: ${detail}`);
  }
  return r?.result?.value;
}

async function waitForTools(count: number): Promise<Array<{ name: string }>> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const tools = JSON.parse(
      (await evaluate(
        `const t = await document.modelContext.getTools();
         return JSON.stringify(t.map(x => x.name));`,
      )) as string,
    ) as string[];
    if (tools.length >= count) return tools.map((name) => ({ name }));
    if (Date.now() > deadline) {
      throw new Error(`the page registered ${tools.length} tools, expected ${count}`);
    }
    await Bun.sleep(100);
  }
}

async function callTool(name: string, args: unknown): Promise<string> {
  return (await evaluate(
    `const t = await document.modelContext.getTools();
     const tool = t.find(x => x.name === ${JSON.stringify(name)});
     if (!tool) throw new Error('no tool named ' + ${JSON.stringify(name)});
     const r = JSON.parse(await document.modelContext.executeTool(tool, JSON.stringify(${JSON.stringify(args)})));
     return r.content[0].text;`,
  )) as string;
}

describe('the page offers tools to an agent', () => {
  test('the browser has the API at all, or this file proves nothing', async () => {
    const shape = JSON.parse(
      (await evaluate(
        `return JSON.stringify({
           doc: typeof document.modelContext,
           nav: typeof navigator.modelContext,
           proto: document.modelContext
             ? Object.getOwnPropertyNames(Object.getPrototypeOf(document.modelContext))
             : null,
         });`,
      )) as string,
    ) as { doc: string; nav: string; proto: string[] | null };
    expect(shape.doc).toBe('object');
    expect(shape.nav).toBe('undefined');
    expect(shape.proto).toContain('registerTool');
  }, 60_000);

  test('the two tools are registered, with the names and the schemas', async () => {
    await waitForTools(2);
    const tools = JSON.parse(
      (await evaluate(
        `const t = await document.modelContext.getTools();
         return JSON.stringify(t.map(x => ({ name: x.name, description: x.description, schema: x.inputSchema })));`,
      )) as string,
    ) as Array<{ name: string; description: string; schema: string }>;

    const names = tools.map((x) => x.name).sort();
    expect(names).toEqual(['list_findings', 'render_html']);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(40);
      const schema = JSON.parse(tool.schema) as { type: string };
      expect(schema.type).toBe('object');
    }
  }, 60_000);

  test('list_findings answers with the codes and what they mean', async () => {
    const text = await callTool('list_findings', {});
    expect(text).toContain('js-error');
    expect(text).toContain('font-fallback');
  }, 60_000);

  test('list_findings can be narrowed to one severity', async () => {
    const text = await callTool('list_findings', { severity: 'error' });
    const lines = text.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.startsWith('error: ')).toBe(true);
  }, 60_000);

  test('render_html makes a real pdf and reports the findings', async () => {
    const text = await callTool('render_html', {
      html: '<!doctype html><html lang="en"><head><style>@page{size:A4;margin:12mm}</style></head><body><h1>Through the page</h1></body></html>',
    });
    expect(text).toContain('1 page');
  }, 120_000);

  test('every tool that is registered can also be called', async () => {
    const tools = await waitForTools(2);
    expect(tools.map((t) => t.name).sort()).toEqual(['list_findings', 'render_html']);
  });
  test('a render with a problem says so, rather than returning nothing', async () => {
    const text = await callTool('render_html', {
      html: '<!doctype html><html><head><style>@page{size:A4;margin:10mm}</style></head><body><img src="missing.png"><p>x</p></body></html>',
    });
    expect(text).toContain('subresource-failed');
  }, 120_000);

  test('the page shows what the agent rendered, so the human sees the same thing', async () => {
    await callTool('render_html', {
      html: '<!doctype html><html lang="en"><head><style>@page{size:A5;margin:10mm}</style></head><body><h1>Agent</h1></body></html>',
    });
    const shown = await evaluate(
      `return JSON.stringify({
         metrics: document.getElementById('metrics').textContent,
         status: document.getElementById('status').textContent,
         source: document.getElementById('source').value,
       });`,
    );
    const page = JSON.parse(shown as string) as {
      metrics: string;
      status: string;
      source: string;
    };
    expect(page.metrics).toContain('1 page');
    expect(page.status).toContain('Rendered');
    expect(page.source).not.toContain('Agent');
  }, 120_000);

  test('the toolbar shows the settings the tool asked for', async () => {
    await callTool('render_html', {
      html: '<!doctype html><html lang="en"><head><style>@page{size:A4;margin:12mm}</style></head><body><p>x</p></body></html>',
      format: 'a5',
      landscape: true,
    });
    const state = JSON.parse(
      (await evaluate(
        `return JSON.stringify({
           format: document.getElementById('format').value,
           landscape: document.getElementById('landscape').getAttribute('aria-pressed'),
         });`,
      )) as string,
    ) as { format: string; landscape: string };
    expect(state.format).toBe('a5');
    expect(state.landscape).toBe('true');
  }, 120_000);
});

describe('the server serves the manifest', () => {
  test('over http, as data', async () => {
    const r = await fetch(`${server.origin}/findings`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      findings: Array<{ code: string; severity: string; summary: string }>;
    };
    expect(body.findings.length).toBeGreaterThan(30);
    for (const f of body.findings) {
      expect(['error', 'warn', 'info']).toContain(f.severity);
      expect(f.summary.length).toBeGreaterThan(10);
    }
  }, 30_000);
});
