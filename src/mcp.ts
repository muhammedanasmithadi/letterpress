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
  | { jsonrpc: '2.0'; id: string | number | null; result: Json }
  | {
      jsonrpc: '2.0';
      id: string | number | null;
      error: { code: number; message: string; data?: unknown };
    };

export type Session = {
  context: McpContext;
};

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

function ok(id: string | number | null, result: Json): Reply {
  return { jsonrpc: '2.0', id, result };
}

function fail(id: string | number | null, code: number, message: string, data?: unknown): Reply {
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

export async function handle(
  session: Session,
  msg: Message | Message[],
  headerVersion?: string | null,
): Promise<Reply | Reply[] | null> {
  if (Array.isArray(msg)) return handleBatch(session, msg, headerVersion);
  if (msg.method === undefined) return null;
  if (msg.id === undefined) {
    return null;
  }
  const id = msg.id;

  const version = declaredVersion(msg);
  if (version !== null && !isSupportedModern(version)) {
    return fail(id, -32022, 'Unsupported protocol version', {
      supported: [MODERN_VERSION, ...LEGACY_VERSIONS],
      requested: version,
    });
  }

  const modern = version !== null || headerVersion === MODERN_VERSION;
  if (modern && metaOf(msg)[META_CLIENT_CAPS] === undefined) {
    return fail(id, -32602, `a modern request must carry ${META_CLIENT_CAPS} in _meta`);
  }

  if (msg.id === null) {
    return fail(null, -32600, 'a request must have an id, and null is not one');
  }
  return dispatch(session, id, msg, modern);
}

function dispatch(
  session: Session,
  id: string | number,
  msg: Message,
  modern: boolean,
): Reply | Promise<Reply> {
  if (msg.method === 'server/discover') return discover(id, modern);
  if (msg.method === 'initialize') return initialize(id, msg, modern);
  if (msg.method === 'ping') return ok(id, modern ? modernResult({}) : {});
  if (msg.method === 'tools/list') return listTools(id, modern);
  if (msg.method === 'tools/call') return callToolRequest(session, id, msg, modern);

  return fail(id, -32601, `Method not found: ${msg.method}`);
}

async function handleBatch(
  session: Session,
  msgs: Message[],
  headerVersion?: string | null,
): Promise<Reply[]> {
  const replies: Reply[] = [];
  for (const one of msgs) {
    const reply = await handle(session, one, headerVersion);
    if (reply !== null && !Array.isArray(reply)) replies.push(reply);
  }
  return replies;
}

function discover(id: string | number, modern: boolean): Reply {
  const body = {
    supportedVersions: [MODERN_VERSION],
    capabilities: { tools: {} },
    instructions: INSTRUCTIONS,
    ttlMs: 3_600_000,
    cacheScope: 'public',
  };
  return ok(id, modern ? modernResult(body) : body);
}

function initialize(id: string | number, msg: Message, modern: boolean): Reply {
  const requested = (msg.params as Json | undefined)?.['protocolVersion'];
  const body = {
    protocolVersion: modern ? MODERN_VERSION : agreedVersion(requested),
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  };
  return ok(id, modern ? modernResult(body) : body);
}

function agreedVersion(requested: unknown): string {
  if (typeof requested !== 'string') return LEGACY_VERSIONS[0]!;
  if (!LEGACY_VERSIONS.includes(requested)) return LEGACY_VERSIONS[0]!;
  return requested;
}

function listTools(id: string | number, modern: boolean): Reply {
  const tools = toolList();
  if (modern) {
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
  modern: boolean,
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
  return ok(id, modern ? modernResult(body) : body);
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
      void respond(session, line);
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
  try {
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  } catch {}
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
