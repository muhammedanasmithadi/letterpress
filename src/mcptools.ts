import { readFile } from 'node:fs/promises';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import { Browser } from './browser.ts';
import { FINDINGS, FINDING_CODES } from './findings.ts';
import { inspect } from './pdf.ts';
import { render, type Format, type RenderRequest } from './render.ts';
import { validate } from './validate.ts';

type ToolContent = { type: 'text'; text: string } | { type: 'resource'; resource: unknown };

type ToolResult = {
  content: ToolContent[];
  structuredContent?: unknown;
  isError?: boolean;
};

const FORMATS = ['a3', 'a4', 'a5', 'legal', 'letter', 'tabloid'] as const;

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
      description: 'the pdf to check. a local file path.',
    },
  },
  required: ['path'],
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
    name: 'list_findings',
    title: 'List the finding codes',
    description:
      'Every finding code the renderer can report, with its severity and what it means. Call this when a ' +
      'code appears in a result and you need to know whether it is a fault in the document or a note about it.',
    inputSchema: FINDINGS_SCHEMA as unknown as Record<string, unknown>,
    execute: (args) => listFindings(args),
  },
];

export type McpContext = {
  browser: () => Promise<Browser>;
  workDir: string;

  outputRoot?: string;
};

export async function makeContext(): Promise<McpContext> {
  const workDir = await mkdtemp(join(tmpdir(), 'letterpress-mcp-'));
  let browser: Browser | undefined;
  return {
    workDir,
    browser: async () => {
      if (!browser) {
        const profile = await mkdtemp(join(tmpdir(), 'letterpress-mcp-profile-'));
        browser = await Browser.launch({ profile });
      }
      return browser;
    },
  };
}

export function contextWith(browser: Browser, workDir: string): McpContext {
  return { browser: async () => browser, workDir, outputRoot: workDir };
}

export async function closeContext(ctx: McpContext): Promise<void> {
  const { rm } = await import('node:fs/promises');
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

function findingLine(f: { severity: string; code: string; message: string }): string {
  return `${f.severity}: ${f.code} -- ${f.message}`;
}

function confineRead(path: string, ctx: McpContext): string | null {
  const root = ctx.outputRoot;
  if (root === undefined) return null;
  const base = realpathOf(root);
  const target = realpathOf(resolve(path));
  if (target !== base && !target.startsWith(base + sep)) {
    return `only a pdf inside ${root} can be read, not ${path}`;
  }
  return null;
}

function confineOutput(out: string, ctx: McpContext): string | null {
  const root = ctx.outputRoot;
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
    try {
      if (lstatSync(at).isSymbolicLink()) {
        at = realpathOf(resolve(dirname(at), readlinkSync(at)));
      }
    } catch {}
  }
  return at;
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
  if (format !== undefined && !(FORMATS as readonly string[]).includes(format)) {
    return { request: {}, error: `format must be one of ${FORMATS.join(', ')}, got "${format}".` };
  }
  const margin = stringArg(args, 'margin');
  if (margin !== undefined && format === undefined) {
    return {
      request: {},
      error: 'margin only applies with format, because the document own @page wins otherwise.',
    };
  }

  return {
    request: {
      html,
      path,
      url,
      format: format as Format | undefined,
      landscape: boolArg(args, 'landscape'),
      margin,
      pageRanges: stringArg(args, 'pageRanges'),
      allowNetwork: boolArg(args, 'allowNetwork'),
      maxImagePpi: numberArg(args, 'maxImagePpi'),
      settleMs: numberArg(args, 'settleMs'),
      timeoutMs: numberArg(args, 'timeoutMs'),
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
      : join(ctx.workDir, 'output.pdf');
  const confined = confineOutput(out, ctx);
  if (confined !== null) return failure(confined);

  let result;
  try {
    const browser = await ctx.browser();
    result = await render(browser, request);
  } catch (e) {
    return failure(`the render failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  await writeFile(out, result.pdf);

  const errors = result.findings.filter((f) => f.severity === 'error');
  const lines = result.findings.map(findingLine);
  const summary =
    `wrote ${out} -- ${result.info.pages} page${result.info.pages === 1 ? '' : 's'}, ` +
    `${result.pdf.byteLength} bytes, ${result.ms}ms` +
    (errors.length ? `, ${errors.length} error-severity finding(s)` : ', no errors');
  const content: ToolContent[] = [
    text(lines.length ? `${summary}\n\n${lines.join('\n')}` : summary),
  ];

  const structured = {
    ok: errors.length === 0,
    path: out,
    pages: result.info.pages,
    bytes: result.pdf.byteLength,
    ms: result.ms,
    tagged: result.info.tagged,
    pageSizes: result.info.pageSizes,
    findings: result.findings,
  };

  if (boolArg(args, 'includePdf') && result.pdf.byteLength <= PDF_RESOURCE_LIMIT) {
    content.push({
      type: 'resource',
      resource: {
        uri: `file://${out}`,
        mimeType: 'application/pdf',
        blob: Buffer.from(result.pdf).toString('base64'),
      },
    });
  }

  return { content, structuredContent: structured };
}

async function validatePdf(args: Record<string, unknown>, ctx: McpContext): Promise<ToolResult> {
  const path = typeof args.path === 'string' ? args.path : undefined;
  if (!path) return failure('validate_pdf needs a path to a pdf file.');
  const confined = confineRead(path, ctx);
  if (confined !== null) return failure(confined);

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch (e) {
    return failure(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const result = validate(bytes);
  const info = inspect(bytes);
  const lines = result.findings.map(findingLine);
  const summary =
    `${path} -- ${result.findings.length} finding${result.findings.length === 1 ? '' : 's'}, ` +
    `${result.ok ? 'ok' : 'not ok'}, ${info.pages} page${info.pages === 1 ? '' : 's'}` +
    (info.tagged ? ', tagged' : ', untagged');

  return {
    content: [text(lines.length ? `${summary}\n\n${lines.join('\n')}` : summary)],
    structuredContent: {
      ok: result.ok,
      path,
      bytes: bytes.byteLength,
      pages: info.pages,
      tagged: info.tagged,
      pageSizes: info.pageSizes,
      findings: result.findings,
    },
  };
}

async function listFindings(args: Record<string, unknown>): Promise<ToolResult> {
  const severity = typeof args.severity === 'string' ? args.severity : undefined;
  if (severity !== undefined && !['error', 'warn', 'info'].includes(severity)) {
    return failure(`severity must be error, warn or info, got "${severity}".`);
  }
  const codes = severity
    ? FINDING_CODES.filter((c) => FINDINGS[c]!.severity === severity)
    : FINDING_CODES;
  const list = codes.map((code) => ({ code, ...FINDINGS[code]! }));
  const text_ = list.map((f) => `${f.severity}: ${f.code} -- ${f.summary}`);
  return {
    content: [text(text_.join('\n'))],
    structuredContent: { count: list.length, findings: list },
  };
}
