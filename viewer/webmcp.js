import { renderForTool } from './app.js';

const MANIFEST_URL = '/findings';

function toolsFor(formats) {
  return [
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
            enum: formats,
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
      async execute(args) {
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
      async execute(args) {
        const data = await findingsManifest();
        if (
          typeof args.severity === 'string' &&
          !['error', 'warn', 'info'].includes(args.severity)
        ) {
          throw new Error(`severity must be error, warn or info, got "${args.severity}".`);
        }
        const wanted =
          typeof args.severity === 'string'
            ? data.findings.filter((f) => f.severity === args.severity)
            : data.findings;
        const text = wanted.map((f) => `${f.severity}: ${f.code} -- ${f.summary}`).join('\n');
        return { content: [{ type: 'text', text }] };
      },
    },
  ];
}

function findingLine(f) {
  return `${f.severity}: ${f.code} -- ${f.message}`;
}

let manifest = null;
async function findingsManifest() {
  if (manifest) return manifest;
  const r = await fetch(MANIFEST_URL);
  if (!r.ok) throw new Error(`the findings manifest answered ${r.status}`);
  manifest = await r.json();
  return manifest;
}

async function registerWebMcpTools() {
  const api = document.modelContext;
  if (!api || typeof api.registerTool !== 'function') {
    return { registered: false, reason: 'this browser has no document.modelContext' };
  }
  const manifest = await findingsManifest();
  const tools = toolsFor(manifest.formats ?? []);
  for (const tool of tools) {
    await api.registerTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      execute: (args) => tool.execute(args ?? {}),
    });
  }
  return { registered: true, count: tools.length };
}

registerWebMcpTools().catch((e) => {
  console.error('the page could not register its tools: ' + (e?.message ?? e));
});
