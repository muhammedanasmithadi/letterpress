/*
 * The tools this page offers to an agent, over WebMCP.
 *
 * The page is already a renderer: it has a source box, a toolbar, and a
 * Render button. What it lacked was a way for an agent -- the one built into
 * the browser, or one the user points at this tab -- to use it. WebMCP is
 * that: the page registers tools, and an agent discovers and calls them.
 *
 * Three things were measured on this machine's Chromium 154, and all three
 * shaped this file:
 *
 * The API is `document.modelContext`, not `navigator.modelContext`. The
 * navigator spelling is undefined here, and an undefined API is the kind of
 * thing that looks like a missing feature rather than a wrong spelling.
 *
 * `registerTool` takes the tool's arguments as a JSON *string*, and
 * `getTools` hands back `inputSchema` as a string too. An object where a
 * string belongs fails with "Failed to parse input arguments", which names
 * the symptom rather than the mistake.
 *
 * The whole API is absent without `--enable-blink-features=WebMCP`, and it is
 * absent on a page that is not a secure context. `about:blank` counts as
 * insecure; `http://127.0.0.1` counts as secure, which is where the viewer is
 * served from. So the code below checks for the API and does nothing when it
 * is not there, rather than throwing on a browser that has never heard of it.
 *
 * The tools are thin, and they go through the page's own render rather than
 * fetching `/render` again. A person watching the tab and an agent asking a
 * question then get the same render, with the same preview, rather than two
 * renders that could differ.
 */

import { renderForTool } from './app.js';

const MANIFEST_URL = '/findings';

/** The tools, in the shape `registerTool` wants. */
const TOOLS = [
  {
    name: 'render_html',
    description:
      'Print HTML to PDF through the renderer this page is already using, and report what the ' +
      'document got wrong. Returns the page count and the findings. A finding of severity ' +
      'error means the PDF is not the document that was asked for.',
    inputSchema: {
      type: 'object',
      properties: {
        html: {
          type: 'string',
          description: 'the document to print. left out, the source box is used as it stands.',
        },
        format: {
          type: 'string',
          enum: ['a3', 'a4', 'a5', 'legal', 'letter', 'tabloid'],
          description: 'the paper. left out, the document declares its own @page size.',
        },
        landscape: { type: 'boolean', description: 'transpose the paper.' },
        margin: {
          type: 'string',
          description:
            'a CSS length such as 15mm. needs a format, and is ignored when the document declares @page margin.',
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
      },
    },
  },
  {
    name: 'list_findings',
    description:
      'Every finding code the renderer can report, with its severity and what it means. Call this ' +
      'when a code appears in a result and you need to know whether it is a fault in the document ' +
      'or a note about it.',
    inputSchema: {
      type: 'object',
      properties: {
        severity: {
          type: 'string',
          enum: ['error', 'warn', 'info'],
          description: 'return only the codes reported at this severity.',
        },
      },
    },
  },
];

/** The text of a finding, one per line. */
function findingLine(f) {
  return `${f.severity}: ${f.code} -- ${f.message}`;
}

/**
 * The manifest, fetched once and kept.
 *
 * A tool call that has to fetch the vocabulary before it can answer is a tool
 * call that fails when the server is slow, and the list does not change while
 * the page is open.
 */
let manifest = null;
async function findingsManifest() {
  if (manifest) return manifest;
  const r = await fetch(MANIFEST_URL);
  if (!r.ok) throw new Error(`the findings manifest answered ${r.status}`);
  manifest = await r.json();
  return manifest;
}

/** The tools' `execute` bodies, keyed by name. */
const EXECUTE = {
  async render_html(args) {
    const body = await renderForTool(args);
    if (!body) {
      throw new Error('the render failed; the page says why in its status line');
    }
    const findings = body.findings ?? [];
    const errors = findings.filter((f) => f.severity === 'error').length;
    const head =
      `${body.pages} page${body.pages === 1 ? '' : 's'}, ${body.bytes} bytes, ${body.ms}ms` +
      (errors ? `, ${errors} error-severity finding(s)` : ', no errors');
    const lines = findings.map(findingLine);
    return {
      content: [{ type: 'text', text: lines.length ? `${head}\n\n${lines.join('\n')}` : head }],
    };
  },

  async list_findings(args) {
    const data = await findingsManifest();
    const wanted =
      typeof args.severity === 'string'
        ? data.findings.filter((f) => f.severity === args.severity)
        : data.findings;
    const text = wanted.map((f) => `${f.severity}: ${f.code} -- ${f.summary}`).join('\n');
    return { content: [{ type: 'text', text }] };
  },
};

/**
 * Register the tools, if this browser has WebMCP at all.
 *
 * Returns what happened, because the page says so in the footer: an agent
 * that finds no tools should be able to find out why, and "the page did not
 * register anything" is a worse answer than "this browser has no WebMCP".
 */
export async function registerWebMcpTools() {
  const api = document.modelContext;
  if (!api || typeof api.registerTool !== 'function') {
    return { registered: false, reason: 'this browser has no document.modelContext' };
  }
  for (const tool of TOOLS) {
    await api.registerTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      execute: async (args) => EXECUTE[tool.name](args ?? {}),
    });
  }
  return { registered: true, count: TOOLS.length };
}

// The page is a module, so this runs when the module is evaluated. The
// registration is not awaited at the top level: a browser without WebMCP
// must not see an unhandled rejection because of it.
registerWebMcpTools().catch(() => {});
