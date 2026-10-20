import { closeContext, makeContext, TOOLS, callTool, type McpContext } from './mcptools.ts';

export const MODERN_VERSION = '2026-07-28';

export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const SERVER_INFO = { name: 'letterpress', version: '0.1.0' };

const INSTRUCTIONS =
  'Render HTML to PDF through Chromium own print engine, and check PDFs that already exist. ' +
  'A render reports findings: severity error means the PDF is not the document you asked for, ' +
  'warn means something is degraded, and info is a note. Call list_findings to find out what a code means.';

type Json = Record<string, unknown>;

type Message = {
  jsonrpc: string;
  id?: string | number;
  method?: string;
  params?: Json;
};

type Reply =
  | { jsonrpc: '2.0'; id: string | number; result: Json }
  | {
      jsonrpc: '2.0';
      id: string | number;
      error: { code: number; message: string; data?: unknown };
    };

export type Session = {
  context: McpContext;
};

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

function ok(id: string | number, result: Json): Reply {
  return { jsonrpc: '2.0', id, result };
}

function fail(id: string | number, code: number, message: string, data?: unknown): Reply {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

function metaOf(msg: Message): Json {
  const meta = (msg.params as Json | undefined)?.['_meta'];
  return meta && typeof meta === 'object' ? (meta as Json) : {};
}

function declaredVersion(msg: Message): string | null {
  const version = metaOf(msg)[META_VERSION];
  return typeof version === 'string' ? version : null;
}

function isModern(msg: Message): boolean {
  return declaredVersion(msg) !== null;
}

function toolList(): Json[] {
  return TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

function modernResult(body: Json): Json {
  return {
    resultType: 'complete',
    ...body,
    _meta: { [META_SERVER_INFO]: SERVER_INFO },
  };
}

export async function handle(session: Session, msg: Message): Promise<Reply | null> {
  if (msg.method === undefined) return null;
  if (msg.id === undefined || msg.id === null) {
    return null;
  }
  const id = msg.id;

  const version = declaredVersion(msg);
  if (version !== null && !isSupportedModern(version)) {
    return fail(id, -32022, 'Unsupported protocol version', {
      supported: [MODERN_VERSION],
      requested: version,
    });
  }

  if (msg.method === 'server/discover') return discover(id);

  if (version !== null && metaOf(msg)[META_CLIENT_CAPS] === undefined) {
    return fail(id, -32602, `a modern request must carry ${META_CLIENT_CAPS} in _meta`);
  }

  if (msg.method === 'initialize') return initialize(id, msg);
  if (msg.method === 'ping') return ok(id, isModern(msg) ? modernResult({}) : {});
  if (msg.method === 'tools/list') return listTools(id, msg);
  if (msg.method === 'tools/call') return callToolRequest(session, id, msg);

  return fail(id, -32601, `Method not found: ${msg.method}`);
}

function discover(id: string | number): Reply {
  return ok(
    id,
    modernResult({
      supportedVersions: [MODERN_VERSION],
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
      ttlMs: 3_600_000,
      cacheScope: 'public',
    }),
  );
}

function initialize(id: string | number, msg: Message): Reply {
  const version = agreedVersion((msg.params as Json | undefined)?.['protocolVersion']);
  return ok(id, {
    protocolVersion: version,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  });
}

function agreedVersion(requested: unknown): string {
  if (typeof requested !== 'string') return LEGACY_VERSIONS[0]!;
  if (!LEGACY_VERSIONS.includes(requested)) return LEGACY_VERSIONS[0]!;
  return requested;
}

function listTools(id: string | number, msg: Message): Reply {
  const tools = toolList();
  if (isModern(msg)) {
    return ok(id, modernResult({ tools, ttlMs: 3_600_000, cacheScope: 'public' }));
  }
  return ok(id, { tools });
}

function isSupportedModern(version: string): boolean {
  return version === MODERN_VERSION;
}

async function callToolRequest(
  session: Session,
  id: string | number,
  msg: Message,
): Promise<Reply> {
  const params = (msg.params ?? {}) as Json;
  const name = params['name'];
  if (typeof name !== 'string') {
    return fail(id, -32602, 'tools/call needs a tool name');
  }
  const args = (params['arguments'] ?? {}) as Json;
  if (typeof args !== 'object' || Array.isArray(args)) {
    return fail(id, -32602, `the arguments to ${name} must be an object`);
  }

  const result = await callTool(name, args, session.context);
  if (result === null) {
    return fail(id, -32602, `Unknown tool: ${name}`);
  }

  const body: Json = { content: result.content };
  if (result.structuredContent !== undefined) body['structuredContent'] = result.structuredContent;
  if (result.isError) body['isError'] = true;
  return ok(id, isModern(msg) ? modernResult(body) : body);
}

export async function newSession(): Promise<Session> {
  return { context: await makeContext() };
}

export async function serve(session: Session): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      await respond(session, line);
    }
  }
}

async function respond(session: Session, line: string): Promise<void> {
  let msg: Message;
  try {
    msg = JSON.parse(line) as Message;
  } catch {
    process.stderr.write('letterpress-mcp: ignoring a line that is not JSON\n');
    return;
  }
  const reply = await handle(session, msg);
  if (reply === null) return;
  process.stdout.write(`${JSON.stringify(reply)}\n`);
}

export async function runMcp(): Promise<number> {
  const session = await newSession();
  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(0);
    stopping = true;
    void closeContext(session.context).finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await serve(session);
  await closeContext(session.context);
  return 0;
}

if (import.meta.main) {
  process.exit(await runMcp());
}
