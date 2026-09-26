/**
 * MCP catalog HTTP API — auth, quotas, facet mapping, public hit shape.
 * Shared by the catalog-search edge function and Node tests. No Deno-only APIs.
 * See docs/MCP_CATALOG.md.
 */

export const DESC_MAX = 280;
export const SEARCH_LIMIT_DEFAULT = 8;
export const SEARCH_LIMIT_MAX = 12;
export const SOFTWARE_LIMIT_DEFAULT = 6;
export const SOFTWARE_LIMIT_MAX = 6;
export const KEY_PREFIX_LEN = 16;
export const RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const RATE_LIMITS = {
  free: { search: 30, lookup: 60, recommend: 10 },
  paid: { search: 300, lookup: 600, recommend: 100 },
} as const;

export type McpTool =
  | "search_automations"
  | "search_software"
  | "get_template"
  | "list_categories"
  | "recommend_automation";
export type McpPlan = "free" | "paid";

export interface CatalogHit {
  id: string;
  name: string;
  category: string | null;
  integrations: string[];
  trigger_type: string[];
  has_ai: boolean;
  is_rag: boolean;
  description: string;
  import_ref: string | null;
  similarity?: number | null;
}

export interface MatchTemplatesArgs {
  query_embedding: number[];
  match_count: number;
  filter_category: string | null;
  filter_integrations: string[] | null;
  filter_trigger: string[] | null;
  filter_is_rag: boolean | null;
  filter_source: string | null;
  exclude_unmaintained: boolean;
  /** Extra params of match_templates_faceted beyond the original 8 (see migration 008).
   *  Optional here since most callers don't need them; always pass explicit `null` to the
   *  RPC itself. */
  filter_uses_ai?: boolean | null;
  filter_primary_channels?: string[] | null;
  filter_use_case?: string | null;
}

export interface ApiKeyRecord {
  id: string;
  user_id: string;
  plan: McpPlan;
  revoked_at: string | null;
}

export interface UsageSnapshot {
  count: number;
  oldestAt: Date | null;
}

export interface LogEntry {
  api_key_id: string | null;
  user_id: string | null;
  tool: string;
  status: number;
  latency_ms: number;
  result_count: number | null;
  filters: Record<string, unknown>;
}

export interface RpcHit {
  id?: string;
  name?: string;
  category?: string | null;
  integrations?: string[] | null;
  trigger_type?: string[] | null;
  has_ai?: boolean | null;
  is_rag?: boolean | null;
  description?: string | null;
  import_ref?: string | null;
  similarity?: number | null;
}

export interface CategoryRow {
  category: string;
  count: number;
}

export interface RecommendationResult {
  summary: string;
  roi_note?: string | null;
  watch_outs?: string[];
  recommended_workflows: { import_ref: string | null; name: string; why: string }[];
  recommended_software: { id: string; name: string; why: string }[];
  matched_template_ids: string[];
}

export interface McpDeps {
  now(): Date;
  embed(text: string): Promise<number[]>;
  matchTemplates(args: MatchTemplatesArgs): Promise<RpcHit[]>;
  getTemplate(id: string): Promise<RpcHit | null>;
  listCategories(): Promise<CategoryRow[]>;
  recommend(
    input: RecommendAutomationInput,
    workflows: RpcHit[],
    software: RpcHit[],
  ): Promise<RecommendationResult>;
  lookupKey(keyHash: string): Promise<ApiKeyRecord | null>;
  countUsage(apiKeyId: string, tools: McpTool[]): Promise<UsageSnapshot>;
  log(entry: LogEntry): Promise<void>;
  touchKey(apiKeyId: string, at: Date): Promise<void>;
}

