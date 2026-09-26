/**
 * DeepSeek/OpenRouter synthesis step. Single source of truth for recommend/,
 * catalog-search/ (recommend_automation MCP tool) and the local pipeline
 * (service/src/recommend.ts, a re-export of this module): one prompt, one pricing
 * grid, one grounding check.
 */
import { buildQueryText, type Intake } from "./retrieval.ts";

export interface CandidateRow {
  id?: string | null;
  name?: string;
  import_ref?: string | null;
  category?: string | null;
  description?: string | null;
  integrations?: string[] | null;
  trigger_type?: string[] | null;
  has_ai?: boolean | null;
  is_rag?: boolean | null;
  primary_channels?: string[] | null;
  use_case?: string | null;
  similarity?: number | null;
}

export interface RecommendProfile {
  company?: string;
  niche?: string;
  pain_primary: string;
  pain_secondary?: string;
  current_tools?: string[];
  input_channels?: string[];
  output_targets?: string[];
  wants_ai?: string;
  hosting_pref?: string;
  budget_band?: string;
  urgency?: string;
  team_size?: string;
  pain_volume?: string;
  pain_time_each?: string;
  pain_cost?: string;
  pain_volume_count?: string | number;
  pain_volume_period?: string;
  pain_time_amount?: string | number;
  pain_time_unit?: string;
}

/** Extra retrieval context (channel/use-case, tools being replaced) that shapes the prompt
 *  and the post-synthesis normalization, but isn't part of the business "profile" itself. */
export interface SynthesizeContext {
  painChannels?: string[];
  useCase?: string;
  toolsToReplace?: string[];
  softwareCandidates?: CandidateRow[];
}

export interface SynthesizedRecommendation {
  summary: string;
  roi_note?: string | null;
  watch_outs?: string[];
  recommended_software: { id: string; name: string; why: string }[];
  recommended_workflows: { import_ref: string | null; name: string; why: string }[];
  suggested_stack: string;
  complexity: string;
  implementation_days: number;
  price_estimate: { setup_usd: [number, number]; care_plan_usd_mo: [number, number] };
  tier: string;
}

// Single source of truth for pricing.
export const PRICING: Record<string, { setup_usd: [number, number]; blurb: string }> = {
  "Audit": { setup_usd: [150, 300], blurb: "solo diagnóstico" },
  "Single Automation": { setup_usd: [800, 1500], blurb: "1 workflow" },
  "System": { setup_usd: [2000, 4000], blurb: "3-5 workflows" },
};
export const CARE_PLAN_USD_MO: [number, number] = [150, 400];
const PRICING_GRID =
  Object.entries(PRICING)
    .map(([tier, p]) => `${tier} ${p.setup_usd[0]}-${p.setup_usd[1]} (${p.blurb})`)
    .join(", ") + `, Care Plan ${CARE_PLAN_USD_MO[0]}-${CARE_PLAN_USD_MO[1]}/mes.`;

// Commercial coherence rules applied after synthesis (see normalizeRecommendation).
const COMPLEXITY_ES: Record<string, string> = {
  low: "Baja", medium: "Media", high: "Alta", baja: "Baja", media: "Media", alta: "Alta",
};
const TIER_DAYS: Record<string, [number, number]> = {
  "Audit": [1, 3], "Single Automation": [3, 10], "System": [10, 30],
};
const SYSTEM_SOFTWARE_CATEGORY_PATTERNS = [
  /customer relationship management/i, /health and fitness/i, /enterprise resource planning/i,
  /money, budgeting/i, /inventory management/i, /ehr|emr|practice management/i,
];

function norm(s: unknown): string { return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim(); }

