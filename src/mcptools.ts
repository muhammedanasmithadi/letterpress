import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import { Browser } from './browser.ts';
import { FINDINGS, FINDING_CODES, codesAt } from './findings.ts';
import { inspect } from './pdf.ts';
import { fontProbe, wideGaps } from './pageside.ts';
import {
  render,
  FORMATS as RENDER_FORMATS,
  pageRangesProblem,
  type Format,
  type RenderRequest,
} from './render.ts';
import { pageAnalysis } from './subcommands.ts';
import { validate } from './validate.ts';

type ToolContent = { type: 'text'; text: string } | { type: 'resource'; resource: unknown };

type ToolResult = {
  content: ToolContent[];
  structuredContent?: unknown;
  isError?: boolean;
};

const FORMATS = Object.keys(RENDER_FORMATS) as ReadonlyArray<Format>;

const PDF_RESOURCE_LIMIT = 4 * 1024 * 1024;

function text(value: string): ToolContent {
  return { type: 'text', text: value };
}

function failure(message: string): ToolResult {
  return { content: [text(message)], isError: true };
}

const RENDER_SCHEMA = {
  type: 'object',
  properties: {
    html: {
      type: 'string',
      description: 'the document to print. required unless path or url is given.',
    },
    path: {
      type: 'string',
      description: 'a local .html file to print instead of a string of markup.',
    },
    url: {
      type: 'string',
      description: 'a http(s) url to print. needs allowNetwork, or the request is blocked.',
    },
    format: {
      type: 'string',
      enum: [...FORMATS],
      description:
        'the paper. left out, the document declares its own @page size, and A4 when it declares none.',
    },
    landscape: {
      type: 'boolean',
      description:
        'transpose the paper. a document that declares its own @page keeps its size and margin.',
    },
    margin: {
      type: 'string',
      description:
        'a CSS length such as 15mm. needs format, and is ignored if the document declares @page margin.',
    },
    pageRanges: {
      type: 'string',
      description:
        'print only these pages: 2-3, or 1,4-6. page numbers in a footer keep counting the whole document.',
    },
    allowNetwork: {
      type: 'boolean',
      description: 'permit remote http(s) requests instead of blocking them.',
    },
    maxImagePpi: {
      type: 'number',
      description:
        'downsample images above this resolution. 300 is the print convention, 0 disables.',
    },
    settleMs: {
      type: 'number',
      description: 'extra wait after fonts resolve, in milliseconds.',
    },
    timeoutMs: {
      type: 'number',
      description: 'the render deadline, in milliseconds.',
    },
    noScript: {
      type: 'boolean',
      description: "do not run the document's JavaScript. the tool's own measurements still run.",
    },
    beforePrint: {
      type: 'string',
      description: 'JavaScript to run in the page after layout and before printing.',
    },
    root: {
      type: 'string',
      description:
        'the directory the document may read its assets from. defaults to the document own directory.',
    },
    outputPath: {
      type: 'string',
      description:
        'where to write the PDF. defaults to a temporary file, whose path comes back in the result.',
    },
    probe: {
      type: 'string',
      enum: ['gaps', 'fonts'],
      description:
        'ask the loaded page a question of its own and get the answer in the result. ' +
        'gaps: where a browser will break a text selection, with the element and the cause. ' +
        'fonts: the families the document asked for.',
    },
    includePdf: {
      type: 'boolean',
      description:
        'return the pdf bytes inline as well as writing them to disk. off by default, because a pdf is megabytes of base64.',
    },
  },
} as const;

const VALIDATE_SCHEMA = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'the pdf to check, as a local file path.',
    },
    pdf: {
      type: 'string',
      description:
        'the pdf to check, as base64. use this rather than a path when the file is not on the server machine.',
    },
  },
} as const;

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    severity: {
      type: 'string',
      enum: ['error', 'warn', 'info'],
      description: 'return only the codes reported at this severity.',
    },
  },
} as const;

export type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: McpContext) => Promise<ToolResult>;
};

