/**
 * Streamable HTTP MCP wrapper around the catalog REST API.
 * JSON-RPC only — retrieval still goes through handleMcpRequest (same auth/quota/RPC).
 * Spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 */
import {
  extractApiKey,
  handleMcpRequest,
  hashApiKey,
  keyPrefix,
  routePath,
  type McpDeps,
} from "./mcp-catalog.ts";

export const MCP_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export const MCP_DEFAULT_PROTOCOL = "2025-03-26";

export const MCP_INSTRUCTIONS =
  "Search Savante's catalog of real n8n workflows and self-hosted software. " +
  "Only cite names, ids, and import_ref values returned by the tools. " +
  "Do not invent workflow names. Do not quote prices or push a sales call — " +
  "this surface is discovery, not the quoted-plan email funnel.";

export const CATALOG_TOOLS = [
  {
    name: "search_automations",
    description:
      "Find real n8n-oriented automations for a business pain. " +
      "Pass tools (Gmail, Slack, …) and channels (email, form, webhook, …) when known.",
    inputSchema: {
      type: "object",
      required: ["pain"],
      properties: {
        pain: { type: "string", description: "What the user wants to automate, in their own words" },
        tools: { type: "array", items: { type: "string" }, description: "Integrations already in use" },
        channels: { type: "array", items: { type: "string" }, description: "How work arrives (email, form, …)" },
        wants_ai: { type: "string", enum: ["none", "ia", "rag"] },
        limit: { type: "integer", minimum: 1, maximum: 12, default: 8 },
      },
    },
  },
  {
    name: "search_software",
    description:
      "Find maintained self-hosted software that could replace a SaaS or fill a gap.",
    inputSchema: {
      type: "object",
      required: ["pain"],
      properties: {
        pain: { type: "string" },
        category: { type: "string", description: "Optional self-hosted software category" },
        limit: { type: "integer", minimum: 1, maximum: 6, default: 6 },
      },
    },
  },
  {
    name: "get_template",
    description: "Fetch one catalog hit by id (public fields only; no full workflow JSON).",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
      },
    },
  },
  {
    name: "list_categories",
    description: "List catalog categories with how many items each has, to help scope a search.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "recommend_automation",
    description:
      "Describe a business problem in plain language and get a short discovery recommendation " +
      "(matched workflows/software + why) grounded in the catalog. No pricing, no lead capture " +
      "— for a quoted plan, use the website intake instead.",
    inputSchema: {
      type: "object",
      required: ["problem_description"],
      properties: {
        problem_description: { type: "string", description: "The problem/pain in the caller's own words" },
      },
    },
  },
] as const;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