function parseBudgetBand(band?: string): [number, number] | null {
  if (!band) return null;
  const m = band.match(/(\d+)\s*[-–]\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
function budgetOverlapsTier(budget: [number, number], tier: string): boolean {
  const grid = PRICING[tier]?.setup_usd;
  return grid ? budget[0] <= grid[1] && budget[1] >= grid[0] : false;
}
function budgetSupportsSystem(budget: [number, number] | null): boolean {
  if (!budget) return false;
  return budget[0] >= PRICING["System"].setup_usd[0] || budget[1] >= PRICING["System"].setup_usd[0];
}
function resolveSoftwareCategories(recSoftware: SynthesizedRecommendation["recommended_software"], softwareRows: CandidateRow[]): string[] {
  const byId = new Map(softwareRows.map((s) => [String(s.id), s]));
  const byName = new Map(softwareRows.map((s) => [norm(s.name), s]));
  const categories: string[] = [];
  for (const s of recSoftware ?? []) {
    const row = byId.get(String(s.id)) ?? byName.get(norm(s.name));
    if (row?.category) categories.push(row.category);
  }
  return categories;
}
function isSystemReplacementScope(categories: string[]): boolean {
  return categories.some((c) => SYSTEM_SOFTWARE_CATEGORY_PATTERNS.some((p) => p.test(c)));
}
/** True when the pain looks like a single repetitive bottleneck rather than a system migration —
 *  guards against the LLM over-scoping a "reply to DMs" ask into a multi-workflow System tier. */
function isSingleLoopPain(profile: RecommendProfile): boolean {
  return !/\b(reemplaz|migrar|crm|erp|sistema completo|varios procesos|3\+)\b/i.test(profile.pain_primary ?? "");
}

/** Deterministic ROI (never trust the LLM's arithmetic) — see buildMessages rule 6, which tells
 *  the LLM to always return roi_note=null; this is the one place the number gets computed. */
export function computeRoiNote(i: RecommendProfile): string | null {
  const count = Number(i.pain_volume_count);
  const amount = Number(i.pain_time_amount);
  if (!count || !amount || count <= 0 || amount <= 0) return null;
  const perMonth: Record<string, number> = { day: 21.7, week: 4.33, month: 1 };
  const factor = perMonth[i.pain_volume_period ?? "month"] ?? 1;
  const minutesEach = i.pain_time_unit === "hour" ? amount * 60 : amount;
  const hours = (count * factor * minutesEach) / 60;
  const rounded = hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10;
  const periodWord = i.pain_volume_period === "day" ? "día" : i.pain_volume_period === "week" ? "semana" : "mes";
  const unitWord = i.pain_time_unit === "hour" ? "h" : "min";
  return `Con ~${count} veces por ${periodWord} a ${amount} ${unitWord} cada una, son ~${rounded} horas/mes que tu equipo podría recuperar (estimación).`;
}

export interface NormalizeContext {
  /** false forces tier='Audit' regardless of what the LLM picked — the only honest tier when
   *  there were literally 0 candidates to recommend from. Defaults to true. */
  hadCandidates?: boolean;
  profile?: RecommendProfile;
  softwareCandidates?: CandidateRow[];
}

/** Snap price to the declared tier's grid, plus (when `ctx.profile` is given) the full set of
 *  tier/day/complexity/budget coherence rules: system-replacement scope forces System, Alta complexity promotes Single->System, a
 *  single-loop pain caps/downgrades an over-scoped System, days get clamped to the tier's
 *  range, and price anchors to `budget_band` when it overlaps the tier's grid. */
export function normalizeRecommendation(rec: SynthesizedRecommendation, ctx: NormalizeContext = {}): SynthesizedRecommendation {
  const out: SynthesizedRecommendation = { ...rec };
  const hadCandidates = ctx.hadCandidates ?? true;
  if (!hadCandidates && out.tier !== "Audit") out.tier = "Audit";

  const rawComplexity = String(out.complexity ?? "").toLowerCase().trim();
  out.complexity = COMPLEXITY_ES[rawComplexity] ?? out.complexity;

  const profile = ctx.profile;
  if (profile) {
    const swCategories = resolveSoftwareCategories(out.recommended_software ?? [], ctx.softwareCandidates ?? []);
    const budget = parseBudgetBand(profile.budget_band);
    const hasReplacementSoftware = (out.recommended_software?.length ?? 0) >= 1 && isSystemReplacementScope(swCategories);

    if (hasReplacementSoftware && profile.hosting_pref === "self-hosted" && budgetSupportsSystem(budget)) {
      out.tier = "System";
    }
    if (out.complexity === "Alta" && out.tier === "Single Automation") {
      out.tier = "System";
    }
    if (isSingleLoopPain(profile)) {
      const wfCount = out.recommended_workflows?.length ?? 0;
      if (wfCount > 2) out.recommended_workflows = out.recommended_workflows.slice(0, 2);
      const systemReplacement = hasReplacementSoftware && isSystemReplacementScope(swCategories);
      if (out.tier === "System" && !systemReplacement && wfCount <= 2) out.tier = "Single Automation";
    }
    const dayRange = TIER_DAYS[out.tier ?? "Single Automation"];
    if (dayRange && out.implementation_days != null) {
      const days = Number(out.implementation_days);
      if (!Number.isNaN(days)) out.implementation_days = Math.max(dayRange[0], Math.min(dayRange[1], days));
    }
  }

  const grid = PRICING[out.tier];
  if (!grid) return out;
  let [lo, hi] = grid.setup_usd;
  const budget = profile ? parseBudgetBand(profile.budget_band) : null;
  if (budget && budgetOverlapsTier(budget, out.tier)) {
    lo = Math.max(lo, budget[0]);
    hi = Math.min(hi, budget[1]);
    if (lo > hi) { lo = Math.max(grid.setup_usd[0], budget[0]); hi = Math.min(grid.setup_usd[1], budget[1]); }
  }
  out.price_estimate = { setup_usd: [lo, hi], care_plan_usd_mo: [CARE_PLAN_USD_MO[0], CARE_PLAN_USD_MO[1]] };
  return out;
}

function candidateLine(r: CandidateRow): string {
  const ref = r.id != null && r.import_ref == null ? `id=${r.id}` : `import_ref=${r.import_ref ?? r.id}`;
  const facets = [
    (r.integrations ?? []).join("/"),
    (r.trigger_type ?? []).join("/"),
    r.is_rag ? "rag" : r.has_ai ? "ai" : "",
    r.primary_channels?.length ? `canales=${r.primary_channels.join(",")}` : "",
    r.use_case ? `caso=${r.use_case}` : "",
    typeof r.similarity === "number" ? `sim=${r.similarity.toFixed(2)}` : "",
  ].filter(Boolean).join(" · ");
  const desc = (r.description ?? "").trim().slice(0, 200);
  return `- ${r.name} [${ref}] (${r.category ?? "?"}${facets ? "; " + facets : ""})${desc ? `: ${desc}` : ""}`;
}

export function buildMessages(
  profile: RecommendProfile,
  workflows: CandidateRow[],
  software: CandidateRow[],
  ctx: SynthesizeContext = {},
) {
  let system =
    "Sos un consultor de automatización de Savante. A partir del perfil del negocio y de una " +
    "lista CERRADA de workflows n8n y software open-source recuperados, armás una recomendación. " +
    "REGLAS: (1) Sólo podés recomendar items de las listas provistas, citando su import_ref o id. " +
    "(2) Nunca inventes herramientas ni nombres. (3) El precio DEBE caer en esta grilla: " +
    PRICING_GRID + " (4) Si las listas no sirven, decilo en summary y poné tier='Audit'. " +
    "(5) El tier debe reflejar el ALCANCE: 1 automatización => 'Single Automation'; " +
    "si recomendás reemplazo de CRM/EHR/ERP/facturación o 3 o más automatizaciones DISTINTAS " +
    "(no variantes del mismo flujo) => tier='System' y precio acorde. No subcotices. " +
    "(6) roi_note: devolvé SIEMPRE null — el ROI se calcula aparte, en código, de forma " +
    "determinística; no lo estimes ni inventes números. " +
    "(7) watch_outs: 2-3 detalles que se suelen subestimar en ESTE flujo concreto (validación de " +
    "datos, formatos variables, casos borde, manejo de errores). Específicos al caso, no genéricos: " +
    "esto demuestra experiencia, no vendas humo. " +
    "(8) complexity: usá SIEMPRE Baja, Media o Alta (en español, nunca low/medium/high). " +
    "(9) Respondé EXCLUSIVAMENTE con un JSON válido con las claves: summary, roi_note (string|null), " +
    "watch_outs (array de strings), recommended_software " +
    "(array de {id,name,why}), recommended_workflows (array de {import_ref,name,why}), " +
    "suggested_stack, complexity (Baja|Media|Alta), implementation_days (entero), " +
    "price_estimate ({setup_usd:[min,max], care_plan_usd_mo:[min,max]}), tier. En español.";

  if (profile.wants_ai === "ninguna") {
    system += " REGLA CRÍTICA: el cliente pidió explícitamente NO usar IA. No recomiendes nada " +
      "que dependa de un LLM, OCR con API de IA, embeddings ni APIs de IA. Los candidatos ya " +
      "fueron filtrados; no menciones proveedores de IA ni OCR en workflows, arquitectura ni watch-outs.";
  }
  if (ctx.toolsToReplace?.length) {
    system += ` Herramientas que se ELIMINAN con la solución (no las menciones en arquitectura ` +
      `futura ni como riesgo del flujo nuevo): ${ctx.toolsToReplace.join(", ")}.`;
  }
  if (profile.hosting_pref === "self-hosted") {
    system += " Si el cliente es self-hosted, NO afirmes 'sin SaaS externos' mientras listás " +
      "SaaS. Los SaaS que sigan en uso sólo pueden aparecer rotulados como 'puente temporal, a migrar'.";
  }
  if (ctx.painChannels?.length) {
    system += ` CANAL DEL DOLOR: ${ctx.painChannels.join(", ")}. Priorizá workflows cuyo canal ` +
      "primario coincida. No recomiendes flujos centrados en Telegram/WhatsApp si el dolor es " +
      `Instagram, salvo como puente explícito. Caso de uso inferido: ${ctx.useCase ?? "?"}.`;
  }

  const volumeLine = [
    profile.pain_volume && `Volumen: ${profile.pain_volume}.`,
    profile.pain_time_each && `Tiempo por unidad: ${profile.pain_time_each}.`,
    profile.pain_cost && `Costo del dolor: ${profile.pain_cost}.`,
  ].filter(Boolean).join(" ");

  const user =
    `PERFIL DEL NEGOCIO:\n${buildQueryText(profile as Intake)}\n` +
    (volumeLine ? `MÉTRICAS PARA ROI: ${volumeLine}\n` : "") +
    `Presupuesto declarado: ${profile.budget_band ?? "no dice"}. Urgencia: ${profile.urgency ?? "no dice"}. ` +
    `Hosting preferido: ${profile.hosting_pref ?? "no dice"}. Equipo: ${profile.team_size ?? "no dice"}. ` +
    `Canal del dolor: ${ctx.painChannels?.join(", ") || "?"}. Caso de uso: ${ctx.useCase ?? "?"}.\n\n` +
    `WORKFLOWS n8n CANDIDATOS (elegí 2-4):\n${workflows.map(candidateLine).join("\n") || "(ninguno)"}\n\n` +
    `SOFTWARE OPEN-SOURCE CANDIDATO (elegí 0-3):\n${software.map(candidateLine).join("\n") || "(ninguno)"}`;

  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}

export interface SynthesizeOptions {
  apiKey?: string;
  model?: string;
  mock?: boolean;
}

/** Deterministic stub used when mock=true or no API key (lets us test the whole flow offline). */
function mockRecommendation(profile: RecommendProfile, workflows: CandidateRow[], software: CandidateRow[]): SynthesizedRecommendation {
  const roi = profile.pain_volume && profile.pain_time_each
    ? `Estimado: ${profile.pain_volume} × ${profile.pain_time_each} de proceso manual son horas/mes que se recuperan para tareas de mayor valor.`
    : null;
  return {
    summary:
      `[MOCK] ${profile.company ?? "tu negocio"}: el cuello de botella es "${profile.pain_primary}". ` +
      `Se puede automatizar con los workflows recuperados sobre ${profile.current_tools?.join(", ") || "tus herramientas"}.`,
    roi_note: roi,
    watch_outs: [
      "Los formatos de entrada no son uniformes: el flujo necesita validación y un camino de excepción, no sólo el caso feliz.",
      "Sin manejo de errores y reintentos, una caída de la API deja registros perdidos sin que nadie se entere.",
    ],
    recommended_workflows: workflows.slice(0, 3).map((w) => ({
      import_ref: w.import_ref ?? null, name: w.name ?? "", why: `Cubre el flujo "${profile.pain_primary}".`,
    })),
    recommended_software: software.slice(0, 2).map((s) => ({
      id: String(s.id ?? ""), name: s.name ?? "", why: "Alternativa open-source para el stack.",
    })),
    suggested_stack: "n8n self-hosted (VPS) + las integraciones existentes.",
    complexity: "Media",
    implementation_days: 5,
    price_estimate: { setup_usd: [800, 1500], care_plan_usd_mo: [150, 400] },
    tier: "Single Automation",
  };
}

/** Raw single-shot call to the LLM — no grounding/retry logic (kept for callers that want
 *  to own their own error handling, and for `synthesize` mock compatibility). */
export async function synthesizeRecommendation(
  profile: RecommendProfile,
  workflows: CandidateRow[],
  software: CandidateRow[],
  opts: SynthesizeOptions = {},
): Promise<SynthesizedRecommendation> {
  const key = opts.apiKey ?? (typeof process !== "undefined" ? process.env?.OPENROUTER_API_KEY : undefined);
  if (opts.mock || !key) return normalizeRecommendation(mockRecommendation(profile, workflows, software));

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: opts.model ?? "deepseek/deepseek-chat",
      messages: buildMessages(profile, workflows, software),
      response_format: { type: "json_object" },
      temperature: 0.3,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content ?? "{}";
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  return normalizeRecommendation(JSON.parse(cleaned) as SynthesizedRecommendation);
}

// Back-compat alias for the local pipeline / tests (service/src/recommend.ts re-exports this module).
export { synthesizeRecommendation as synthesize };
export type { SynthesizedRecommendation as Recommendation };

// ── Grounding ───────────────────────────────────────────────────────────────

export interface RejectedCitation {
  type: "workflow" | "software";
  ref: string | null;
  name: string;
}

/** Drop any recommended item whose import_ref/id doesn't match a candidate we actually
 *  passed to the LLM — the prompt rule is advisory, this is the enforced guarantee. */
export function validateGrounding(
  rec: SynthesizedRecommendation,
  workflows: CandidateRow[],
  software: CandidateRow[],
): { workflows: SynthesizedRecommendation["recommended_workflows"]; software: SynthesizedRecommendation["recommended_software"]; rejected: RejectedCitation[] } {
  const wfRefs = new Set(workflows.map((w) => String(w.import_ref ?? w.id ?? "")).filter(Boolean));
  const swIds = new Set(software.map((s) => String(s.id ?? "")).filter(Boolean));
  const rejected: RejectedCitation[] = [];

  const okWorkflows = (rec.recommended_workflows ?? []).filter((w) => {
    const ok = w.import_ref != null && wfRefs.has(String(w.import_ref));
    if (!ok) rejected.push({ type: "workflow", ref: w.import_ref, name: w.name });
    return ok;
  });
  const okSoftware = (rec.recommended_software ?? []).filter((s) => {
    const ok = s.id != null && swIds.has(String(s.id));
    if (!ok) rejected.push({ type: "software", ref: s.id, name: s.name });
    return ok;
  });

  return { workflows: okWorkflows, software: okSoftware, rejected };
}

export interface SynthesizeResult extends SynthesizedRecommendation {
  retrieval_meta: { rejected_citations: RejectedCitation[]; llm_retries: number };
}

/** Fallback used when the LLM keeps citing outside the candidate pool after a retry —
 *  a deterministic top-3 pick beats returning nothing. */
function deterministicFallback(profile: RecommendProfile, workflows: CandidateRow[]): SynthesizedRecommendation["recommended_workflows"] {
  return workflows.slice(0, 3).map((w) => ({
    import_ref: w.import_ref ?? null,
    name: w.name ?? "",
    why: "Coincide con tu búsqueda (selección automática, no generada por IA).",
  }));
}

/** Orchestrates synthesis + grounding + retries:
 *  1. Synthesize; on JSON.parse failure, one retry with a correction message.
 *  2. Validate grounding; drop out-of-pool citations.
 *  3. If 0 workflows remain and there WERE candidates, one retry asking to cite only the list.
 *  4. If still 0, deterministic fallback (top-3 by similarity, since candidates already come
 *     pre-ranked from match_templates_faceted/hybrid).
 */
export async function synthesizeRecommendationGrounded(
  profile: RecommendProfile,
  workflows: CandidateRow[],
  software: CandidateRow[],
  opts: SynthesizeOptions = {},
  ctx: SynthesizeContext = {},
): Promise<SynthesizeResult> {
  let retries = 0;
  let rec = await synthesizeOnce(profile, workflows, software, opts, ctx, null);
  if (rec === null) {
    retries++;
    rec = await synthesizeOnce(profile, workflows, software, opts, ctx,
      "Tu respuesta anterior no era JSON válido. Respondé SOLO el JSON, sin texto extra.");
  }
  if (rec === null) {
    // Both attempts failed to parse — deterministic fallback, no LLM text to trust.
    const base = mockRecommendation(profile, workflows, software);
    const finalized = finalizeRecommendation(
      { ...base, recommended_software: [], recommended_workflows: deterministicFallback(profile, workflows) },
      profile, ctx, workflows.length > 0,
    );
    return { ...finalized, retrieval_meta: { rejected_citations: [], llm_retries: retries } };
  }

  let { workflows: okWorkflows, software: okSoftware, rejected } = validateGrounding(rec, workflows, software);

  if (okWorkflows.length === 0 && workflows.length > 0 && rejected.length > 0) {
    retries++;
    const retryRec = await synthesizeOnce(profile, workflows, software, opts, ctx,
      "Citaste items fuera de la lista provista. Elegí SOLO de la lista, citando import_ref/id exacto.");
    if (retryRec) {
      const revalidated = validateGrounding(retryRec, workflows, software);
      rec = retryRec;
      okWorkflows = revalidated.workflows;
      okSoftware = revalidated.software;
      rejected = [...rejected, ...revalidated.rejected];
    }
  }

  if (okWorkflows.length === 0 && workflows.length > 0) {
    okWorkflows = deterministicFallback(profile, workflows);
  }

  const finalized = finalizeRecommendation(
    { ...rec, recommended_workflows: okWorkflows, recommended_software: okSoftware },
    profile, ctx, workflows.length > 0,
  );

  return { ...finalized, retrieval_meta: { rejected_citations: rejected, llm_retries: retries } };
}

/** normalizeRecommendation + deterministic roi_note (never trust the LLM's ROI math) +
 *  sanitizeRecommendation (strip mentions of tools being replaced) — the common tail every
 *  synthesis path (LLM success, parse-failure fallback) must go through. */
function finalizeRecommendation(
  rec: SynthesizedRecommendation,
  profile: RecommendProfile,
  ctx: SynthesizeContext,
  hadCandidates: boolean,
): SynthesizedRecommendation {
  let out = normalizeRecommendation(rec, { hadCandidates, profile, softwareCandidates: ctx.softwareCandidates });
  out = { ...out, roi_note: computeRoiNote(profile) };
  return sanitizeRecommendation(out, ctx.toolsToReplace ?? []);
}

/** Strip mentions of `toolsToReplace` from watch-outs (drop the whole watch-out if it names one)
 *  and from every other string field (summary/suggested_stack/recommended_*.why), replacing
 *  the tool name with a neutral phrase — guards against the LLM
 *  contradicting itself by listing a tool as part of the plan when it's actually being removed. */
export function sanitizeRecommendation(rec: SynthesizedRecommendation, toolsToReplace: string[]): SynthesizedRecommendation {
  if (!toolsToReplace.length) return rec;
  const patterns = toolsToReplace.map((t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));

  let result: SynthesizedRecommendation = {
    ...rec,
    watch_outs: (rec.watch_outs ?? []).filter((w) => !patterns.some((p) => p.test(w))),
  };
  result = deepStripReplacedTools(result, toolsToReplace) as SynthesizedRecommendation;
  return result;
}

function stripReplacedTools(text: string, toolsToReplace: string[]): string {
  let out = text;
  for (const tool of toolsToReplace) {
    const p = new RegExp(tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    out = out.replace(p, "la herramienta actual");
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

function deepStripReplacedTools(value: unknown, toolsToReplace: string[]): unknown {
  if (!toolsToReplace.length) return value;
  if (typeof value === "string") return stripReplacedTools(value, toolsToReplace);
  if (Array.isArray(value)) return value.map((v) => deepStripReplacedTools(v, toolsToReplace));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepStripReplacedTools(v, toolsToReplace);
    return out;
  }
  return value;
}

async function synthesizeOnce(
  profile: RecommendProfile,
  workflows: CandidateRow[],
  software: CandidateRow[],
  opts: SynthesizeOptions,
  ctx: SynthesizeContext,
  correction: string | null,
): Promise<SynthesizedRecommendation | null> {
  const key = opts.apiKey ?? (typeof process !== "undefined" ? process.env?.OPENROUTER_API_KEY : undefined);
  if (opts.mock || !key) return mockRecommendation(profile, workflows, software);

  const messages = buildMessages(profile, workflows, software, ctx);
  if (correction) messages.push({ role: "user" as const, content: correction });

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: opts.model ?? "deepseek/deepseek-chat",
      messages,
      response_format: { type: "json_object" },
      temperature: 0.3,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content ?? "{}";
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned) as SynthesizedRecommendation;
  } catch {
    return null;
  }
}
