/**
 * Supabase Edge Function: authenticated catalog search (MCP / GPT Actions HTTP API).
 *
 * REST:
 *   POST /functions/v1/catalog-search/v1/search/automations
 *   POST /functions/v1/catalog-search/v1/search/software
 *   GET  /functions/v1/catalog-search/v1/templates/:id
 *   GET  /functions/v1/catalog-search/v1/categories
 *   POST /functions/v1/catalog-search/v1/recommend
 * MCP Streamable HTTP (JSON-RPC):
 *   POST /functions/v1/catalog-search/mcp  (also the function root)
 *
 * Auth: Authorization: Bearer sav_live_…  (or X-Api-Key)
 * Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (server only — never in mcp.json),
 *   OPENROUTER_API_KEY (used only by recommend_automation's synthesis step)
 *
 * Does not write leads/recommendations, even from recommend_automation (discovery only,
 * no priced funnel — see docs/MCP_CATALOG.md §3 non-goals). Does not return templates.content.
 */
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  type ApiKeyRecord,
  type CategoryRow,
  type LogEntry,
  type MatchTemplatesArgs,
  type McpDeps,
  type McpPlan,
  type McpTool,
  type RecommendAutomationInput,
  type RecommendationResult,
  type RpcHit,
  type UsageSnapshot,
} from "../_shared/mcp-catalog.ts";
import { handleCatalogHttp } from "../_shared/mcp-rpc.ts";
import { synthesizeRecommendation, type CandidateRow } from "../_shared/recommend-synthesis.ts";

function supabaseAdmin(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function makeDeps(sb: SupabaseClient): McpDeps {
  return {
    now: () => new Date(),

    async embed(text: string): Promise<number[]> {
      // deno-lint-ignore no-explicit-any
      const session = new (globalThis as any).Supabase.ai.Session("gte-small");
      const vec = await session.run(text, { mean_pool: true, normalize: true });
      return Array.from(vec as number[]);
    },

    async matchTemplates(args: MatchTemplatesArgs): Promise<RpcHit[]> {
      const { data, error } = await sb.rpc("match_templates_faceted", {
        query_embedding: args.query_embedding,
        match_count: args.match_count,
        filter_category: args.filter_category,
        filter_integrations: args.filter_integrations,
        filter_trigger: args.filter_trigger,
        filter_is_rag: args.filter_is_rag,
        filter_source: args.filter_source,
        exclude_unmaintained: args.exclude_unmaintained,
        filter_uses_ai: args.filter_uses_ai ?? null,
        filter_primary_channels: args.filter_primary_channels ?? null,
        filter_use_case: args.filter_use_case ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as RpcHit[];
    },

    async getTemplate(id: string): Promise<RpcHit | null> {
      const { data, error } = await sb
        .from("templates_public")
        .select(
          "id, name, category, integrations, trigger_type, has_ai, is_rag, description, import_ref",
        )
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as RpcHit | null) ?? null;
    },

    async listCategories(): Promise<CategoryRow[]> {
      const { data, error } = await sb.rpc("list_template_categories");
      if (error) throw new Error(error.message);
      return (data ?? []) as CategoryRow[];
    },

    async recommend(
      input: RecommendAutomationInput,
      workflows: RpcHit[],
      software: RpcHit[],
    ): Promise<RecommendationResult> {
      const toCandidate = (r: RpcHit): CandidateRow => ({
        id: r.id ?? null,
        name: r.name,
        import_ref: r.import_ref ?? null,
        category: r.category ?? null,
      });
      const synthesized = await synthesizeRecommendation(
        { pain_primary: input.problem_description },
        workflows.map(toCandidate),
        software.map(toCandidate),
        { apiKey: Deno.env.get("OPENROUTER_API_KEY") },
      );
      // Discovery tool only — never expose the priced funnel (tier/price_estimate) over MCP.
      return {
        summary: synthesized.summary,
        roi_note: synthesized.roi_note ?? null,
        watch_outs: synthesized.watch_outs ?? [],
        recommended_workflows: synthesized.recommended_workflows,
        recommended_software: synthesized.recommended_software,
        matched_template_ids: workflows.map((w) => String(w.id ?? "")).filter(Boolean),
      };
    },

    async lookupKey(keyHash: string): Promise<ApiKeyRecord | null> {
      const { data, error } = await sb
        .from("mcp_api_keys")
        .select("id, user_id, revoked_at, mcp_users ( plan )")
        .eq("key_hash", keyHash)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const nested = data.mcp_users as { plan?: string } | { plan?: string }[] | null;
      const planRaw = Array.isArray(nested) ? nested[0]?.plan : nested?.plan;
      const plan: McpPlan = planRaw === "paid" ? "paid" : "free";
      return {
        id: data.id as string,
        user_id: data.user_id as string,
        plan,
        revoked_at: (data.revoked_at as string | null) ?? null,
      };
    },

    async countUsage(apiKeyId: string, tools: McpTool[]): Promise<UsageSnapshot> {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: count, error: cErr } = await sb.rpc("mcp_usage_count", {
        p_api_key_id: apiKeyId,
        p_tools: tools,
        p_since: since,
      });
      if (cErr) throw new Error(cErr.message);
      const { data: oldest, error: oErr } = await sb.rpc("mcp_usage_oldest_at", {
        p_api_key_id: apiKeyId,
        p_tools: tools,
        p_since: since,
      });
      if (oErr) throw new Error(oErr.message);
      return {
        count: typeof count === "number" ? count : 0,
        oldestAt: oldest ? new Date(oldest as string) : null,
      };
    },

    async log(entry: LogEntry): Promise<void> {
      const { error } = await sb.from("mcp_request_log").insert({
        api_key_id: entry.api_key_id,
        user_id: entry.user_id,
        tool: entry.tool,
        status: entry.status,
        latency_ms: entry.latency_ms,
        result_count: entry.result_count,
        filters: entry.filters,
      });
      if (error) console.error("mcp_request_log insert failed", error.message);
    },

    async touchKey(apiKeyId: string, at: Date): Promise<void> {
      await sb.from("mcp_api_keys").update({ last_used_at: at.toISOString() }).eq("id", apiKeyId);
    },
  };
}

Deno.serve(async (req) => {
  try {
    return await handleCatalogHttp(req, makeDeps(supabaseAdmin()));
  } catch (e) {
    return new Response(JSON.stringify({ error: "internal", detail: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
