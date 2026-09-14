/**
 * Synthesis step: faceted candidates + business profile -> structured recommendation.
 * Uses DeepSeek via OpenRouter. The LLM may ONLY cite candidates we pass in (anti-hallucination).
 * See docs/SOLUTION_ARCHITECTURE.md §4 step 3.
 */
import type { CatalogRecord } from "./ingest-core.js";
import type { Intake } from "./intake.js";
import { queryText } from "./intake.js";

export interface Recommendation {
  summary: string;
  /** Quantified impact (volume × time) framed as an estimate. Omitted when the intake lacks volume/time. */
  roi_note?: string | null;
  /** 2-3 case-specific risks/edge-cases that prove hands-on experience (validation, variable formats, error handling). */
  watch_outs?: string[];
  recommended_software: { id: string; name: string; why: string }[];
  recommended_workflows: { import_ref: string | null; name: string; why: string }[];
  suggested_stack: string;
  complexity: "Baja" | "Media" | "Alta" | string;
  implementation_days: number;
  price_estimate: { setup_usd: [number, number]; care_plan_usd_mo: [number, number] };
  tier: "Audit" | "Single Automation" | "System" | string;
}

/**
 * Single source of truth for pricing (kept in code, not in marketing docs).
 * The LLM picks the tier; `normalizeRecommendation` snaps the price to this grid
 * so the number can never drift from the tier.
 */
export const PRICING = {
  Audit: { setup_usd: [150, 300], blurb: "solo diagnóstico" },
  "Single Automation": { setup_usd: [800, 1500], blurb: "1 workflow" },
  System: { setup_usd: [2000, 4000], blurb: "3-5 workflows" },
} as const;
export const CARE_PLAN_USD_MO: readonly [number, number] = [150, 400];

const PRICING_GRID =
  Object.entries(PRICING)
    .map(([tier, p]) => `${tier} ${p.setup_usd[0]}-${p.setup_usd[1]} (${p.blurb})`)
    .join(", ") + `, Care Plan ${CARE_PLAN_USD_MO[0]}-${CARE_PLAN_USD_MO[1]}/mes.`;

/**
 * Enforce invariants we can't trust the LLM to compute: the price MUST match the
 * declared tier's grid. The tier itself is the LLM's semantic call (rule 5 in the
 * prompt: 3+ distinct automations => System), but we never let the number drift.
 * Unknown/custom tiers are left untouched.
 */
export function normalizeRecommendation(rec: Recommendation): Recommendation {
  const grid = PRICING[rec.tier as keyof typeof PRICING];
  if (!grid) return rec;
  return {
    ...rec,
    price_estimate: {
      setup_usd: [grid.setup_usd[0], grid.setup_usd[1]],
      care_plan_usd_mo: [CARE_PLAN_USD_MO[0], CARE_PLAN_USD_MO[1]],
    },
  };
}

function candidateLine(r: CatalogRecord): string {
  const ref = r.source === "self-hosted" ? `id=${r.id}` : `import_ref=${r.import_ref ?? r.id}`;
  const facets = [r.integrations.join("/"), r.trigger_type.join("/"), r.is_rag ? "rag" : r.has_ai ? "ai" : ""]
    .filter(Boolean).join(" · ");
  return `- ${r.name} [${ref}] (${r.category ?? "?"}${facets ? "; " + facets : ""})`;
}

