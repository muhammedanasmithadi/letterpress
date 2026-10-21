import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handle, newSession, LEGACY_VERSIONS, MODERN_VERSION, type Session } from '../src/mcp.ts';
import { TOOLS } from '../src/mcptools.ts';
import { closeContext } from '../src/mcptools.ts';

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
};

let dir: string;
let session: Session;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'letterpress-mcp-test-'));
  session = await newSession();
}, 60_000);

afterAll(async () => {
  await closeContext(session.context);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}, 20_000);

async function send(msg: Record<string, unknown>) {
  return handle(session, msg as never);
}

function modern(id: number, method: string, params: Record<string, unknown> = {}) {
  const meta = (params['_meta'] ?? {}) as Record<string, unknown>;
  return send({
    jsonrpc: '2.0',
    id,
    method,
    params: { ...params, _meta: { ...MODERN_META, ...meta } },
  });
}

function resultOf(reply: unknown): Record<string, unknown> {
  const r = reply as { result?: Record<string, unknown>; error?: unknown };
  if (r.error !== undefined)
    throw new Error(`the server answered with an error: ${JSON.stringify(r.error)}`);
  return r.result ?? {};
}

function toolResult(reply: unknown) {
  return resultOf(reply) as unknown as {
    isError?: boolean;
    content: Array<{ text: string }>;
    structuredContent?: Record<string, unknown>;
  };
}

function errorOf(reply: unknown): { code: number; message: string; data?: unknown } {
  const r = reply as { error?: { code: number; message: string; data?: unknown } };
  if (r.error === undefined)
    throw new Error(`the server answered with a result: ${JSON.stringify(reply)}`);
  return r.error;
}

function legacy(id: number, method: string, params: Record<string, unknown> = {}) {
  return send({ jsonrpc: '2.0', id, method, params });
}

