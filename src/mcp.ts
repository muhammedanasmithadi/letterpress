/**
 * An MCP server for letterpress, over stdio.
 *
 * The protocol is JSON-RPC 2.0, one message per line, on stdin and stdout.
 * That is the whole transport: the server reads a line, decides what it means,
 * writes a line back. There is no SDK here and no dependency, because the
 * protocol surface this server needs is small -- list the tools, call a tool,
 * and say who you are.
 *
 * Two eras of the protocol, because clients in the wild speak both.
 *
 * The current revision is stateless: every request carries its protocol
 * version in `_meta`, there is no handshake, and `server/discover` is how a
 * client learns what the server supports. The revision before it -- and every
 * one before that -- opens with an `initialize` request and a negotiated
 * version, and the client then sends `notifications/initialized`. The spec
 * calls a server that speaks both a dual-era server, and the rule for telling
 * them apart is in the request itself: a request carrying modern per-request
 * metadata is modern, and an `initialize` request selects the legacy
 * behaviour for the rest of the session.
 *
 * What differs between the two is small but real. The modern result carries a
 * `resultType`, and a `tools/list` result carries a cache lifetime; the
 * legacy one does not. A server that answered a legacy client with a modern
 * result would send fields that client never asked for, and one that answered
 * a modern client without `resultType` would fail the modern schema.
 */
import { closeContext, makeContext, TOOLS, callTool, type McpContext } from './mcptools.ts';

export const MODERN_VERSION = '2026-07-28';

/** The revisions that open with a handshake, newest first. */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const SERVER_INFO = { name: 'letterpress', version: '0.1.0' };

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

/** What the server remembers between messages on one connection. */
export type Session = {
  /** The legacy version agreed in the handshake, if there was one. */
  legacyVersion?: string;
  /** Whether the legacy handshake has completed. */
  initialized: boolean;
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

/** The `_meta` block of a request, or an empty object. */
function metaOf(msg: Message): Json {
  const meta = (msg.params as Json | undefined)?.['_meta'];
  return meta && typeof meta === 'object' ? (meta as Json) : {};
}

/**
 * The protocol version a modern request declares, or null when the request is
 * not modern.
 *
 * A request with no version in `_meta` is a legacy one, whatever else it
 * contains: the legacy revisions have no such field to carry it in.
 */
export function declaredVersion(msg: Message): string | null {
  const version = metaOf(msg)[META_VERSION];
  return typeof version === 'string' ? version : null;
}

/** True when the request says it is a modern one. */
export function isModern(msg: Message): boolean {
  return declaredVersion(msg) !== null;
}

/** The tool definitions, in the shape both eras use. */
function toolList(): Json[] {
  return TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/** A modern result carries `resultType`, and says who the server is. */
function modernResult(body: Json): Json {
  return {
    resultType: 'complete',
    ...body,
    _meta: { [META_SERVER_INFO]: SERVER_INFO },
  };
}

/**
 * Handle one request.
 *
 * Returns null for a notification, which gets no reply: JSON-RPC says a
 * notification is a message with no id, and answering one would put a
 * response on the wire that the client is not waiting for.
 */
export async function handle(session: Session, msg: Message): Promise<Reply | null> {
  if (msg.method === undefined) return null;
  if (msg.id === undefined || msg.id === null) {
    // A notification. The only one that matters is the legacy handshake's
    // `initialized`, which changes nothing here because this server keeps no
    // per-session state beyond the agreed version.
    return null;
  }
  const id = msg.id;

  // The version check comes first, and before everything else, because the
  // error it produces is what a dual-era client uses to tell a modern server
  // from a legacy one. A client that asked for a version this server does not
  // speak must be told that, not told to try a different method.
  const version = declaredVersion(msg);
  if (version !== null && !isSupportedModern(version)) {
    return fail(id, -32022, 'Unsupported protocol version', {
      supported: [MODERN_VERSION],
      requested: version,
    });
  }

  if (msg.method === 'server/discover') return discover(id);

  // A modern request must carry both required `_meta` fields. One that does
  // not is malformed, and the spec asks for -32602 rather than a guess about
  // what the client meant.
  if (version !== null && metaOf(msg)[META_CLIENT_CAPS] === undefined) {
    return fail(id, -32602, `a modern request must carry ${META_CLIENT_CAPS} in _meta`);
  }

  if (msg.method === 'initialize') return initialize(session, id, msg);
  if (msg.method === 'ping') return ok(id, isModern(msg) ? modernResult({}) : {});
  if (msg.method === 'tools/list') return listTools(id, msg);
  if (msg.method === 'tools/call') return callToolRequest(session, id, msg);

  return fail(id, -32601, `Method not found: ${msg.method}`);
}

/**
 * What this server is and what it can do.
 *
 * Always a modern result, whatever the request looked like. This is the
 * method a dual-era client uses to find out whether the server speaks modern
 * at all, and a legacy-shaped answer would be read as "no".
 *
 * The other required `_meta` field is not checked here, and deliberately:
 * this is the probe, and a client probing may not have filled in its
 * capabilities yet. Answering it wrongly would send a modern client down the
 * legacy fallback path.
 */
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

/** The legacy handshake: agree a version and say what this server is. */
function initialize(session: Session, id: string | number, msg: Message): Reply {
  const version = agreedVersion((msg.params as Json | undefined)?.['protocolVersion']);
  session.legacyVersion = version;
  session.initialized = true;
  return ok(id, {
    protocolVersion: version,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  });
}

/**
 * The legacy version to speak.
 *
 * The client's choice if this server supports it, and otherwise the newest
 * legacy revision there is. The spec says a server that does not support the
 * requested version should answer with one it does, and that it should be the
 * latest: the client then either uses it or disconnects, and both outcomes
 * are better than a client waiting for a reply that never comes.
 */
function agreedVersion(requested: unknown): string {
  if (typeof requested !== 'string') return LEGACY_VERSIONS[0]!;
  if (!LEGACY_VERSIONS.includes(requested)) return LEGACY_VERSIONS[0]!;
  return requested;
}

/** The tools, in the shape the era of the request calls for. */
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

/** The `tools/call` request: find the tool, run it, answer. */
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

/** The state a session starts in. */
export async function newSession(): Promise<Session> {
  return { initialized: false, context: await makeContext() };
}

/**
 * Run the server over stdin and stdout until stdin closes.
 *
 * Nothing but protocol messages goes to stdout. The spec says so, and a
 * client's parser has no way to skip a line it does not understand, so a
 * stray `console.log` would break the connection rather than merely annoy it.
 */
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
    // A line that is not JSON cannot be answered: there is no id to answer.
    process.stderr.write('letterpress-mcp: ignoring a line that is not JSON\n');
    return;
  }
  const reply = await handle(session, msg);
  if (reply === null) return;
  process.stdout.write(`${JSON.stringify(reply)}\n`);
}

/**
 * Run the server until stdin closes.
 *
 * Exported so the CLI can own the process: the server's own `import.meta.main`
 * block does the same thing, and this is the version a caller that has
 * already imported the module uses.
 */
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
