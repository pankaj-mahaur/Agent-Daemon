// The MCP protocol layer of ad's memory server (P5.1), pure: no I/O.
//
// Two eras, both answered by one process:
//   legacy (2024-11-05 … 2025-11-25): the client sends initialize first; this
//     process then answers with the legacy result shapes;
//   2026-07-28: no initialize; every request carries _meta with
//     io.modelcontextprotocol/protocolVersion and clientCapabilities; results
//     carry resultType (and list results ttlMs/cacheScope). The engine (0.163) opens
//     with server/discover in that mode (spike S-MCP); its client (rmcp 3.5.1)
//     rejects a discover result without ttlMs and cacheScope.
//
//   negotiateLegacy(v) → the version to answer initialize with
//   createSession() → {legacyVersion, cancelled, inFlight}
//   handle(session, msg, {listTools, callTool, serverInfo, instructions}) → response | null
//     msg {parseError: true} stands for a line that wasn't JSON.
//     callTool(name, args) → text; a throw becomes isError content.

export const MODERN = ["2026-07-28"];
export const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPS = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER = "io.modelcontextprotocol/serverInfo";
const TTL_MS = 3600000;

export const NO_ERA_TEXT = "Send initialize (MCP 2025-11-25 or earlier) or include _meta (2026-07-28).";

/** The legacy version to answer with: the client's when it is one we speak, else the newest legacy one. */
export function negotiateLegacy(requested) {
  return LEGACY.includes(requested) ? requested : LEGACY[0];
}

export function createSession() {
  return { legacyVersion: null, cancelled: new Set(), inFlight: new Map() };
}

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const fail = (id, code, message, data) => ({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });

async function runTool(session, id, params, { listTools, callTool }) {
  const name = params?.name;
  if (typeof name !== "string" || !listTools().some((t) => t.name === name)) return { error: [-32602, `Unknown tool: ${name}`] };
  session.inFlight.set(id, true);
  try {
    const text = await callTool(name, params?.arguments && typeof params.arguments === "object" ? params.arguments : {});
    return { result: { content: [{ type: "text", text: String(text) }] } };
  } catch (err) {
    // A tool's failure is the tool's answer (MCP: isError), never a protocol error.
    return { result: { content: [{ type: "text", text: String(err?.message ?? err) }], isError: true } };
  } finally {
    session.inFlight.delete(id);
  }
}

export async function handle(session, msg, ctx) {
  const { listTools, serverInfo, instructions } = ctx;
  if (msg?.parseError) return fail(null, -32700, "Parse error");
  if (Array.isArray(msg)) return fail(null, -32600, "Invalid request: batches aren't supported");
  const id = msg && typeof msg === "object" && "id" in msg ? msg.id : undefined;
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(id ?? null, -32600, "Invalid request");
  const { method, params } = msg;

  // Notifications: never answered.
  if (id === undefined) {
    // Only a request still running can be cancelled: a late cancel for a finished id
    // must not swallow the reply to a later request that reuses that id.
    if (method === "notifications/cancelled" && params && session.inFlight.has(params.requestId)) session.cancelled.add(params.requestId);
    return null;
  }
  const answer = async (fn) => {
    const r = await fn();
    // A request the client cancelled meanwhile gets no reply at all.
    if (session.cancelled.delete(id)) return null;
    return r;
  };

  if (method === "initialize") {
    session.legacyVersion = negotiateLegacy(params?.protocolVersion);
    return ok(id, { protocolVersion: session.legacyVersion, capabilities: { tools: { listChanged: false } }, serverInfo, instructions });
  }

  const meta = params?._meta;
  if (meta && typeof meta === "object" && META_VERSION in meta) {
    const requested = meta[META_VERSION];
    if (!MODERN.includes(requested)) return fail(id, -32022, "Unsupported protocol version. Clients on 2025-11-25 or earlier: send initialize.", { supported: [...MODERN], requested });
    if (!meta[META_CAPS] || typeof meta[META_CAPS] !== "object") return fail(id, -32602, `Missing _meta["${META_CAPS}"]`);
    const stamp = { _meta: { [META_SERVER]: serverInfo } };
    switch (method) {
      case "server/discover":
        return ok(id, { resultType: "complete", supportedVersions: [...MODERN], capabilities: { tools: {} }, instructions, ttlMs: TTL_MS, cacheScope: "private", ...stamp });
      case "tools/list":
        return ok(id, { resultType: "complete", tools: listTools(), ttlMs: TTL_MS, cacheScope: "private", ...stamp });
      case "tools/call":
        return answer(async () => {
          const r = await runTool(session, id, params, ctx);
          return r.error ? fail(id, ...r.error) : ok(id, { resultType: "complete", ...r.result, ...stamp });
        });
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  }

  if (method === "ping") return ok(id, {});
  if (!session.legacyVersion) return fail(id, -32602, NO_ERA_TEXT);
  switch (method) {
    case "tools/list":
      return ok(id, { tools: listTools() });
    case "tools/call":
      return answer(async () => {
        const r = await runTool(session, id, params, ctx);
        return r.error ? fail(id, ...r.error) : ok(id, r.result);
      });
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}
