/**
 * Intake = the questionnaire output (see docs/INTAKE_QUESTIONNAIRE.md).
 * Canonical `Intake` type and query text now live in
 * ../supabase/functions/_shared/retrieval.ts (shared with the edge functions) —
 * this module re-exports them and keeps only the local-pipeline adapters (`retrieve.ts`
 * talks to the in-memory catalog, not Postgres, so it needs its own filter shape).
 */
import type { FacetFilters } from "./retrieve.js";
import type { Intake as SharedIntake } from "../supabase/functions/_shared/retrieval.js";

export type { Intake } from "../supabase/functions/_shared/retrieval.js";
export { buildQueryText as queryText } from "../supabase/functions/_shared/retrieval.js";

/** Build the workflow (n8n) retrieval filter from the intake answers, for the LOCAL
 *  in-memory pipeline (retrieve.ts#facetedRetrieve) — mirrors _shared/retrieval.ts#workflowFacetLevels
 *  L0, but as a single-shot filter (the local pipeline doesn't need the fallback ladder). */
export function workflowFilters(i: SharedIntake): FacetFilters {
  return {
    integrations: i.current_tools?.length ? i.current_tools : undefined,
    trigger: i.input_channels?.length ? i.input_channels : undefined,
    onlyAi: i.wants_ai === "ia" || i.wants_ai === "rag" ? true : undefined,
    onlyRag: i.wants_ai === "rag" ? true : undefined,
  };
}

/** Build the self-hosted software retrieval filter for the local pipeline. Niche relevance is
 *  a post-hoc boost now (see _shared/retrieval.ts#rankSoftwareByNiche), not a hard category
 *  filter — a wrong hard-coded category can return 0 rows, a boost never does. */
export function softwareFilters(i: SharedIntake): FacetFilters | null {
  if (i.hosting_pref === "cloud") return null;
  return { source: "self-hosted", excludeUnmaintained: true };
}
