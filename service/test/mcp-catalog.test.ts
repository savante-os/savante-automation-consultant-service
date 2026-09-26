/**
 * MCP catalog HTTP API tests.
 * Mocks embed + RPC; asserts auth, quotas, and facet → match_templates_faceted mapping.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  automationsRpcArgs,
  DESC_MAX,
  extractApiKey,
  handleMcpRequest,
  hashApiKey,
  keyPrefix,
  parseRecommendAutomation,
  parseSearchAutomations,
  RATE_LIMITS,
  routePath,
  softwareRpcArgs,
  toPublicHit,
  truncateDescription,
  wantsAiToRagFilter,
  type ApiKeyRecord,
  type CategoryRow,
  type LogEntry,
  type MatchTemplatesArgs,
  type McpDeps,
  type McpTool,
  type RecommendationResult,
  type RpcHit,
  type UsageSnapshot,
} from "../supabase/functions/_shared/mcp-catalog.ts";

const SECRET = "sav_live_testsecret00000000000000000000000000000000";
let SECRET_HASH = "";

const KEY: ApiKeyRecord = {
  id: "key-1",
  user_id: "user-1",
  plan: "free",
  revoked_at: null,
};

function hit(id: string): RpcHit {
  return {
    id,
    name: `Workflow ${id}`,
    category: "Gmail",
    integrations: ["Gmail"],
    trigger_type: ["email"],
    has_ai: true,
    is_rag: false,
    description: "x".repeat(400),
    import_ref: `https://n8n.io/workflows/${id}`,
    similarity: 0.81,
  };
}

interface Harness {
  deps: McpDeps;
  logs: LogEntry[];
  lastRpc: MatchTemplatesArgs | null;
  usageCount: number;
  keys: Map<string, ApiKeyRecord>;
  templates: Map<string, RpcHit>;
  categories: CategoryRow[];
}

const RECOMMENDATION: RecommendationResult = {
  summary: "Automatizá el ingreso de CVs desde Gmail.",
  roi_note: null,
  watch_outs: ["Validar formatos de adjuntos."],
  recommended_workflows: [{ import_ref: "https://n8n.io/workflows/wf-1", name: "Workflow wf-1", why: "Cubre el caso." }],
  recommended_software: [],
  matched_template_ids: ["wf-1"],
};

async function harness(over: Partial<Harness> = {}): Promise<Harness> {
  if (!SECRET_HASH) SECRET_HASH = await hashApiKey(SECRET);
  const logs: LogEntry[] = [];
  const h: Harness = {
    logs,
    lastRpc: null,
    usageCount: 0,
    keys: new Map([[SECRET_HASH, { ...KEY }]]),
    templates: new Map([["wf-1", hit("wf-1")]]),
    categories: [{ category: "Gmail", count: 3 }],
    deps: null as unknown as McpDeps,
    ...over,
  };
  h.deps = {
    now: () => new Date("2026-09-14T12:00:00Z"),
    embed: async (text) => {
      assert.ok(text.length > 0);
      return new Array(384).fill(0.01);
    },
    matchTemplates: async (args) => {
      h.lastRpc = args;
      assert.equal(args.query_embedding.length, 384);
      return [hit("wf-1")];
    },
    getTemplate: async (id) => h.templates.get(id) ?? null,
    listCategories: async () => h.categories,
    recommend: async () => RECOMMENDATION,
    lookupKey: async (hash) => h.keys.get(hash) ?? null,
    countUsage: async (): Promise<UsageSnapshot> => ({
      count: h.usageCount,
      oldestAt: h.usageCount > 0 ? new Date("2026-09-13T12:30:00Z") : null,
    }),
    log: async (e) => { h.logs.push(e); },
    touchKey: async () => {},
  };
  return h;
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://example.supabase.co/functions/v1/catalog-search${path}`, init);
}

test("routePath maps all v1 endpoints", () => {
  assert.deepEqual(routePath("/functions/v1/catalog-search/v1/search/automations"), { tool: "search_automations" });
  assert.deepEqual(routePath("/v1/search/software"), { tool: "search_software" });
  assert.deepEqual(routePath("/v1/templates/abc%2Fdef"), { tool: "get_template", id: "abc/def" });
  assert.deepEqual(routePath("/v1/categories"), { tool: "list_categories" });
  assert.deepEqual(routePath("/v1/recommend"), { tool: "recommend_automation" });
  assert.equal(routePath("/v1/unknown"), null);
});

test("extractApiKey accepts Bearer and X-Api-Key", () => {
  assert.equal(extractApiKey(req("/x", { headers: { Authorization: `Bearer ${SECRET}` } })), SECRET);
  assert.equal(extractApiKey(req("/x", { headers: { "X-Api-Key": SECRET } })), SECRET);
  assert.equal(extractApiKey(req("/x")), null);
});

test("key prefix is the first 16 chars (never the full secret)", () => {
  assert.equal(keyPrefix(SECRET), SECRET.slice(0, 16));
  assert.notEqual(keyPrefix(SECRET), SECRET);
});

test("wants_ai rag sets filter_is_rag; ia/none skip", () => {
  assert.equal(wantsAiToRagFilter("rag"), true);
  assert.equal(wantsAiToRagFilter("ia"), null);
  assert.equal(wantsAiToRagFilter("none"), null);
  assert.equal(wantsAiToRagFilter(undefined), null);
});

test("automations RPC: tools/channels map to filter_integrations/filter_trigger; no self-hosted source", () => {
  const parsed = parseSearchAutomations({
    pain: "CVs in Gmail",
    tools: ["Gmail", "Google Sheets"],
    channels: ["email"],
    wants_ai: "ia",
    limit: 99,
  });
  assert.equal(parsed.limit, 12); // capped
  const rpc = automationsRpcArgs(parsed);
  assert.deepEqual(rpc.filter_integrations, ["Gmail", "Google Sheets"]);
  assert.deepEqual(rpc.filter_trigger, ["email"]);
  assert.equal(rpc.filter_is_rag, null);
  assert.equal(rpc.filter_source, null);
  assert.equal(rpc.exclude_unmaintained, true);
});

test("software RPC pins self-hosted and exclude_unmaintained", () => {
  const rpc = softwareRpcArgs({ pain: "replace HubSpot", category: "customer relationship management", limit: 6 });
  assert.equal(rpc.filter_source, "self-hosted");
  assert.equal(rpc.filter_category, "customer relationship management");
  assert.equal(rpc.exclude_unmaintained, true);
  assert.equal(rpc.match_count, 6);
});

test("toPublicHit truncates description and never exposes extra fields", () => {
  const pub = toPublicHit({
    id: "1",
    name: "A",
    description: "y".repeat(500),
    content: "SECRET WORKFLOW JSON",
    import_ref: "https://n8n.io/workflows/1",
  } as RpcHit & { content: string });
  assert.ok(pub.description.length <= DESC_MAX);
  assert.ok(pub.description.endsWith("…"));
  assert.equal("content" in pub, false);
});

test("401 without key and still writes a log row", async () => {
  const h = await harness();
  const res = await handleMcpRequest(
    req("/v1/search/automations", { method: "POST", body: JSON.stringify({ pain: "x" }) }),
    h.deps,
  );
  assert.equal(res.status, 401);
  assert.equal(h.logs.length, 1);
  assert.equal(h.logs[0].status, 401);
  assert.equal(h.logs[0].tool, "search_automations");
  assert.equal(h.logs[0].api_key_id, null);
});

test("401 with unknown key", async () => {
  const h = await harness();
  const res = await handleMcpRequest(
    req("/v1/search/automations", {
      method: "POST",
      headers: { Authorization: "Bearer sav_live_unknown" },
      body: JSON.stringify({ pain: "x" }),
    }),
    h.deps,
  );
  assert.equal(res.status, 401);
});

test("403 revoked key", async () => {
  const h = await harness();
  h.keys.set(SECRET_HASH, { ...KEY, revoked_at: "2026-01-01T00:00:00Z" });
  const res = await handleMcpRequest(
    req("/v1/search/automations", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ pain: "x" }),
    }),
    h.deps,
  );
  assert.equal(res.status, 403);
  assert.equal(h.logs.at(-1)?.status, 403);
});

test("200 with key returns truncated catalog hits", async () => {
  const h = await harness();
  const res = await handleMcpRequest(
    req("/v1/search/automations", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({
        pain: "We get CVs on Gmail",
        tools: ["Gmail"],
        channels: ["email"],
        wants_ai: "rag",
        limit: 8,
      }),
    }),
    h.deps,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].id, "wf-1");
  assert.ok(body.results[0].description.length <= DESC_MAX);
  assert.equal(h.lastRpc?.filter_integrations?.[0], "Gmail");
  assert.equal(h.lastRpc?.filter_trigger?.[0], "email");
  assert.equal(h.lastRpc?.filter_is_rag, true);
  assert.equal(h.lastRpc?.filter_source, null);
  assert.equal(h.logs.at(-1)?.status, 200);
  assert.equal(h.logs.at(-1)?.result_count, 1);
  assert.equal(h.logs.at(-1)?.filters.pain, undefined);
});

test("429 after free search cap, logs 429, sets Retry-After", async () => {
  const h = await harness();
  h.usageCount = RATE_LIMITS.free.search;
  const res = await handleMcpRequest(
    req("/v1/search/software", {
      method: "POST",
      headers: { "X-Api-Key": SECRET },
      body: JSON.stringify({ pain: "CRM" }),
    }),
    h.deps,
  );
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get("Retry-After")) > 0);
  assert.equal(h.logs.at(-1)?.status, 429);
  assert.equal(h.lastRpc, null);
});

test("get_template 200 / 404", async () => {
  const h = await harness();
  const ok = await handleMcpRequest(
    req("/v1/templates/wf-1", { headers: { Authorization: `Bearer ${SECRET}` } }),
    h.deps,
  );
  assert.equal(ok.status, 200);
  const missing = await handleMcpRequest(
    req("/v1/templates/nope", { headers: { Authorization: `Bearer ${SECRET}` } }),
    h.deps,
  );
  assert.equal(missing.status, 404);
});

test("software search sets filter_source on the RPC", async () => {
  const h = await harness();
  const res = await handleMcpRequest(
    req("/v1/search/software", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ pain: "ticketing", category: "ticketing" }),
    }),
    h.deps,
  );
  assert.equal(res.status, 200);
  assert.equal(h.lastRpc?.filter_source, "self-hosted");
  assert.equal(h.lastRpc?.filter_category, "ticketing");
  assert.equal(h.lastRpc?.exclude_unmaintained, true);
});

test("truncateDescription is a no-op under the cap", () => {
  assert.equal(truncateDescription("short"), "short");
});

test("parseRecommendAutomation requires problem_description", () => {
  assert.throws(() => parseRecommendAutomation({}));
  assert.throws(() => parseRecommendAutomation({ problem_description: "  " }));
  const parsed = parseRecommendAutomation({ problem_description: " lose candidates in Gmail " });
  assert.equal(parsed.problem_description, "lose candidates in Gmail");
});

test("list_categories 200 returns categories and does not touch matchTemplates", async () => {
  const h = await harness();
  const res = await handleMcpRequest(
    req("/v1/categories", { headers: { Authorization: `Bearer ${SECRET}` } }),
    h.deps,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.categories, [{ category: "Gmail", count: 3 }]);
  assert.equal(h.lastRpc, null);
  assert.equal(h.logs.at(-1)?.tool, "list_categories");
  assert.equal(h.logs.at(-1)?.status, 200);
});

test("list_categories shares the lookup quota with get_template", async () => {
  const h = await harness();
  h.usageCount = RATE_LIMITS.free.lookup;
  const res = await handleMcpRequest(
    req("/v1/categories", { headers: { Authorization: `Bearer ${SECRET}` } }),
    h.deps,
  );
  assert.equal(res.status, 429);
});

test("recommend_automation 200 runs two matchTemplates calls and omits pricing", async () => {
  const h = await harness();
  const seen: MatchTemplatesArgs[] = [];
  h.deps.matchTemplates = async (args) => {
    seen.push(args);
    return [hit("wf-1")];
  };
  const res = await handleMcpRequest(
    req("/v1/recommend", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ problem_description: "We lose CVs sent over Gmail" }),
    }),
    h.deps,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.recommendation.summary, RECOMMENDATION.summary);
  assert.equal("tier" in body.recommendation, false);
  assert.equal("price_estimate" in body.recommendation, false);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].filter_source, "self-hosted");
  assert.equal(h.logs.at(-1)?.tool, "recommend_automation");
  assert.equal(h.logs.at(-1)?.status, 200);
});

test("recommend_automation requires problem_description (400, no synthesis call)", async () => {
  const h = await harness();
  const res = await handleMcpRequest(
    req("/v1/recommend", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({}),
    }),
    h.deps,
  );
  assert.equal(res.status, 400);
  assert.equal(h.lastRpc, null);
});

test("recommend_automation has its own quota bucket, separate from search", async () => {
  const h = await harness();
  // Exhaust only the search bucket; recommend_automation's own bucket stays fresh.
  h.deps.countUsage = async (_apiKeyId, tools): Promise<UsageSnapshot> => ({
    count: tools.includes("search_automations") ? RATE_LIMITS.free.search : 0,
    oldestAt: null,
  });
  const res = await handleMcpRequest(
    req("/v1/recommend", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ problem_description: "x" }),
    }),
    h.deps,
  );
  assert.equal(res.status, 200);
});