export const TOOLS: Tool[] = [
  {
    name: 'render_html',
    title: 'Render HTML to PDF',
    description:
      'Print HTML to PDF through Chromium own print engine, and report what the document got wrong. ' +
      'Returns the path the pdf was written to, the findings, and what the finished file turned out to be. ' +
      'A finding of severity error means the pdf is not the document you asked for.',
    inputSchema: RENDER_SCHEMA as unknown as Record<string, unknown>,
    execute: (args, ctx) => renderHtml(args, ctx),
  },
  {
    name: 'validate_pdf',
    title: 'Check an existing PDF',
    description:
      'Check a pdf that already exists, without a browser: structure, tagged navigation, fonts, and the ' +
      'same findings a render would report. Use this on a file from anywhere, including one another tool wrote.',
    inputSchema: VALIDATE_SCHEMA as unknown as Record<string, unknown>,
    execute: (args, ctx) => validatePdf(args, ctx),
  },
  {
    name: 'page_rules',
    title: 'Explain the paper rules',
    description:
      'Say what the renderer would make of a document own @page rules: the paper and margin it ' +
      'declares, what --landscape would do to them, and what --format and --margin would change. ' +
      'Use this before rendering when the paper matters, and after when a document did not come out ' +
      'on the sheet you expected.',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'the document to read the page rules out of.' },
        format: {
          type: 'string',
          enum: FORMATS,
          description: 'the paper to ask about, as if it were requested.',
        },
        margin: {
          type: 'string',
          description: 'the margin to ask about, as if it were requested.',
        },
      },
      required: ['html'],
    },
    execute: (args) => Promise.resolve(pageRules(args)),
  },
  {
    name: 'list_findings',
    title: 'List the finding codes',
    description:
      'Every finding code the renderer can report, with its severity and what it means. Call this when a ' +
      'code appears in a result and you need to know whether it is a fault in the document or a note about it.',
    inputSchema: FINDINGS_SCHEMA as unknown as Record<string, unknown>,
    execute: (args) => listFindings(args),
  },
];

export type McpSandbox = {
  root: string;

  maxPages: number;

  maxSettleMs: number;
  maxTimeoutMs: number;

  acquire: () => Promise<void> | null;
  release: () => void;
};

export type McpContext = {
  browser: () => Promise<Browser>;
  workDir: string;

  sandbox?: McpSandbox;

  outputCount: number;

  close?: () => Promise<void>;
};

