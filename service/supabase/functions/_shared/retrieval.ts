/**
 * Single source of truth for "how retrieval is built from an intake" — shared by
 * recommend/ and catalog-search/ (recommend_automation MCP tool) so the edge runtime
 * and the local pipeline (service/src/intake.ts) cannot diverge.
 *
 * Covers query-text construction, the progressive facet fallback ladder, channel/use-case-
 * aware re-ranking, and the niche boost for self-hosted software.
 */

export interface Intake {
  company: string;
  contact_name?: string;
  email: string;
  niche?: string;
  country?: string;
  city?: string;
  team_size?: string;
  pain_primary: string;
  pain_secondary?: string;
  pain_volume?: string;
  pain_time_each?: string;
  pain_cost?: string;
  /** Raw numeric fields behind pain_volume/pain_time_each — needed for a deterministic ROI
   *  calculation in code (see recommend-synthesis.ts#computeRoiNote); the LLM never computes it. */
  pain_volume_count?: string | number;
  pain_volume_period?: "day" | "week" | "month" | string;
  pain_time_amount?: string | number;
  pain_time_unit?: "min" | "hour" | string;
  current_tools?: string[];
  input_channels?: string[];
  output_targets?: string[];
  hosting_pref?: "cloud" | "self-hosted" | "on-premise" | "not-sure" | string;
  wants_ai?: "ninguna" | "ia" | "rag" | string;
  urgency?: string;
  budget_band?: string;
  decision_role?: string;
}