export function generateApiKey(kind: "live" | "test" = "live"): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sav_${kind}_${hex}`;
}

export function keyPrefix(secret: string): string {
  return secret.slice(0, KEY_PREFIX_LEN);
}

export async function hashApiKey(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function extractApiKey(req: Request): string | null {
  const x = req.headers.get("x-api-key")?.trim();
  if (x) return x;
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(\S+)/i);
  return m ? m[1] : null;
}

export function truncateDescription(text: string | null | undefined, max = DESC_MAX): string {
  const s = (text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

export function toPublicHit(row: RpcHit): CatalogHit {
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    category: row.category ?? null,
    integrations: row.integrations ?? [],
    trigger_type: row.trigger_type ?? [],
    has_ai: Boolean(row.has_ai),
    is_rag: Boolean(row.is_rag),
    description: truncateDescription(row.description),
    import_ref: row.import_ref ?? null,
    similarity: typeof row.similarity === "number" ? row.similarity : null,
  };
}

function clampInt(n: unknown, fallback: number, max: number): number {
  const v = typeof n === "number" ? n : typeof n === "string" ? Number(n) : fallback;
  if (!Number.isFinite(v) || v < 1) return fallback;
  return Math.min(Math.floor(v), max);
}

function strArray(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out = v.map((x) => String(x).trim()).filter(Boolean);
  return out.length ? out : null;
}

export function wantsAiToRagFilter(wants_ai: unknown): boolean | null {
  const v = typeof wants_ai === "string" ? wants_ai.toLowerCase().trim() : "";
  if (v === "rag") return true;
  // "ia" / "none" / omitted: skip filter_is_rag (RPC has no has_ai filter)
  return null;
}

/** Only an explicit "no AI" hard-excludes AI-dependent templates; "ia"/"rag"/omitted don't
 *  force it on (mirrors recommend/index.ts: `wants_ai === "ninguna" ? false : null`). */
export function wantsAiToUsesAiFilter(wants_ai: unknown): boolean | null {
  const v = typeof wants_ai === "string" ? wants_ai.toLowerCase().trim() : "";
  if (v === "ninguna") return false;
  return null;
}

export interface SearchAutomationsInput {
  pain: string;
  tools: string[] | null;
  channels: string[] | null;
  wants_ai: string | null;
  limit: number;
}

export function parseSearchAutomations(body: unknown): SearchAutomationsInput {
  if (!body || typeof body !== "object") throw new Error("JSON object required");
  const b = body as Record<string, unknown>;
  const pain = typeof b.pain === "string" ? b.pain.trim() : "";
  if (!pain) throw new Error("pain is required");
  return {
    pain,
    tools: strArray(b.tools),
    channels: strArray(b.channels),
    wants_ai: typeof b.wants_ai === "string" ? b.wants_ai : null,
    limit: clampInt(b.limit, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX),
  };
}

/** RPC args without embedding — same names as match_templates_faceted (004). */
export function automationsRpcArgs(input: SearchAutomationsInput): Omit<MatchTemplatesArgs, "query_embedding"> {
  return {
    match_count: input.limit,
    filter_category: null,
    filter_integrations: input.tools,
    filter_trigger: input.channels,
    filter_is_rag: wantsAiToRagFilter(input.wants_ai),
    filter_source: null, // n8n-oriented; do not pin self-hosted
    exclude_unmaintained: true,
    filter_uses_ai: wantsAiToUsesAiFilter(input.wants_ai),
  };
}

export interface SearchSoftwareInput {
  pain: string;
  category: string | null;
  limit: number;
}

export function parseSearchSoftware(body: unknown): SearchSoftwareInput {
  if (!body || typeof body !== "object") throw new Error("JSON object required");
  const b = body as Record<string, unknown>;
  const pain = typeof b.pain === "string" ? b.pain.trim() : "";
  if (!pain) throw new Error("pain is required");
  const category = typeof b.category === "string" && b.category.trim() ? b.category.trim() : null;
  return {
    pain,
    category,
    limit: clampInt(b.limit, SOFTWARE_LIMIT_DEFAULT, SOFTWARE_LIMIT_MAX),
  };
}

export function softwareRpcArgs(input: SearchSoftwareInput): Omit<MatchTemplatesArgs, "query_embedding"> {
  return {
    match_count: input.limit,
    filter_category: input.category,
    filter_integrations: null,
    filter_trigger: null,
    filter_is_rag: null,
    filter_source: "self-hosted",
    exclude_unmaintained: true,
  };
}

export const RECOMMEND_WORKFLOWS_LIMIT = 12;
export const RECOMMEND_SOFTWARE_LIMIT = 6;

export interface RecommendAutomationInput {
  problem_description: string;
}

export function parseRecommendAutomation(body: unknown): RecommendAutomationInput {
  if (!body || typeof body !== "object") throw new Error("JSON object required");
  const b = body as Record<string, unknown>;
  const problem_description = typeof b.problem_description === "string" ? b.problem_description.trim() : "";
  if (!problem_description) throw new Error("problem_description is required");
  return { problem_description };
}

/** RPC args for the two recommend_automation lookups — same shape recommend/index.ts already uses. */
export function recommendWorkflowsRpcArgs(): Omit<MatchTemplatesArgs, "query_embedding"> {
  return {
    match_count: RECOMMEND_WORKFLOWS_LIMIT,
    filter_category: null,
    filter_integrations: null,
    filter_trigger: null,
    filter_is_rag: null,
    filter_source: null,
    exclude_unmaintained: true,
  };
}

export function recommendSoftwareRpcArgs(): Omit<MatchTemplatesArgs, "query_embedding"> {
  return {
    match_count: RECOMMEND_SOFTWARE_LIMIT,
    filter_category: null,
    filter_integrations: null,
    filter_trigger: null,
    filter_is_rag: null,
    filter_source: "self-hosted",
    exclude_unmaintained: true,
  };
}

export function facetLog(
  tool: McpTool,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return { ...extra };
}

export type Routed =
  | { tool: "search_automations" }
  | { tool: "search_software" }
  | { tool: "get_template"; id: string }
  | { tool: "list_categories" }
  | { tool: "recommend_automation" };

export function routePath(pathname: string): Routed | null {
  const p = pathname.replace(/\/+$/, "");
  if (p.endsWith("/v1/search/automations")) return { tool: "search_automations" };
  if (p.endsWith("/v1/search/software")) return { tool: "search_software" };
  if (p.endsWith("/v1/categories")) return { tool: "list_categories" };
  if (p.endsWith("/v1/recommend")) return { tool: "recommend_automation" };
  const m = p.match(/\/v1\/templates\/([^/]+)$/);
  if (m) return { tool: "get_template", id: decodeURIComponent(m[1]) };
  return null;
}

export function quotaFor(plan: McpPlan, tool: McpTool): { limit: number; tools: McpTool[] } {
  const q = RATE_LIMITS[plan] ?? RATE_LIMITS.free;
  if (tool === "get_template" || tool === "list_categories") {
    return { limit: q.lookup, tools: ["get_template", "list_categories"] };
  }
  if (tool === "recommend_automation") {
    return { limit: q.recommend, tools: ["recommend_automation"] };
  }
  return { limit: q.search, tools: ["search_automations", "search_software"] };
}

export function retryAfterSec(now: Date, oldestAt: Date | null): number {
  if (!oldestAt) return Math.ceil(RATE_WINDOW_MS / 1000);
  const retryAt = oldestAt.getTime() + RATE_WINDOW_MS;
  return Math.max(1, Math.ceil((retryAt - now.getTime()) / 1000));
}

function json(body: unknown, status: number, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text) return {};
  return JSON.parse(text);
}

export async function handleMcpRequest(req: Request, deps: McpDeps): Promise<Response> {
  const started = deps.now();
  const latency = () => Math.max(0, deps.now().getTime() - started.getTime());

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  const url = new URL(req.url);
  const routed = routePath(url.pathname);

  const writeLog = async (
    tool: string,
    status: number,
    key: ApiKeyRecord | null,
    result_count: number | null,
    filters: Record<string, unknown>,
  ) => {
    await deps.log({
      api_key_id: key?.id ?? null,
      user_id: key?.user_id ?? null,
      tool,
      status,
      latency_ms: latency(),
      result_count,
      filters,
    });
  };

  if (!routed) {
    await writeLog("unknown", 404, null, null, { path: url.pathname });
    return json({ error: "not_found" }, 404);
  }

  const isGetTool = routed.tool === "get_template" || routed.tool === "list_categories";
  const methodOk = isGetTool ? req.method === "GET" : req.method === "POST";
  if (!methodOk) {
    await writeLog(routed.tool, 405, null, null, { method: req.method });
    return json({ error: "method_not_allowed" }, 405);
  }

  const secret = extractApiKey(req);
  if (!secret) {
    await writeLog(routed.tool, 401, null, null, {});
    return json({ error: "unauthorized" }, 401);
  }

  const key = await deps.lookupKey(await hashApiKey(secret));
  if (!key) {
    await writeLog(routed.tool, 401, null, null, { key_prefix: keyPrefix(secret) });
    return json({ error: "unauthorized" }, 401);
  }
  if (key.revoked_at) {
    await writeLog(routed.tool, 403, key, null, {});
    return json({ error: "revoked" }, 403);
  }

  const quota = quotaFor(key.plan, routed.tool);
  const usage = await deps.countUsage(key.id, quota.tools);
  if (usage.count >= quota.limit) {
    const retry = retryAfterSec(deps.now(), usage.oldestAt);
    await writeLog(routed.tool, 429, key, null, { quota: quota.limit, used: usage.count });
    return json({ error: "rate_limited" }, 429, { "Retry-After": String(retry) });
  }

  try {
    if (routed.tool === "get_template") {
      const row = await deps.getTemplate(routed.id);
      if (!row) {
        await writeLog("get_template", 404, key, 0, { id: routed.id });
        return json({ error: "not_found" }, 404);
      }
      const hit = toPublicHit(row);
      await deps.touchKey(key.id, deps.now());
      await writeLog("get_template", 200, key, 1, { id: routed.id });
      return json({ template: hit }, 200);
    }

    if (routed.tool === "list_categories") {
      const categories = await deps.listCategories();
      await deps.touchKey(key.id, deps.now());
      await writeLog("list_categories", 200, key, categories.length, {});
      return json({ categories }, 200);
    }

    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      await writeLog(routed.tool, 400, key, null, { reason: "invalid_json" });
      return json({ error: "invalid_request", detail: "invalid JSON" }, 400);
    }

    if (routed.tool === "search_automations") {
      let input: SearchAutomationsInput;
      try {
        input = parseSearchAutomations(body);
      } catch (e) {
        await writeLog(routed.tool, 400, key, null, { reason: String(e) });
        return json({ error: "invalid_request", detail: String(e instanceof Error ? e.message : e) }, 400);
      }
      const embedding = await deps.embed(input.pain);
      const rpc = automationsRpcArgs(input);
      const rows = await deps.matchTemplates({ ...rpc, query_embedding: embedding });
      const results = rows.map(toPublicHit);
      await deps.touchKey(key.id, deps.now());
      await writeLog(routed.tool, 200, key, results.length, facetLog(routed.tool, {
        tools: input.tools,
        channels: input.channels,
        wants_ai: input.wants_ai,
        limit: input.limit,
        pain_len: input.pain.length,
      }));
      return json({ results }, 200);
    }

    if (routed.tool === "recommend_automation") {
      let input: RecommendAutomationInput;
      try {
        input = parseRecommendAutomation(body);
      } catch (e) {
        await writeLog(routed.tool, 400, key, null, { reason: String(e) });
        return json({ error: "invalid_request", detail: String(e instanceof Error ? e.message : e) }, 400);
      }
      const embedding = await deps.embed(input.problem_description);
      const [workflows, software] = await Promise.all([
        deps.matchTemplates({ ...recommendWorkflowsRpcArgs(), query_embedding: embedding }),
        deps.matchTemplates({ ...recommendSoftwareRpcArgs(), query_embedding: embedding }),
      ]);
      const recommendation = await deps.recommend(input, workflows, software);
      await deps.touchKey(key.id, deps.now());
      await writeLog(routed.tool, 200, key, recommendation.matched_template_ids.length, facetLog(routed.tool, {
        problem_len: input.problem_description.length,
        workflows_considered: workflows.length,
        software_considered: software.length,
      }));
      return json({ recommendation }, 200);
    }

    let input: SearchSoftwareInput;
    try {
      input = parseSearchSoftware(body);
    } catch (e) {
      await writeLog(routed.tool, 400, key, null, { reason: String(e) });
      return json({ error: "invalid_request", detail: String(e instanceof Error ? e.message : e) }, 400);
    }
    const embedding = await deps.embed(input.pain);
    const rpc = softwareRpcArgs(input);
    const rows = await deps.matchTemplates({ ...rpc, query_embedding: embedding });
    const results = rows.map(toPublicHit);
    await deps.touchKey(key.id, deps.now());
    await writeLog(routed.tool, 200, key, results.length, facetLog(routed.tool, {
      category: input.category,
      limit: input.limit,
      pain_len: input.pain.length,
    }));
    return json({ results }, 200);
  } catch (e) {
    await writeLog(routed.tool, 500, key, null, { reason: "internal" });
    return json({ error: "internal", detail: String(e instanceof Error ? e.message : e) }, 500);
  }
}