function jsonRpcResult(id: JsonRpcId, result: unknown, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

function jsonRpcError(id: JsonRpcId, code: number, message: string, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function httpJson(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function isMcpTransportPath(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p.endsWith("/mcp")) return true;
  if (p.endsWith("/mcp-search")) return true;
  if (p.endsWith("/catalog-search")) return true;
  if (p === "/" || p === "") return true;
  return false;
}

export function negotiateProtocol(requested: unknown): string {
  if (typeof requested === "string" && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested;
  }
  return MCP_DEFAULT_PROTOCOL;
}

function isNotification(msg: JsonRpcRequest): boolean {
  return !("id" in msg) || msg.id === undefined;
}

function copyAuthHeaders(from: Request): Headers {
  const h = new Headers();
  const auth = from.headers.get("authorization");
  const x = from.headers.get("x-api-key");
  if (auth) h.set("Authorization", auth);
  if (x) h.set("X-Api-Key", x);
  h.set("Content-Type", "application/json");
  return h;
}

function restUrl(mcpReq: Request, path: string): string {
  const u = new URL(mcpReq.url);
  // Keep origin; rewrite path to REST under the same function host.
  // Incoming: /functions/v1/mcp-search/mcp  or  /functions/v1/mcp-search
  const raw = u.pathname.replace(/\/+$/, "");
  const root = raw.replace(/\/mcp$/, "") || "/";
  const prefix = root.endsWith("/mcp-search") || root === "/" ? root : root;
  const base = prefix === "/" ? "" : prefix;
  return `${u.origin}${base}${path}`;
}

export function toolCallToRestRequest(mcpReq: Request, name: string, args: Record<string, unknown>): Request | { error: string } {
  const headers = copyAuthHeaders(mcpReq);
  if (name === "search_automations") {
    return new Request(restUrl(mcpReq, "/v1/search/automations"), {
      method: "POST",
      headers,
      body: JSON.stringify(args),
    });
  }
  if (name === "search_software") {
    return new Request(restUrl(mcpReq, "/v1/search/software"), {
      method: "POST",
      headers,
      body: JSON.stringify(args),
    });
  }
  if (name === "get_template") {
    const id = args.id;
    if (typeof id !== "string" || !id.trim()) return { error: "id is required" };
    return new Request(restUrl(mcpReq, `/v1/templates/${encodeURIComponent(id)}`), {
      method: "GET",
      headers,
    });
  }
  if (name === "list_categories") {
    return new Request(restUrl(mcpReq, "/v1/categories"), { method: "GET", headers });
  }
  if (name === "recommend_automation") {
    return new Request(restUrl(mcpReq, "/v1/recommend"), {
      method: "POST",
      headers,
      body: JSON.stringify(args),
    });
  }
  return { error: `unknown tool: ${name}` };
}

async function handleJsonRpcMessage(req: Request, msg: JsonRpcRequest, deps: McpDeps): Promise<Response> {
  const id = (msg.id ?? null) as JsonRpcId;
  const method = msg.method ?? "";

  if (msg.jsonrpc !== "2.0") {
    return jsonRpcError(id, -32600, "invalid JSON-RPC version");
  }

  if (isNotification(msg)) {
    // initialized, etc. — no body
    return new Response(null, { status: 202 });
  }

  if (method === "initialize") {
    const params = (msg.params ?? {}) as { protocolVersion?: string };
    const protocolVersion = negotiateProtocol(params.protocolVersion);
    return jsonRpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "savante-catalog", version: "1.0.0" },
      instructions: MCP_INSTRUCTIONS,
    });
  }

  if (method === "ping" || method === "notifications/initialized") {
    return jsonRpcResult(id, {});
  }

  if (method === "tools/list") {
    return jsonRpcResult(id, { tools: CATALOG_TOOLS });
  }

  if (method === "tools/call") {
    const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const name = params.name ?? "";
    const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
    const rest = toolCallToRestRequest(req, name, args);
    if ("error" in rest && rest.error) {
      return jsonRpcResult(id, {
        isError: true,
        content: [{ type: "text", text: rest.error }],
      });
    }
    const apiRes = await handleMcpRequest(rest as Request, deps);
    const payload = await apiRes.text();
    if (apiRes.status === 401 || apiRes.status === 403) {
      return httpJson(JSON.parse(payload || "{}"), apiRes.status);
    }
    const isError = apiRes.status >= 400;
    return jsonRpcResult(id, {
      isError,
      content: [{ type: "text", text: payload }],
    });
  }

  return jsonRpcError(id, -32601, `method not found: ${method}`);
}

/** Auth for the MCP transport: every JSON-RPC request needs a live key (fail closed). */
async function requireLiveKey(req: Request, deps: McpDeps): Promise<Response | null> {
  const secret = extractApiKey(req);
  if (!secret) {
    await deps.log({
      api_key_id: null, user_id: null, tool: "mcp_rpc", status: 401,
      latency_ms: 0, result_count: null, filters: { reason: "missing_key" },
    });
    return httpJson({ error: "unauthorized" }, 401);
  }
  const key = await deps.lookupKey(await hashApiKey(secret));
  if (!key) {
    await deps.log({
      api_key_id: null, user_id: null, tool: "mcp_rpc", status: 401,
      latency_ms: 0, result_count: null, filters: { key_prefix: keyPrefix(secret) },
    });
    return httpJson({ error: "unauthorized" }, 401);
  }
  if (key.revoked_at) {
    await deps.log({
      api_key_id: key.id, user_id: key.user_id, tool: "mcp_rpc", status: 403,
      latency_ms: 0, result_count: null, filters: {},
    });
    return httpJson({ error: "revoked" }, 403);
  }
  return null;
}

export async function handleMcpJsonRpc(req: Request, deps: McpDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method === "GET") {
    return new Response(null, { status: 405, headers: { Allow: "POST, DELETE, OPTIONS" } });
  }
  if (req.method === "DELETE") {
    return new Response(null, { status: 204 });
  }
  if (req.method !== "POST") {
    return httpJson({ error: "method_not_allowed" }, 405);
  }

  const denied = await requireLiveKey(req, deps);
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonRpcError(null, -32700, "parse error");
  }

  if (Array.isArray(raw)) {
    return jsonRpcError(null, -32600, "batched JSON-RPC is not supported");
  }
  if (!raw || typeof raw !== "object") {
    return jsonRpcError(null, -32600, "invalid request");
  }

  return handleJsonRpcMessage(req, raw as JsonRpcRequest, deps);
}

export async function handleCatalogHttp(req: Request, deps: McpDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  const pathname = new URL(req.url).pathname;
  if (routePath(pathname)) return handleMcpRequest(req, deps);
  if (isMcpTransportPath(pathname)) return handleMcpJsonRpc(req, deps);
  return httpJson({ error: "not_found" }, 404);
}