/** The natural-language query text built from the business pain (for the LLM + embedding). */
export function buildQueryText(i: Intake): string {
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

// ── Channel / use-case extraction ──────────────────────────────────────────────────────

/** Channels detectable in free text pain description, beyond what the form's checkboxes give. */
const PAIN_CHANNEL_PATTERNS: Record<string, RegExp> = {
  instagram: /\b(instagram|insta|dm de instagram|mensajes de instagram|directos de instagram)\b/i,
  whatsapp: /\b(whatsapp|wa\b)\b/i,
  telegram: /\btelegram\b/i,
  email: /\b(email|gmail|correo|mail)\b/i,
  facebook: /\b(facebook|meta inbox)\b/i,
  form: /\b(formulario|typeform|form)\b/i,
  shopify: /\bshopify\b/i,
};

const INPUT_CHANNEL_ALIASES: Record<string, string> = {
  whatsapp: "whatsapp", instagram: "instagram", email: "email",
  form: "form", webhook: "webhook", chat: "chat",
};

/** Map questionnaire input_channels to templates.trigger_type values. */
export function mapInputChannelsToTriggers(channels: string[]): string[] | null {
  const mapped: string[] = [];
  for (const c of channels) {
    if (c === "instagram") mapped.push("webhook", "chat");
    else if (c === "whatsapp") mapped.push("whatsapp", "chat");
    else mapped.push(c);
  }
  return mapped.length ? [...new Set(mapped)] : null;
}

/** Channels that only count as a match when the workflow ALSO matches the pain channel
 *  (e.g. a generic "chat" trigger shouldn't outrank an Instagram-specific one). */
const PROXY_ONLY_CHANNELS = new Set(["telegram"]);

export function extractPainChannels(i: Intake): string[] {
  const text = `${i.pain_primary ?? ""} ${(i.input_channels ?? []).join(" ")}`;
  const channels = new Set<string>();
  for (const [ch, re] of Object.entries(PAIN_CHANNEL_PATTERNS)) {
    if (re.test(text)) channels.add(ch);
  }
  for (const ic of i.input_channels ?? []) {
    const mapped = INPUT_CHANNEL_ALIASES[ic];
    if (mapped && mapped !== "chat") channels.add(mapped);
  }
  return [...channels];
}

export function inferUseCase(i: Intake): string {
  const text = i.pain_primary ?? "";
  if (/\b(publicar|posteo|contenido|redes sociales|subir)\b/i.test(text) &&
    /\binstagram\b/i.test(text)) return "outbound_publishing";
  if (/\b(consulta|responder|respuesta|atención|atencion|soporte|mensaje|dm|inbox|ticket)\b/i.test(text)) {
    return "inbound_support";
  }
  if (/\b(agendar|cita|turno|calendario|appointment)\b/i.test(text)) return "scheduling";
  if (/\b(reporte|informe|analytics)\b/i.test(text)) return "reporting";
  if (/\b(cv|currículum|curriculum|candidato|reclutamiento)\b/i.test(text)) return "recruiting";
  if (/\b(reemplaz|migrar|crm|erp|sistema)\b/i.test(text)) return "automation";
  return "inbound_support";
}

export function isSingleLoopPain(i: Intake): boolean {
  return !/\b(reemplaz|migrar|crm|erp|sistema completo|varios procesos|3\+)\b/i.test(i.pain_primary ?? "");
}

interface ChannelRankable {
  similarity?: number | null;
  primary_channels?: string[] | null;
  use_case?: string | null;
  integrations?: string[] | null;
}

function norm(s: unknown): string { return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim(); }

/** Re-rank workflow candidates by channel/use-case fit — semantic similarity still leads,
 *  channel/use-case/tool-overlap only break ties and demote clear mismatches. */
export function rankWorkflowsByChannel<T extends ChannelRankable>(
  workflows: T[], painChannels: string[], useCase: string, currentTools: string[],
): T[] {
  const toolSet = new Set(currentTools.map((t) => norm(t)));

  function score(w: T): number {
    let s = w.similarity ?? 0;
    const channels: string[] = w.primary_channels ?? [];

    if (painChannels.length) {
      const matchesPain = channels.some((c) => painChannels.includes(c));
      if (matchesPain) s *= 1.35;
      else if (channels.length) {
        const proxyOnly = channels.every((c) => PROXY_ONLY_CHANNELS.has(c) || c === "chat");
        const painSpecific = painChannels.some((c) => !PROXY_ONLY_CHANNELS.has(c));
        if (proxyOnly && painSpecific) s *= 0.45;
        else s *= 0.75;
      }
    }

    if (useCase && w.use_case === useCase) s *= 1.2;
    if (useCase === "inbound_support" && w.use_case === "outbound_publishing") s *= 0.4;
    if (useCase === "inbound_support" && w.use_case === "reporting") s *= 0.5;
    if (useCase === "inbound_support" && w.use_case === "scheduling") s *= 0.65;

    const overlap = (w.integrations ?? []).filter((x) => toolSet.has(norm(x))).length;
    s *= 1 + overlap * 0.04;
    return s;
  }

  return [...workflows].sort((a, b) => score(b) - score(a));
}

// ── Progressive facet fallback (merged with channel/use-case) ─────────────────────────

export interface FacetLevel {
  filter_integrations: string[] | null;
  filter_trigger: string[] | null;
  filter_primary_channels: string[] | null;
  filter_use_case: string | null;
}

/** Richest filter combo first, progressively relaxed, down to pure semantic. `filter_is_rag`/
 *  `filter_uses_ai` are NOT part of the ladder — they're hard business constraints applied at
 *  every level unconditionally (see `aiFilters` in recommend/index.ts), never relaxed. */
export function workflowFacetLevels(i: Intake): FacetLevel[] {
  const integrations = i.current_tools?.length ? i.current_tools : null;
  const trigger = i.input_channels?.length ? mapInputChannelsToTriggers(i.input_channels) : null;
  const painChannels = extractPainChannels(i);
  const channels = painChannels.length ? painChannels : null;
  const useCase = inferUseCase(i);
  const useCaseFilter = useCase !== "automation" ? useCase : null;

  const levels: FacetLevel[] = [
    { filter_integrations: integrations, filter_trigger: trigger, filter_primary_channels: channels, filter_use_case: useCaseFilter },
    { filter_integrations: null, filter_trigger: null, filter_primary_channels: channels, filter_use_case: useCaseFilter },
    { filter_integrations: integrations, filter_trigger: trigger, filter_primary_channels: null, filter_use_case: null },
    { filter_integrations: null, filter_trigger: null, filter_primary_channels: channels, filter_use_case: null },
    { filter_integrations: null, filter_trigger: null, filter_primary_channels: null, filter_use_case: useCaseFilter },
    { filter_integrations: integrations, filter_trigger: null, filter_primary_channels: null, filter_use_case: null },
    { filter_integrations: null, filter_trigger: trigger, filter_primary_channels: null, filter_use_case: null },
    { filter_integrations: null, filter_trigger: null, filter_primary_channels: null, filter_use_case: null },
  ];

  const deduped: FacetLevel[] = [];
  for (const lvl of levels) {
    const prev = deduped[deduped.length - 1];
    if (prev && JSON.stringify(prev) === JSON.stringify(lvl)) continue;
    deduped.push(lvl);
  }
  return deduped;
}

// ── Software: niche boost (replaces a hard category filter — a boost never returns
//    0 rows, a wrong hard-coded category would) ─────────────────────────────────────────

export const NICHE_CATEGORY_BOOST: Record<string, { patterns: RegExp[]; boost: number }> = {
  health: { patterns: [/health and fitness/i, /medical/i, /ehr/i], boost: 1.25 },
  ecommerce: { patterns: [/e-commerce/i], boost: 1.25 },
  recruiting: { patterns: [/human resources/i, /crm/i, /recruit/i], boost: 1.15 },
  accounting: { patterns: [/money, budgeting/i, /accounting/i, /invoice/i], boost: 1.15 },
};

interface NicheRankable { similarity?: number | null; category?: string | null }

export function rankSoftwareByNiche<T extends NicheRankable>(software: T[], niche?: string): T[] {
  const config = niche ? NICHE_CATEGORY_BOOST[niche.toLowerCase()] : undefined;
  if (!config) return software;
  return [...software].sort((a, b) => {
    const boostA = config.patterns.some((p) => p.test(a.category ?? "")) ? config.boost : 1;
    const boostB = config.patterns.some((p) => p.test(b.category ?? "")) ? config.boost : 1;
    return (b.similarity ?? 0) * boostB - (a.similarity ?? 0) * boostA;
  });
}

/** SaaS tools commonly replaced in self-hosted migrations — used to keep the LLM/email from
 *  contradicting itself ("sin SaaS externos" while still listing HubSpot as part of the plan). */
const DOMAIN_SAAS = new Set(["hubspot", "salesforce", "pipedrive", "zoho crm", "shopify", "monday", "asana"]);

export function deriveToolsToReplace(i: Intake): string[] {
  if (i.hosting_pref !== "self-hosted") return [];
  return (i.current_tools ?? []).filter((t) => DOMAIN_SAAS.has(norm(t)));
}

/** Drop duplicate workflows (a corpus can contain the same template more than once). */
export function dedupByName<T extends { name: string }>(records: T[]): T[] {
  const seen = new Set<string>();
  return records.filter((r) => {
    const k = r.name.trim().toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
