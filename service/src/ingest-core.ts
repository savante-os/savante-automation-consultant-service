/**
 * Parse one corpus JSON file into a catalog record with deterministic facets.
 * Mirrors the future `templates` row (migrations 001 + 003).
 */
import { facetsFromNodeTypes } from "./facets.js";

export type Source = "marketplace" | "curated" | "self-hosted" | "individual";

export interface CatalogRecord {
  id: string;
  source: Source;
  name: string;
  category: string | null;
  path: string;
  import_ref: string | null;
  popularity: number;
  description: string;
  // facets
  integrations: string[];
  trigger_type: string[];
  has_ai: boolean;
  is_rag: boolean;
  tags: string[];
  // self-hosted only
  license: string | null;
  stack: string | null;
  unmaintained: boolean;
  // for embedding later (not vectorized yet)
  content: string;
}

/** Top-level folder slugs treated as marketplace categories during ingestion. */
const MARKETPLACE_SLUGS = new Set(["sales", "marketing", "support", "ai-rag", "document-ops", "multimodal-ai"]);

function topFolder(relPath: string): string {
  return relPath.split(/[\\/]/)[0] ?? "";
}

/** Collect every node `type` from a parsed n8n workflow JSON, however deeply nested.
 *  Marketplace files keep nodes at workflow.nodes / workflow.workflow.nodes. */
function nodeTypes(json: any): string[] {
  const out: string[] = [];
  const seen = new Set<any>();
  (function walk(o: any) {
    if (!o || typeof o !== "object" || seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o.nodes)) {
      for (const n of o.nodes) if (n && typeof n.type === "string") out.push(n.type);
    }
    for (const k of Object.keys(o)) walk(o[k]);
  })(json);
  return out;
}

/** Best-effort workflow name across the nesting variants. */
function workflowName(raw: any): string {
  return clean(raw?.name ?? raw?.workflow?.name ?? raw?.workflow?.workflow?.name ?? "");
}

function clean(s: unknown): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
}

/**
 * @param relPath path relative to data/ (e.g. "sales/10009 - ....json")
 * @param raw     parsed JSON content
 */
export function toRecord(relPath: string, raw: any): CatalogRecord | null {
  const folder = topFolder(relPath);

  // ---- Self-hosted software ----
  if (folder === "self-hosted" || raw?.workflow?.sourceType === "self-hosted-software") {
    const meta = raw?.meta ?? {};
    const wf = raw?.workflow ?? {};
    const name = clean(wf.name ?? meta.name ?? "");
    const description = clean(meta.description ?? wf.description ?? "");
    const tags: string[] = Array.isArray(wf.tags) ? wf.tags : [];
    return {
      id: String(raw?.id ?? `ash:${name}`),
      source: "self-hosted",
      name,
      category: clean(meta.category) || null,
      path: `data/${relPath}`,
      import_ref: clean(meta.url ?? wf?.links?.homepage) || null,
      popularity: 0,
      description,
      integrations: [],
      trigger_type: [],
      has_ai: false,
      is_rag: false,
      tags,
      license: clean(meta.license ?? wf.license) || null,
      stack: clean(meta.stack ?? wf.stack) || null,
      unmaintained: Boolean(meta.unmaintained ?? wf.unmaintained ?? false),
      content: [name, description, clean(meta.stack), tags.join(" ")].filter(Boolean).join(" — "),
    };
  }

  // ---- n8n workflow (marketplace / curated / individual) ----
  const meta = raw?.meta ?? {};
  const types = nodeTypes(raw);
  if (types.length === 0 && !meta.category && !raw?.name) return null; // not a usable record

  const f = facetsFromNodeTypes(types);
  const fileName = (relPath.split(/[\\/]/).pop() ?? "").replace(/\.json$/i, "").replace(/^\d+\s*-\s*/, "");
  const name = workflowName(raw) || clean(meta.title) || fileName || `Workflow ${raw?.id ?? ""}`;
  const description = clean(meta.description ?? raw?.description ?? "");
  const category = clean(meta.category) || folder || null;

  let source: Source;
  if (folder === "individual") source = "individual";
  else if (MARKETPLACE_SLUGS.has(folder)) source = "marketplace";
  else source = "curated";

  const tags = [
    category, ...f.integrations, ...f.triggerChannels,
    f.hasAi ? "ai" : null, f.isRag ? "rag" : null,
  ].filter((x): x is string => Boolean(x));

  return {
    id: String(raw?.id ?? relPath),
    source,
    name,
    category,
    path: `data/${relPath}`,
    import_ref: clean(meta.url) || null,
    popularity: Number(meta.totalViews ?? 0) || 0,
    description,
    integrations: f.integrations,
    trigger_type: f.triggerChannels,
    has_ai: f.hasAi,
    is_rag: f.isRag,
    tags: [...new Set(tags)],
    license: null,
    stack: null,
    unmaintained: false,
    content: [name, description, f.integrations.join(", ")].filter(Boolean).join(" — "),
  };
}