export async function makeContext(): Promise<McpContext> {
  const workDir = await mkdtemp(join(tmpdir(), 'letterpress-mcp-'));
  const profile = await mkdtemp(join(tmpdir(), 'letterpress-mcp-profile-'));
  let browser: Browser | undefined;
  return {
    workDir,
    outputCount: 0,
    browser: async () => {
      if (!browser) browser = await Browser.launch({ profile });
      return browser;
    },
    close: async () => {
      await browser?.close();
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

export function contextWith(browser: Browser, workDir: string, sandbox: McpSandbox): McpContext {
  return { browser: async () => browser, workDir, sandbox, outputCount: 0 };
}

export async function closeContext(ctx: McpContext): Promise<void> {
  await ctx.close?.();
  await rm(ctx.workDir, { recursive: true, force: true }).catch(() => {});
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<ToolResult | null> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return null;
  return tool.execute(args, ctx);
}

function probeFor(name: string | undefined): (() => unknown) | undefined {
  if (name === 'gaps') return wideGaps;
  if (name === 'fonts') return fontProbe;
  return undefined;
}

function pageRules(args: Record<string, unknown>): ToolResult {
  const html = stringArg(args, 'html');
  if (html === undefined) return failure('page_rules needs the html to read.');
  const analysis = pageAnalysis(
    html,
    'the document',
    stringArg(args, 'format'),
    stringArg(args, 'margin'),
  );
  const declared = analysis.declared;
  const lines = [
    `declared size: ${declared.size ?? '(none)'}`,
    `declared margin: ${declared.margin ?? '(none)'}`,
    `declared orientation: ${declared.orientation ?? '(none)'}`,
    `@page rules: ${declared.rules.length}`,
    ...declared.rules.map((r) => `  ${r}`),
    `with --landscape: ${analysis['landscape']}`,
  ];
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: analysis,
  };
}

function findingLine(f: { severity: string; code: string; message: string }): string {
  return `${f.severity}: ${f.code} -- ${f.message}`;
}

async function renderUnderSandbox(
  request: RenderRequest,
  ctx: McpContext,
): Promise<{ result: Awaited<ReturnType<typeof render>> } | { refused: string }> {
  const refused = refuseForSandbox(request, ctx);
  if (refused !== null) return { refused };

  const sandbox = ctx.sandbox;
  if (sandbox !== undefined) {
    const slot = sandbox.acquire();
    if (slot === null) return { refused: 'the renderer is busy; try again shortly' };
    try {
      await slot;
    } catch {
      return { refused: 'the server is shutting down' };
    }
  }

  try {
    const browser = await ctx.browser();
    const result = await render(browser, request);
    if (sandbox !== undefined && result.info.pages > sandbox.maxPages) {
      return {
        refused:
          `this document is ${result.info.pages} pages, over the ${sandbox.maxPages}-page limit. ` +
          `split it, or render it with the cli, which has no page limit.`,
      };
    }
    return { result };
  } catch (e) {
    return { refused: `the render failed: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    if (sandbox !== undefined) sandbox.release();
  }
}

function refuseForSandbox(request: RenderRequest, ctx: McpContext): string | null {
  const sandbox = ctx.sandbox;
  if (sandbox === undefined) return null;
  if (request.path !== undefined) {
    return 'a file on the server is not read; send the html instead';
  }
  if (request.url !== undefined) {
    return 'a url is not fetched; send the html instead';
  }
  if (request.settleMs !== undefined && request.settleMs > sandbox.maxSettleMs) {
    request.settleMs = sandbox.maxSettleMs;
  }
  if (request.timeoutMs !== undefined && request.timeoutMs > sandbox.maxTimeoutMs) {
    request.timeoutMs = sandbox.maxTimeoutMs;
  }
  return null;
}

function nextOutputName(ctx: McpContext): string {
  ctx.outputCount += 1;
  return `output-${ctx.outputCount}.pdf`;
}

async function sweepOlderOutputs(ctx: McpContext, keep: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(ctx.workDir);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(ctx.workDir, name);
    if (path === keep) continue;
    if (!name.startsWith('output-')) continue;
    await rm(path, { force: true }).catch(() => {});
  }
}

function confineRead(path: string, ctx: McpContext): string | null {
  const root = ctx.sandbox?.root;
  if (root === undefined) return null;
  const base = realpathOf(root);
  const target = realpathOf(resolve(path));
  if (target !== base && !target.startsWith(base + sep)) {
    return `only a pdf inside ${root} can be read, not ${path}`;
  }
  return null;
}

function confineOutput(out: string, ctx: McpContext): string | null {
  const root = ctx.sandbox?.root;
  if (root === undefined) return null;
  const base = realpathOf(root);
  const target = realpathOf(resolve(out));
  if (target !== base && !target.startsWith(base + sep)) {
    return `the pdf can only be written inside ${root}, not ${out}`;
  }
  return null;
}

function realpathOf(path: string): string {
  const full = resolve(path);
  const parts = full.split(sep).filter(Boolean);
  let at: string = sep;
  for (const part of parts) {
    at = join(at, part);
    const link = linkTarget(at);
    if (link !== null) at = realpathOf(link);
  }
  return at;
}

function linkTarget(path: string): string | null {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null;
    return resolve(dirname(path), readlinkSync(path));
  } catch {
    return null;
  }
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' ? v : undefined;
}

function boolArg(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}

function numberArgs(args: Record<string, unknown>): {
  maxImagePpi?: number;
  settleMs?: number;
  timeoutMs?: number;
  error?: string;
} {
  const timeoutMs = numberArg(args, 'timeoutMs');
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1000)) {
    return { error: 'timeoutMs must be a whole number of at least 1000.' };
  }
  const settleMs = numberArg(args, 'settleMs');
  if (settleMs !== undefined && (!Number.isInteger(settleMs) || settleMs < 0)) {
    return { error: 'settleMs must be a whole number, zero or more.' };
  }
  const maxImagePpi = numberArg(args, 'maxImagePpi');
  if (maxImagePpi !== undefined && (!Number.isInteger(maxImagePpi) || maxImagePpi < 0)) {
    return { error: 'maxImagePpi must be a whole number, zero or more.' };
  }
  return { maxImagePpi, settleMs, timeoutMs };
}

function renderRequestFrom(args: Record<string, unknown>): {
  request: RenderRequest;
  error?: string;
} {
  const html = stringArg(args, 'html');
  const path = stringArg(args, 'path');
  const url = stringArg(args, 'url');
  if (!html && !path && !url) {
    return { request: {}, error: 'render_html needs one of: html, path, url.' };
  }

  const format = stringArg(args, 'format');
  if (format !== undefined && !FORMATS.includes(format.trim().toLowerCase() as Format)) {
    return { request: {}, error: `format must be one of ${FORMATS.join(', ')}, got "${format}".` };
  }
  const margin = stringArg(args, 'margin');
  if (margin !== undefined && format === undefined) {
    return {
      request: {},
      error: 'margin only applies with format, because the document own @page wins otherwise.',
    };
  }

  const probe = stringArg(args, 'probe');
  if (probe !== undefined && probe !== 'gaps' && probe !== 'fonts') {
    return { request: {}, error: `probe must be one of gaps, fonts, got "${probe}".` };
  }
  const numbers = numberArgs(args);
  if (numbers.error !== undefined) return { request: {}, error: numbers.error };

  const pageRanges = stringArg(args, 'pageRanges');
  if (pageRanges !== undefined) {
    const problem = pageRangesProblem(pageRanges);
    if (problem !== null) {
      return { request: {}, error: `pageRanges must be a string like "1-3": ${problem}` };
    }
  }

  return {
    request: {
      html,
      path,
      url,
      pageProbe: probeFor(probe),
      format: format?.trim().toLowerCase() as Format | undefined,
      landscape: boolArg(args, 'landscape'),
      margin,
      pageRanges,
      allowNetwork: boolArg(args, 'allowNetwork'),
      maxImagePpi: numbers.maxImagePpi,
      settleMs: numbers.settleMs,
      timeoutMs: numbers.timeoutMs,
      noScript: boolArg(args, 'noScript'),
      beforePrint: stringArg(args, 'beforePrint'),
      root: stringArg(args, 'root'),
    },
  };
}

async function renderHtml(args: Record<string, unknown>, ctx: McpContext): Promise<ToolResult> {
  const { request, error } = renderRequestFrom(args);
  if (error !== undefined) return failure(error);

  const requested = stringArg(args, 'outputPath');
  const out =
    requested !== undefined && requested.trim() !== ''
      ? requested
      : join(ctx.workDir, nextOutputName(ctx));
  const confined = confineOutput(out, ctx);
  if (confined !== null) return failure(confined);

  const rendered = await renderUnderSandbox(request, ctx);
  if ('refused' in rendered) return failure(rendered.refused);
  const result = rendered.result;

  try {
    await writeFile(out, result.pdf);
    await sweepOlderOutputs(ctx, out);
  } catch (e) {
    return failure(
      `the pdf could not be written to ${out}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const errors = result.findings.filter((f) => f.severity === 'error');
  const lines = result.findings.map(findingLine);
  const summary =
    `wrote ${out} -- ${result.info.pages} page${result.info.pages === 1 ? '' : 's'}, ` +
    `${result.pdf.byteLength} bytes, ${result.ms}ms` +
    (errors.length ? `, ${errors.length} error-severity finding(s)` : ', no errors');
  const content: ToolContent[] = [
    text(lines.length ? `${summary}\n\n${lines.join('\n')}` : summary),
  ];
  if (result.probe !== undefined) {
    content.push(text(`probe: ${JSON.stringify(result.probe)}`));
  }

  const structured = {
    ok: errors.length === 0,
    path: out,
    pages: result.info.pages,
    bytes: result.pdf.byteLength,
    ms: result.ms,
    tagged: result.info.tagged,
    pageSizes: result.info.pageSizes,
    findings: result.findings,
    ...(result.probe === undefined ? {} : { probe: result.probe }),
  };

  if (boolArg(args, 'includePdf')) {
    if (result.pdf.byteLength <= PDF_RESOURCE_LIMIT) {
      content.push({
        type: 'resource',
        resource: {
          uri: `file://${out}`,
          mimeType: 'application/pdf',
          blob: Buffer.from(result.pdf).toString('base64'),
        },
      });
    } else {
      content.push(
        text(
          `the pdf is ${(result.pdf.byteLength / 1048576).toFixed(1)}MB, over the ` +
            `${PDF_RESOURCE_LIMIT / 1048576}MB limit for sending it inline. it was written to ${out}.`,
        ),
      );
    }
  }

  return { content, structuredContent: structured };
}

function decodeBase64(text: string): Uint8Array | null {
  const packed = text.replace(/\s+/g, '');
  if (packed.length === 0) return new Uint8Array();
  if (packed.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(packed)) return null;
  return new Uint8Array(Buffer.from(packed, 'base64'));
}

async function validatePdf(args: Record<string, unknown>, ctx: McpContext): Promise<ToolResult> {
  const path = typeof args.path === 'string' ? args.path : undefined;
  const encoded = typeof args.pdf === 'string' ? args.pdf : undefined;
  if (!path && !encoded)
    return failure('validate_pdf needs a path to a pdf file, or the pdf itself as base64.');

  let bytes: Uint8Array;
  if (encoded !== undefined) {
    const decoded = decodeBase64(encoded);
    if (decoded === null) return failure('the pdf is not base64.');
    bytes = decoded;
  } else {
    const confined = confineRead(path!, ctx);
    if (confined !== null) return failure(confined);
    try {
      bytes = new Uint8Array(await readFile(path!));
    } catch (e) {
      return failure(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const result = validate(bytes);
  const info = inspect(bytes);
  const lines = result.findings.map(findingLine);
  const name = path ?? 'the pdf';
  const summary =
    `${name} -- ${result.findings.length} finding${result.findings.length === 1 ? '' : 's'}, ` +
    `${result.ok ? 'ok' : 'not ok'}, ${info.pages} page${info.pages === 1 ? '' : 's'}` +
    (info.tagged ? ', tagged' : ', untagged');

  return {
    content: [text(lines.length ? `${summary}\n\n${lines.join('\n')}` : summary)],
    structuredContent: {
      ok: result.ok,
      path: path ?? null,
      bytes: bytes.byteLength,
      pages: info.pages,
      tagged: info.tagged,
      pageSizes: info.pageSizes,
      findings: result.findings,
    },
  };
}

const SEVERITIES = ['error', 'warn', 'info'] as const;

async function listFindings(args: Record<string, unknown>): Promise<ToolResult> {
  const raw = typeof args.severity === 'string' ? args.severity : undefined;
  if (raw !== undefined && !SEVERITIES.includes(raw as (typeof SEVERITIES)[number])) {
    return failure(`severity must be error, warn or info, got "${raw}".`);
  }
  const severity = raw as (typeof SEVERITIES)[number] | undefined;
  const codes = severity ? codesAt(severity) : FINDING_CODES;
  const list = codes.map((code) => ({ code, ...FINDINGS[code]! }));
  const text_ = list.map((f) => `${f.severity}: ${f.code} -- ${f.summary}`);
  return {
    content: [text(text_.join('\n'))],
    structuredContent: { count: list.length, findings: list },
  };
}