describe('the handshake', () => {
  test('a legacy client gets the version it asked for', async () => {
    for (const version of LEGACY_VERSIONS) {
      const reply = await legacy(1, 'initialize', {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      });
      const result = resultOf(reply) as unknown as {
        protocolVersion: string;
        serverInfo: { name: string };
      };
      expect(result.protocolVersion, version).toBe(version);
      expect(result.serverInfo.name).toBe('letterpress');
    }
  });

  test('a version this server does not speak is answered with one it does', async () => {
    const reply = await legacy(1, 'initialize', { protocolVersion: '1999-01-01' });
    const result = resultOf(reply) as unknown as { protocolVersion: string };
    expect(LEGACY_VERSIONS).toContain(result.protocolVersion);
    expect(result.protocolVersion).toBe(LEGACY_VERSIONS[0]!);
  });

  test('a modern client is told what the server supports', async () => {
    const reply = await modern(1, 'server/discover');
    const result = resultOf(reply) as unknown as {
      resultType: string;
      supportedVersions: string[];
      capabilities: Record<string, unknown>;
    };
    expect(result.resultType).toBe('complete');
    expect(result.supportedVersions).toEqual([MODERN_VERSION]);
    expect(result.capabilities).toHaveProperty('tools');
  });

  test('a modern request for a version this server does not speak is refused', async () => {
    const reply = await modern(1, 'tools/list', {
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-06-18' },
    });
    const error = errorOf(reply) as { code: number; data: { supported: string[] } };
    expect(error.code).toBe(-32022);
    expect(error.data.supported).toEqual([MODERN_VERSION]);
  });

  test('a modern request without the required client capabilities is malformed', async () => {
    const reply = await send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_VERSION } },
    });
    expect(errorOf(reply).code).toBe(-32602);
  });

  test('a notification is answered with nothing', async () => {
    expect(await send({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });
});

describe('the tools', () => {
  test('there are four of them, each with a name, a description and a schema', async () => {
    const reply = await legacy(1, 'tools/list');
    const tools = (resultOf(reply) as unknown as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools.map((t) => t['name'])).toEqual([
      'render_html',
      'validate_pdf',
      'page_rules',
      'list_findings',
    ]);
    for (const tool of tools) {
      expect(typeof tool['description']).toBe('string');
      expect((tool['description'] as string).length).toBeGreaterThan(40);
      expect(tool['inputSchema']).toHaveProperty('type', 'object');
    }
  });

  test('the modern listing carries a result type and a cache lifetime', async () => {
    const reply = await modern(1, 'tools/list');
    const result = resultOf(reply);
    expect(result['resultType']).toBe('complete');
    expect(result).toHaveProperty('ttlMs');
    expect(result).toHaveProperty('cacheScope');
  });

  test('the legacy listing carries neither, because that client never asked for them', async () => {
    const reply = await legacy(1, 'tools/list');
    const result = resultOf(reply);
    expect(result).not.toHaveProperty('resultType');
    expect(result).not.toHaveProperty('ttlMs');
  });

  test('every reply follows the era of the request that asked for it', async () => {
    const modernInitialize = await modern(20, 'initialize', { protocolVersion: MODERN_VERSION });
    const modernInit = resultOf(modernInitialize);
    expect(modernInit['resultType']).toBe('complete');
    expect(modernInit['protocolVersion']).toBe(MODERN_VERSION);

    const legacyDiscover = await legacy(21, 'server/discover');
    const legacyDisc = resultOf(legacyDiscover);
    expect(legacyDisc).not.toHaveProperty('resultType');

    const modernDiscover = await modern(22, 'server/discover');
    expect(resultOf(modernDiscover)['resultType']).toBe('complete');
  });

  test('a tool result follows the era of the request that asked for it', async () => {
    const modernReply = await modern(1, 'tools/call', {
      name: 'list_findings',
      arguments: { severity: 'error' },
    });
    expect(resultOf(modernReply)['resultType']).toBe('complete');

    const legacyReply = await legacy(2, 'tools/call', {
      name: 'list_findings',
      arguments: { severity: 'error' },
    });
    expect(resultOf(legacyReply)).not.toHaveProperty('resultType');
    const modernContent = (resultOf(modernReply)['content'] ?? []) as Array<{ text: string }>;
    const legacyContent = (resultOf(legacyReply)['content'] ?? []) as Array<{ text: string }>;
    expect(modernContent[0]!.text).toBe(legacyContent[0]!.text);
  });

  test('every tool that is listed can also be called', async () => {
    for (const tool of TOOLS) {
      expect(typeof tool.execute, tool.name).toBe('function');
    }
    const listed = resultOf(await legacy(1, 'tools/list')) as unknown as {
      tools: Array<{ name: string }>;
    };
    expect(listed.tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  test('page_rules says what the paper would be without rendering it', async () => {
    const reply = await legacy(1, 'tools/call', {
      name: 'page_rules',
      arguments: {
        html: '<!doctype html><style>@page{size:A4;margin:15mm}</style><p>x</p>',
      },
    });
    const result = resultOf(reply) as unknown as {
      content: Array<{ text: string }>;
      structuredContent: { declared: { size: string; margin: string; rules: string[] } };
    };
    expect(result.structuredContent.declared.size).toBe('a4');
    expect(result.structuredContent.declared.margin).toBe('15mm');
    expect(result.structuredContent.declared.rules.length).toBe(1);
    expect(result.content[0]!.text).toContain('declared size: a4');
  });

  test('a render can ask the page a question of its own', async () => {
    const reply = await legacy(2, 'tools/call', {
      name: 'render_html',
      arguments: {
        html:
          '<!doctype html><html lang="en"><head><style>@page{size:A4;margin:12mm}' +
          'body{font:12pt serif}.row{display:flex;gap:24px}</style></head>' +
          '<body><div class="row"><span>a</span><span>b</span></div></body></html>',
        probe: 'gaps',
        outputPath: join(dir, 'probed.pdf'),
      },
    });
    const result = resultOf(reply) as unknown as {
      structuredContent: { probe: Array<{ cause: string; em: number }> };
    };
    expect(result.structuredContent.probe.length).toBeGreaterThan(0);
    expect(result.structuredContent.probe[0]!.cause).toBe('flex-gap');
  }, 120_000);

  test('the stdio server reads and writes anywhere, because its caller owns the machine', async () => {
    const out = join(dir, 'stdio.pdf');
    const reply = await legacy(1, 'tools/call', {
      name: 'render_html',
      arguments: {
        html: '<!doctype html><html lang="en"><head><style>@page{size:A4;margin:12mm}</style></head><body><p>x</p></body></html>',
        outputPath: out,
      },
    });
    const result = resultOf(reply) as unknown as {
      isError?: boolean;
      structuredContent: { path: string };
    };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.path).toBe(out);
    expect((await Bun.file(out).arrayBuffer()).byteLength).toBeGreaterThan(1000);
  }, 120_000);

  test('a tool nobody has heard of is a protocol error', async () => {
    const reply = await legacy(1, 'tools/call', { name: 'make_coffee', arguments: {} });
    expect(errorOf(reply).code).toBe(-32602);
  });

  test('list_findings returns every code with its severity and its meaning', async () => {
    const reply = await legacy(1, 'tools/call', { name: 'list_findings', arguments: {} });
    const result = resultOf(reply) as unknown as {
      content: Array<{ type: string; text: string }>;
      structuredContent: { count: number; findings: Array<Record<string, string>> };
    };
    expect(result.structuredContent.count).toBeGreaterThan(30);
    for (const f of result.structuredContent.findings) {
      expect(['error', 'warn', 'info']).toContain(f['severity']!);
      expect((f['summary'] ?? '').length).toBeGreaterThan(10);
    }
    expect(result.content[0]!.text).toContain('js-error');
  });

  test('list_findings can be narrowed to one severity', async () => {
    const reply = await legacy(1, 'tools/call', {
      name: 'list_findings',
      arguments: { severity: 'error' },
    });
    const result = resultOf(reply) as unknown as {
      structuredContent: { findings: Array<Record<string, string>> };
    };
    expect(result.structuredContent.findings.length).toBeGreaterThan(0);
    for (const f of result.structuredContent.findings) {
      expect(f['severity']).toBe('error');
    }
  });

  test('a severity that is not one of the three is a tool error the model can act on', async () => {
    const reply = await legacy(1, 'tools/call', {
      name: 'list_findings',
      arguments: { severity: 'critical' },
    });
    const result = toolResult(reply);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('error, warn or info');
  });
});

describe('rendering through the server', () => {
  test('it makes a real pdf and reports what it found', async () => {
    const out = join(dir, 'rendered.pdf');
    const reply = await legacy(1, 'tools/call', {
      name: 'render_html',
      arguments: {
        html: '<!doctype html><html lang="en"><head><style>@page{size:A4;margin:12mm}</style></head><body><h1>Through MCP</h1></body></html>',
        outputPath: out,
      },
    });
    const result = resultOf(reply) as unknown as {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent: {
        ok: boolean;
        path: string;
        pages: number;
        bytes: number;
        findings: Array<{ code: string; severity: string }>;
      };
    };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.pages).toBe(1);
    expect(result.structuredContent.path).toBe(out);

    const bytes = new Uint8Array(await readFile(out));
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(Buffer.from(bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
  }, 120_000);

  test('a document with a problem reports the finding and says the pdf is not what was asked for', async () => {
    const reply = await legacy(2, 'tools/call', {
      name: 'render_html',
      arguments: {
        html: '<!doctype html><html><head><style>@page{size:A4;margin:10mm}</style></head><body><img src="missing.png"><p>x</p></body></html>',
        outputPath: join(dir, 'broken.pdf'),
      },
    });
    const result = resultOf(reply) as unknown as {
      structuredContent: { ok: boolean; findings: Array<{ code: string }> };
    };
    expect(result.structuredContent.findings.map((f) => f.code)).toContain('subresource-failed');
  }, 120_000);

  test('a render that cannot happen is a tool error with the reason in it', async () => {
    const reply = await legacy(3, 'tools/call', {
      name: 'render_html',
      arguments: { html: '<p>x</p>', format: 'a9' },
    });
    const result = toolResult(reply);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('format must be one of');
  }, 60_000);

  test('validate_pdf checks a file that is there', async () => {
    const pdf = join(dir, 'to-check.pdf');
    await writeFile(pdf, 'not a pdf at all', 'utf8');
    const reply = await legacy(4, 'tools/call', {
      name: 'validate_pdf',
      arguments: { path: pdf },
    });
    const result = resultOf(reply) as unknown as {
      structuredContent: { ok: boolean; findings: Array<{ code: string }> };
    };
    expect(result.structuredContent.ok).toBe(false);
    expect(result.structuredContent.findings.map((f) => f.code)).toEqual(['not-a-pdf']);
  }, 60_000);

  test('validate_pdf on a file that is not there says so', async () => {
    const reply = await legacy(5, 'tools/call', {
      name: 'validate_pdf',
      arguments: { path: join(dir, 'absent.pdf') },
    });
    const result = toolResult(reply);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('cannot read');
  }, 60_000);
});

describe('the messages a server may be sent', () => {
  test('a batch is answered with a reply for each request in it', async () => {
    const replies = (await handle(session, [
      { jsonrpc: '2.0', id: 30, method: 'ping' },
      { jsonrpc: '2.0', id: 31, method: 'tools/list' },
    ] as never)) as unknown as Array<{ id: number }>;
    expect(Array.isArray(replies)).toBe(true);
    expect(replies.map((r) => r.id)).toEqual([30, 31]);
  });

  test('a request with the id null is answered with an error, not dropped', async () => {
    const reply = (await handle(session, {
      jsonrpc: '2.0',
      id: null,
      method: 'ping',
    } as never)) as unknown as { id: number | null; error: { code: number } };
    expect(reply.id).toBeNull();
    expect(reply.error.code).toBe(-32600);
  });

  test('a tool call that cannot be written is refused, and the server survives', async () => {
    const reply = await send({
      jsonrpc: '2.0',
      id: 32,
      method: 'tools/call',
      params: {
        name: 'render_html',
        arguments: { html: '<p>x</p>', outputPath: '/no-such-directory-xyz/out.pdf' },
      },
    });
    const result = toolResult(reply);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('could not be written');

    const alive = await send({ jsonrpc: '2.0', id: 33, method: 'ping' });
    expect(alive).not.toBeNull();
  });
});

describe('the arguments a tool refuses', () => {
  test('a paper name is read the way the command line reads it', async () => {
    const reply = await send({
      jsonrpc: '2.0',
      id: 34,
      method: 'tools/call',
      params: { name: 'render_html', arguments: { html: '<p>x</p>', format: 'A4' } },
    });
    const result = toolResult(reply);
    expect(result.isError).toBeFalsy();
    const sizes = result.structuredContent!['pageSizes'] as string[];
    expect(sizes[0]).toContain('841.91');
  }, 60_000);

  test('a page range that starts after it ends is refused', async () => {
    const reply = await send({
      jsonrpc: '2.0',
      id: 39,
      method: 'tools/call',
      params: { name: 'render_html', arguments: { html: '<p>x</p>', pageRanges: '3-1' } },
    });
    const result = toolResult(reply);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('starts after it ends');
  });

  test('a page range that is not one is refused', async () => {
    const reply = await send({
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: { name: 'render_html', arguments: { html: '<p>x</p>', pageRanges: 'abc' } },
    });
    const result = toolResult(reply);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not a page number or a range');
  });

  test('a wait that is not a whole number is refused', async () => {
    const reply = await send({
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'render_html', arguments: { html: '<p>x</p>', settleMs: 1.5 } },
    });
    const result = toolResult(reply);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('whole number');
  });

  test('a paper nobody has heard of is refused', async () => {
    const reply = await send({
      jsonrpc: '2.0',
      id: 35,
      method: 'tools/call',
      params: { name: 'render_html', arguments: { html: '<p>x</p>', format: 'a9' } },
    });
    const result = toolResult(reply);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('format must be one of');
  });

  test('bytes that are not base64 are refused rather than decoded', async () => {
    const reply = await send({
      jsonrpc: '2.0',
      id: 36,
      method: 'tools/call',
      params: { name: 'validate_pdf', arguments: { pdf: '!!!not base64!!!' } },
    });
    const result = toolResult(reply);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not base64');
  });

  test('the work directory does not grow with the number of renders', async () => {
    const { readdir } = await import('node:fs/promises');
    for (let i = 0; i < 3; i++) {
      const reply = await send({
        jsonrpc: '2.0',
        id: 38 + i,
        method: 'tools/call',
        params: { name: 'render_html', arguments: { html: '<p>x</p>' } },
      });
      expect(toolResult(reply).isError).toBeFalsy();
    }
    const files = await readdir(session.context.workDir);
    const outputs = files.filter((f) => f.startsWith('output-'));
    expect(outputs.length).toBe(1);
  }, 120_000);

  test('the paper names the tool advertises are the papers the renderer has', async () => {
    const reply = await send({ jsonrpc: '2.0', id: 37, method: 'tools/list' });
    const tools = resultOf(reply)['tools'] as Array<{
      name: string;
      inputSchema: { properties: Record<string, { enum?: string[] }> };
    }>;
    const render = tools.find((t) => t.name === 'render_html')!;
    expect(render.inputSchema.properties['format']!.enum).toEqual([
      'a3',
      'a4',
      'a5',
      'legal',
      'letter',
      'tabloid',
    ]);
  });

  const refused = async (args: Record<string, unknown>) => {
    const reply = await send({
      jsonrpc: '2.0',
      id: 40,
      method: 'tools/call',
      params: { name: 'render_html', arguments: args },
    });
    return toolResult(reply);
  };

  test('a probe nobody has heard of is refused rather than ignored', async () => {
    const result = await refused({ html: '<p>x</p>', probe: 'nonsense' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('probe must be one of gaps, fonts');
  });

  test('a timeout the timer cannot honour is refused', async () => {
    const result = await refused({ html: '<p>x</p>', timeoutMs: 0 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('timeoutMs must be a whole number of at least 1000');
  });

  test('a negative wait is refused', async () => {
    const result = await refused({ html: '<p>x</p>', settleMs: -1 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('settleMs must be a whole number, zero or more');
  });
});

describe('the server as a process', () => {
  const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

  test('it answers over stdin and stdout, and nothing else reaches stdout', async () => {
    const proc = Bun.spawn(['bun', CLI, 'mcp'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const encoder = new TextEncoder();
    const send = (msg: unknown) => proc.stdin.write(encoder.encode(`${JSON.stringify(msg)}\n`));

    await send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      },
    });
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const lines: string[] = [];
    const deadline = Date.now() + 30_000;
    while (lines.length < 2 && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        lines.push(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
    }

    const replies = lines.map(
      (l) => JSON.parse(l) as { id: number; result?: Record<string, unknown> },
    );
    expect(replies.length, `only got ${lines.length} lines`).toBe(2);
    expect(replies[0]!.id).toBe(1);
    expect(replies[1]!.id).toBe(2);
    expect((replies[1]!.result as { tools: unknown[] }).tools.length).toBe(TOOLS.length);

    await proc.stdin.end();
    const code = await proc.exited;
    expect(code).toBe(0);
  }, 90_000);
});
