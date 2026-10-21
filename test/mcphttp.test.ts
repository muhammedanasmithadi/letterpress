import { rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { useTestServer } from './servers.ts';

const server = useTestServer();

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

function post(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${server.origin}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function modern(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const method = String(body['method'] ?? '');
  const name = (body['params'] as Record<string, unknown> | undefined)?.['name'];
  return post(
    { ...body, params: { ...(body['params'] as object), _meta: MODERN_META } },
    {
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...(name ? { 'mcp-name': String(name) } : {}),
      ...headers,
    },
  );
}

describe('the mcp endpoint', () => {
  test('it answers a discovery request', async () => {
    const r = await modern({ jsonrpc: '2.0', id: 1, method: 'server/discover' });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { result: { supportedVersions: string[] } };
    expect(body.result.supportedVersions).toEqual(['2026-07-28']);
  });

  test('it lists the tools', async () => {
    const r = await modern({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const body = (await r.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name).sort()).toEqual([
      'list_findings',
      'page_rules',
      'render_html',
      'validate_pdf',
    ]);
  });

  test('it calls a tool', async () => {
    const r = await modern({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_findings', arguments: { severity: 'error' } },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { result: { content: Array<{ text: string }> } };
    expect(body.result.content[0]!.text).toContain('not-a-pdf');
  });

  test('a legacy client gets the handshake it asked for', async () => {
    const r = await post({
      jsonrpc: '2.0',
      id: 4,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    });
    const body = (await r.json()) as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe('2025-06-18');
  });

  test('a notification is accepted with no body', async () => {
    const r = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(r.status).toBe(202);
    expect(await r.text()).toBe('');
  });

  test('the headers and the body have to agree', async () => {
    const cases: Array<[string, Record<string, string>]> = [
      ['Mcp-Method header value', { 'mcp-method': 'tools/call' }],
      ['Mcp-Name header value', { 'mcp-name': 'render_html' }],
      ['MCP-Protocol-Version header value', { 'mcp-protocol-version': '2025-06-18' }],
    ];
    for (const [what, headers] of cases) {
      const r = await modern({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, headers);
      expect(r.status, what).toBe(400);
      const body = (await r.json()) as { error: { code: number } };
      expect(body.error.code, what).toBe(-32020);
    }
  });

  test('a body that is not JSON is refused', async () => {
    const r = await fetch(`${server.origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  test('the wrong content type is refused', async () => {
    const r = await fetch(`${server.origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(r.status).toBe(415);
  });

  test('a GET is not allowed', async () => {
    expect((await fetch(`${server.origin}/mcp`)).status).toBe(405);
  });

  test('the pdf cannot be written outside the server own directory', async () => {
    for (const outputPath of [
      '/tmp/letterpress-escape.pdf',
      '/etc/passwd',
      '../escape.pdf',
      '../../escape.pdf',
    ]) {
      const r = await modern({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'render_html',
          arguments: { html: '<p>x</p>', outputPath },
        },
      });
      const body = (await r.json()) as {
        result: { isError?: boolean; content: Array<{ text: string }> };
      };
      expect(body.result.isError, outputPath).toBe(true);
      expect(body.result.content[0]!.text, outputPath).toContain('can only be written inside');
    }
  }, 120_000);

  test('a symbolic link out of the directory is refused too', async () => {
    const first = await modern({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'render_html',
        arguments: { html: '<p>x</p>', outputPath: '/etc/passwd' },
      },
    });
    const body = (await first.json()) as {
      result: { content: Array<{ text: string }> };
    };
    const root = /inside (.+), not/.exec(body.result.content[0]!.text)?.[1];
    expect(root, 'the refusal names the directory').toBeTruthy();

    const link = join(root!, 'escape.pdf');
    await symlink('/tmp/letterpress-symlink-target.pdf', link);
    try {
      const r = await modern({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: {
          name: 'render_html',
          arguments: { html: '<p>x</p>', outputPath: link },
        },
      });
      const out = (await r.json()) as {
        result: { isError?: boolean; content: Array<{ text: string }> };
      };
      expect(out.result.isError).toBe(true);
      expect(out.result.content[0]!.text).toContain('can only be written inside');
    } finally {
      await rm(link, { force: true }).catch(() => {});
    }
  }, 120_000);

  test('a pdf is checked by its bytes, and not by a path outside the directory', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n').toString('base64');

    const byPath = await modern({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'validate_pdf', arguments: { path: '/etc/passwd' } },
    });
    const refused = (await byPath.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0]!.text).toContain('can be read');

    const byBytes = await modern({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'validate_pdf', arguments: { pdf } },
    });
    const checked = (await byBytes.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    expect(checked.result.isError).toBeFalsy();
    expect(checked.result.content[0]!.text).toContain('finding');
  }, 60_000);

  test('a request from another web page is refused', async () => {
    const r = await fetch(`${server.origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://example.com' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list' }),
    });
    expect(r.status).toBe(403);
  });
});

describe('what a shared server will not do', () => {
  const HTML =
    '<!doctype html><html lang="en"><head><style>@page{size:A4;margin:12mm}</style></head><body><p>x</p></body></html>';

  async function call(args: Record<string, unknown>) {
    const r = await modern({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'render_html', arguments: args },
    });
    const body = (await r.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    return body.result;
  }

  test('a file on the server is not read', async () => {
    const result = await call({ path: '/etc/hostname' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('send the html');
  });

  test('a url is not fetched', async () => {
    const result = await call({ html: HTML, url: 'http://127.0.0.1:9/secret' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('send the html');
  });

  test('two callers do not get the same file', async () => {
    const first = await call({ html: HTML });
    const second = await call({ html: HTML });
    const a = (first.content[0]!.text.match(/wrote (\S+)/) ?? [])[1];
    const b = (second.content[0]!.text.match(/wrote (\S+)/) ?? [])[1];
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  test('a body over the limit is refused', async () => {
    const r = await fetch(`${server.origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        pad: 'x'.repeat(9 * 1024 * 1024),
      }),
    });
    expect(r.status).toBe(413);
  });
});

describe('the version header', () => {
  test('a version this server does not speak is refused', async () => {
    const r = await fetch(`${server.origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-protocol-version': '1999-01-01' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: number; data: { supported: string[] } } };
    expect(body.error.code).toBe(-32022);
    expect(body.error.data.supported).toContain('2026-07-28');
  });

  test('a base64 encoded version is understood', async () => {
    const encoded = `=?base64?${Buffer.from('2026-07-28').toString('base64')}?=`;
    const r = await fetch(`${server.origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-protocol-version': encoded },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: MODERN_META },
      }),
    });
    expect(r.status).toBe(200);
  });

  test('a custom parameter header that disagrees with the body is refused', async () => {
    const r = await fetch(`${server.origin}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-method': 'tools/call',
        'mcp-name': 'render_html',
        'mcp-param-html': 'something else',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'render_html', arguments: { html: '<p>x</p>' } },
      }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32020);
  });
});
