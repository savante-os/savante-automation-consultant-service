/**
 * Intake = the questionnaire output (see docs/INTAKE_QUESTIONNAIRE.md).
 * Also maps the answers to the hard facet filters used for retrieval.
 */
import type { FacetFilters } from "./retrieve.js";

export interface Intake {
  // Block A — identity / Block E — delivery
  company: string;
  niche?: string;
  country?: string;
  city?: string;
  team_size?: string;
  contact_name?: string;
  email: string;                 // E1 — required: where we send the plan
  // Block B — pain
  pain_primary: string;
  pain_secondary?: string;
  pain_volume?: string;
  pain_time_each?: string;
  pain_cost?: string;
  // Block C — technical (the hard filter)
  current_tools?: string[];      // -> integrations
  input_channels?: string[];     // -> trigger_type  (email|form|chat|whatsapp|schedule|webhook|file|app-event)
  output_targets?: string[];
  hosting_pref?: "self-hosted" | "no-importa" | string;
  wants_ai?: "ninguna" | "ia" | "rag" | string;
  // Block D — qualification
  urgency?: string;
  budget_band?: string;
  decision_role?: string;
}

/** Niche/pasillo -> likely self-hosted software categories (best-effort). */
const NICHE_TO_SH_CATEGORY: Record<string, string> = {
  support: "ticketing", "customer support": "ticketing", soporte: "ticketing",
  sales: "customer relationship management", ventas: "customer relationship management",
  crm: "customer relationship management",
  marketing: "analytics", finance: "money", finanzas: "money",
  hr: "human resources", rrhh: "human resources", recruiting: "human resources",
  ecommerce: "e-commerce", "e-commerce": "e-commerce",
  docs: "document management", knowledge: "knowledge management",
};

/** Build the workflow (n8n) retrieval filter from the intake answers. */
export function workflowFilters(i: Intake): FacetFilters {
  return {
    integrations: i.current_tools?.length ? i.current_tools : undefined,
    trigger: i.input_channels?.length ? i.input_channels : undefined,
    onlyAi: i.wants_ai === "ia" || i.wants_ai === "rag" ? true : undefined,
    onlyRag: i.wants_ai === "rag" ? true : undefined,
  };
}

/** Build the self-hosted software retrieval filter (best-effort by niche). */
export function softwareFilters(i: Intake): FacetFilters | null {
  if (i.hosting_pref && i.hosting_pref !== "self-hosted") {
    // user doesn't care about self-hosting; software is optional, skip unless we have a category
  }
  const key = (i.niche ?? "").toLowerCase().trim();
  const cat = NICHE_TO_SH_CATEGORY[key];
  if (!cat) return null;
  return { source: "self-hosted", category: cat, excludeUnmaintained: true };
}

/** The natural-language query text built from the business pain (for the LLM + future embedding). */
export function queryText(i: Intake): string {
  return [
    i.company && `${i.company}${i.niche ? ` (${i.niche})` : ""}${i.city ? `, ${i.city}` : ""}.`,
    i.team_size && `Equipo: ${i.team_size}.`,
    i.pain_primary && `Dolor principal: ${i.pain_primary}.`,
    i.pain_volume && `Volumen: ${i.pain_volume}.`,
    i.pain_time_each && `Tiempo por unidad: ${i.pain_time_each}.`,
    i.pain_cost && `Costo del dolor: ${i.pain_cost}.`,
    i.pain_secondary && `Segundo dolor: ${i.pain_secondary}.`,
    i.current_tools?.length && `Herramientas: ${i.current_tools.join(", ")}.`,
    i.input_channels?.length && `Entra por: ${i.input_channels.join(", ")}.`,
    i.output_targets?.length && `Debería terminar en: ${i.output_targets.join(", ")}.`,
  ].filter(Boolean).join(" ");
}