export function buildMessages(i: Intake, workflows: CatalogRecord[], software: CatalogRecord[]) {
  const system =
    "Sos un consultor de automatización de Savante. A partir del perfil del negocio y de una " +
    "lista CERRADA de workflows n8n y software open-source recuperados, armás una recomendación. " +
    "REGLAS: (1) Sólo podés recomendar items de las listas provistas, citando su import_ref o id. " +
    "(2) Nunca inventes herramientas ni nombres. (3) El precio DEBE caer en esta grilla: " +
    PRICING_GRID + " (4) Si las listas no sirven, decilo en summary y poné tier='Audit'. " +
    "(5) El tier debe reflejar el ALCANCE: 1 automatización => 'Single Automation'; " +
    "si recomendás 3 o más automatizaciones DISTINTAS (no variantes del mismo flujo) " +
    "=> tier='System' y precio acorde. No subcotices. " +
    "(6) roi_note: si el perfil trae volumen Y tiempo por unidad, estimá las horas/mes que se " +
    "recuperan (volumen × tiempo, redondeado) y expresalo en una frase con el cálculo a la vista, " +
    "marcado como estimación. Si faltan esos datos, devolvé roi_note=null. NUNCA inventes números. " +
    "(7) watch_outs: 2-3 detalles que se suelen subestimar en ESTE flujo concreto (validación de " +
    "datos, formatos variables, casos borde, manejo de errores). Específicos al caso, no genéricos: " +
    "esto demuestra experiencia, no vendas humo. " +
    "(8) Respondé EXCLUSIVAMENTE con un JSON válido con las claves: summary, roi_note (string|null), " +
    "watch_outs (array de strings), recommended_software " +
    "(array de {id,name,why}), recommended_workflows (array de {import_ref,name,why}), " +
    "suggested_stack, complexity (Baja|Media|Alta), implementation_days (entero), " +
    "price_estimate ({setup_usd:[min,max], care_plan_usd_mo:[min,max]}), tier. En español.";

  const volumeLine = [
    i.pain_volume && `Volumen: ${i.pain_volume}.`,
    i.pain_time_each && `Tiempo por unidad: ${i.pain_time_each}.`,
    i.pain_cost && `Costo del dolor: ${i.pain_cost}.`,
  ].filter(Boolean).join(" ");

  const user =
    `PERFIL DEL NEGOCIO:\n${queryText(i)}\n` +
    (volumeLine ? `MÉTRICAS PARA ROI: ${volumeLine}\n` : "") +
    `Presupuesto declarado: ${i.budget_band ?? "no dice"}. Urgencia: ${i.urgency ?? "no dice"}.\n\n` +
    `WORKFLOWS n8n CANDIDATOS (elegí 2-4):\n${workflows.map(candidateLine).join("\n") || "(ninguno)"}\n\n` +
    `SOFTWARE OPEN-SOURCE CANDIDATO (elegí 0-3):\n${software.map(candidateLine).join("\n") || "(ninguno)"}`;

  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}

export interface SynthOptions {
  apiKey?: string;
  model?: string;
  mock?: boolean;
}

/** Deterministic stub used when mock=true or no API key (lets us test the whole flow offline). */
function mockRecommendation(i: Intake, workflows: CatalogRecord[], software: CatalogRecord[]): Recommendation {
  const roi = i.pain_volume && i.pain_time_each
    ? `Estimado: ${i.pain_volume} × ${i.pain_time_each} de proceso manual son horas/mes que se recuperan para tareas de mayor valor.`
    : null;
  return {
    summary:
      `[MOCK] ${i.company}: el cuello de botella es "${i.pain_primary}". ` +
      `Se puede automatizar con los workflows recuperados sobre ${i.current_tools?.join(", ") || "tus herramientas"}.`,
    roi_note: roi,
    watch_outs: [
      "Los formatos de entrada no son uniformes: el flujo necesita validación y un camino de excepción, no sólo el caso feliz.",
      "Sin manejo de errores y reintentos, una caída de la API deja registros perdidos sin que nadie se entere.",
    ],
    recommended_workflows: workflows.slice(0, 3).map((w) => ({
      import_ref: w.import_ref, name: w.name, why: `Cubre el flujo "${i.pain_primary}".`,
    })),
    recommended_software: software.slice(0, 2).map((s) => ({
      id: s.id, name: s.name, why: "Alternativa open-source para el stack.",
    })),
    suggested_stack: "n8n self-hosted (VPS) + las integraciones existentes.",
    complexity: "Media",
    implementation_days: 5,
    price_estimate: { setup_usd: [800, 1500], care_plan_usd_mo: [150, 400] },
    tier: "Single Automation",
  };
}

export async function synthesize(
  i: Intake,
  workflows: CatalogRecord[],
  software: CatalogRecord[],
  opts: SynthOptions = {},
): Promise<Recommendation> {
  const key = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (opts.mock || !key) return normalizeRecommendation(mockRecommendation(i, workflows, software));

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: opts.model ?? "deepseek/deepseek-chat",
      messages: buildMessages(i, workflows, software),
      response_format: { type: "json_object" },
      temperature: 0.3,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "{}";
  return normalizeRecommendation(JSON.parse(content) as Recommendation);
}
