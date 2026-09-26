/**
 * Streamable HTTP MCP wrapper tests. Tools must hit the REST handler (same quota/RPC).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handleMcpRequest,
  hashApiKey,
  type ApiKeyRecord,
  type CategoryRow,
  type LogEntry,
  type MatchTemplatesArgs,
  type McpDeps,
  type RecommendationResult,
  type RpcHit,
  type UsageSnapshot,
} from "../supabase/functions/_shared/mcp-catalog.ts";
import {
  CATALOG_TOOLS,
  handleCatalogHttp,
  handleMcpJsonRpc,
  isMcpTransportPath,
  negotiateProtocol,
  toolCallToRestRequest,
} from "../supabase/functions/_shared/mcp-rpc.ts";

const SECRET = "sav_live_testsecret00000000000000000000000000000000";
let SECRET_HASH = "";
const KEY: ApiKeyRecord = { id: "key-1", user_id: "user-1", plan: "free", revoked_at: null };

async function harness(): Promise<{
  deps: McpDeps;
  logs: LogEntry[];
  lastRpc: { current: MatchTemplatesArgs | null };
}> {
  if (!SECRET_HASH) SECRET_HASH = await hashApiKey(SECRET);
  const logs: LogEntry[] = [];
  const lastRpc: { current: MatchTemplatesArgs | null } = { current: null };
  const deps: McpDeps = {
    now: () => new Date("2026-09-14T12:00:00Z"),
    embed: async () => new Array(384).fill(0.01),
    matchTemplates: async (args) => {
      lastRpc.current = args;
      const row: RpcHit = {
        id: "wf-1", name: "Gmail CV parser", category: "Gmail",
        integrations: ["Gmail"], trigger_type: ["email"], has_ai: true, is_rag: false,
        description: "Parse CVs", import_ref: "https://n8n.io/workflows/wf-1", similarity: 0.9,
      };
      return [row];
    },
    getTemplate: async (id) => id === "wf-1" ? { id: "wf-1", name: "Gmail CV parser", description: "Parse CVs" } : null,
    listCategories: async (): Promise<CategoryRow[]> => [{ category: "Gmail", count: 1 }],
    recommend: async (): Promise<RecommendationResult> => ({
      summary: "Automatizá el parseo de CVs.",
      recommended_workflows: [{ import_ref: "https://n8n.io/workflows/wf-1", name: "Gmail CV parser", why: "Cubre el caso." }],
      recommended_software: [],
      matched_template_ids: ["wf-1"],
    }),
    lookupKey: async (hash) => hash === SECRET_HASH ? KEY : null,
    countUsage: async (): Promise<UsageSnapshot> => ({ count: 0, oldestAt: null }),
    log: async (e) => { logs.push(e); },
    touchKey: async () => {},
  };
  return { deps, logs, lastRpc };
}

function mcpReq(body: unknown, path = "/mcp"): Request {
  return new Request(`https://example.supabase.co/functions/v1/catalog-search${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
}

test("MCP transport path is /mcp or the function root, not REST", () => {
  assert.equal(isMcpTransportPath("/functions/v1/catalog-search/mcp"), true);
  assert.equal(isMcpTransportPath("/functions/v1/catalog-search"), true);
  assert.equal(isMcpTransportPath("/functions/v1/catalog-search/v1/search/automations"), false);
  assert.equal(isMcpTransportPath("/v1/templates/x"), false);
});

test("negotiateProtocol falls back to 2025-03-26", () => {
  assert.equal(negotiateProtocol("2025-11-25"), "2025-11-25");
  assert.equal(negotiateProtocol("nope"), "2025-03-26");
});

test("toolCallToRestRequest maps onto the v1 REST paths under the function", () => {
  const incoming = new Request("https://x.supabase.co/functions/v1/catalog-search/mcp", {
    headers: { Authorization: "Bearer sav_live_abc" },
  });
  const a = toolCallToRestRequest(incoming, "search_automations", { pain: "cv" }) as Request;
  assert.equal(new URL(a.url).pathname, "/functions/v1/catalog-search/v1/search/automations");
  assert.equal(a.method, "POST");
  const g = toolCallToRestRequest(incoming, "get_template", { id: "wf-1" }) as Request;
  assert.equal(new URL(g.url).pathname, "/functions/v1/catalog-search/v1/templates/wf-1");
  assert.equal(g.method, "GET");
  const c = toolCallToRestRequest(incoming, "list_categories", {}) as Request;
  assert.equal(new URL(c.url).pathname, "/functions/v1/catalog-search/v1/categories");
  assert.equal(c.method, "GET");
  const r = toolCallToRestRequest(incoming, "recommend_automation", { problem_description: "x" }) as Request;
  assert.equal(new URL(r.url).pathname, "/functions/v1/catalog-search/v1/recommend");
  assert.equal(r.method, "POST");
});

test("initialize requires a key and returns tools capability", async () => {
  const { deps } = await harness();
  const denied = await handleMcpJsonRpc(
    new Request("https://x/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }) }),
    deps,
  );
  assert.equal(denied.status, 401);

  const ok = await handleMcpJsonRpc(
    mcpReq({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }),
    deps,
  );
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.result.serverInfo.name, "savante-catalog");
  assert.ok(body.result.capabilities.tools);
  assert.match(body.result.instructions, /Do not invent/);
});

test("tools/list exposes all catalog tools", async () => {
  const { deps } = await harness();
  const res = await handleMcpJsonRpc(mcpReq({ jsonrpc: "2.0", id: 2, method: "tools/list" }), deps);
  const body = await res.json();
  assert.deepEqual(body.result.tools.map((t: { name: string }) => t.name), CATALOG_TOOLS.map((t) => t.name));
  assert.ok(CATALOG_TOOLS.some((t) => t.name === "list_categories"));
  assert.ok(CATALOG_TOOLS.some((t) => t.name === "recommend_automation"));
});

test("tools/call recommend_automation runs retrieval + synthesis via REST", async () => {
  const h = await harness();
  const res = await handleMcpJsonRpc(
    mcpReq({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "recommend_automation", arguments: { problem_description: "We lose CVs from Gmail" } },
    }),
    h.deps,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.result.isError, false);
  const inner = JSON.parse(body.result.content[0].text);
  assert.equal(inner.recommendation.summary, "Automatizá el parseo de CVs.");
  assert.equal("tier" in inner.recommendation, false);
});

test("tools/call search_automations uses REST retrieval (RPC filters + catalog hits)", async () => {
  const h = await harness();
  const res = await handleMcpJsonRpc(
    mcpReq({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "search_automations",
        arguments: { pain: "CVs on Gmail", tools: ["Gmail"], channels: ["email"] },
      },
    }),
    h.deps,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.result.isError, false);
  const inner = JSON.parse(body.result.content[0].text);
  assert.equal(inner.results[0].name, "Gmail CV parser");
  assert.equal(h.logs.some((l) => l.tool === "search_automations" && l.status === 200), true);
  assert.equal(h.lastRpc.current?.filter_integrations?.[0], "Gmail");
  assert.equal(h.lastRpc.current?.filter_trigger?.[0], "email");
  assert.equal(h.lastRpc.current?.filter_source, null);
});

test("tools/call get_template 404 is a tool error, not HTTP 404", async () => {
  const { deps } = await harness();
  const res = await handleMcpJsonRpc(
    mcpReq({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_template", arguments: { id: "missing" } } }),
    deps,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.result.isError, true);
});

test("GET /mcp is 405 (no SSE); DELETE is 204", async () => {
  const { deps } = await harness();
  const get = await handleMcpJsonRpc(
    new Request("https://x.supabase.co/functions/v1/catalog-search/mcp", {
      method: "GET",
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    deps,
  );
  assert.equal(get.status, 405);
  const del = await handleMcpJsonRpc(
    new Request("https://x.supabase.co/functions/v1/catalog-search/mcp", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    deps,
  );
  assert.equal(del.status, 204);
});

test("handleCatalogHttp still serves REST and MCP from one function", async () => {
  const { deps } = await harness();
  const rest = await handleCatalogHttp(
    new Request("https://x.supabase.co/functions/v1/catalog-search/v1/search/software", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ pain: "CRM" }),
    }),
    deps,
  );
  assert.equal(rest.status, 200);
  const mcp = await handleCatalogHttp(mcpReq({ jsonrpc: "2.0", id: 9, method: "ping" }), deps);
  assert.equal(mcp.status, 200);
});

test("unknown JSON-RPC method is -32601", async () => {
  const { deps } = await harness();
  const res = await handleMcpJsonRpc(mcpReq({ jsonrpc: "2.0", id: 8, method: "resources/list" }), deps);
  const body = await res.json();
  assert.equal(body.error.code, -32601);
});

test("notifications return 202", async () => {
  const { deps } = await harness();
  const res = await handleMcpJsonRpc(mcpReq({ jsonrpc: "2.0", method: "notifications/initialized" }), deps);
  assert.equal(res.status, 202);
});

test("REST handleMcpRequest is unchanged for missing key", async () => {
  const { deps } = await harness();
  const res = await handleMcpRequest(
    new Request("https://x/v1/search/automations", { method: "POST", body: "{}" }),
    deps,
  );
  assert.equal(res.status, 401);
});
