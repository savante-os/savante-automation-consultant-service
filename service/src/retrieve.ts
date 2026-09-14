/**
 * Faceted retrieval over the local catalog. Local stand-in for
 * match_templates_faceted() (migration 003). No embeddings — hard filters + overlap rank.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CatalogRecord } from "./ingest-core.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CATALOG = resolve(HERE, "../out/catalog.json");

export interface FacetFilters {
  category?: string;
  integrations?: string[];
  trigger?: string[];
  onlyAi?: boolean;
  onlyRag?: boolean;
  source?: CatalogRecord["source"];
  excludeUnmaintained?: boolean;
}

const EMBEDDINGS = resolve(HERE, "../out/embeddings.json");

export async function loadCatalog(): Promise<CatalogRecord[]> {
  return JSON.parse(await readFile(CATALOG, "utf8"));
}

/** id -> 384-dim vector, from out/embeddings.json (npm run embed). Empty if absent. */
export async function loadEmbeddings(): Promise<Map<string, number[]>> {
  try {
    const arr: { id: string; embedding: number[] }[] = JSON.parse(await readFile(EMBEDDINGS, "utf8"));
    return new Map(arr.map((e) => [e.id, e.embedding]));
  } catch {
    return new Map();
  }
}

/** Re-rank already-faceted candidates by cosine similarity to the query vector. */
export function semanticRerank(
  records: CatalogRecord[],
  queryVec: number[],
  embMap: Map<string, number[]>,
  limit = 12,
): CatalogRecord[] {
  const ranked = records
    .map((r) => {
      const v = embMap.get(r.id);
      let s = 0;
      if (v) for (let i = 0; i < v.length; i++) s += v[i] * queryVec[i];
      return { r, s };
    })
    .sort((a, b) => b.s - a.s)
    .map((x) => x.r);
  return dedupByName(ranked).slice(0, limit);
}

/** Drop duplicate workflows (the corpus has the same template scraped more than once). */
function dedupByName(records: CatalogRecord[]): CatalogRecord[] {
  const seen = new Set<string>();
  return records.filter((r) => {
    const k = r.name.trim().toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function lc(a: string[]): string[] { return a.map((s) => s.toLowerCase()); }
function overlap(have: string[], want: string[]): number {
  const h = lc(have);
  return want.filter((w) => h.includes(w.toLowerCase())).length;
}

/** Filter (hard) + rank (facet overlap, then popularity). Returns top `limit`. */
export function facetedRetrieve(
  catalog: CatalogRecord[],
  f: FacetFilters,
  limit = 12,
): CatalogRecord[] {
  let pool = catalog;
  if (f.source) pool = pool.filter((r) => r.source === f.source);
  if (f.category) pool = pool.filter((r) => (r.category ?? "").toLowerCase().includes(f.category!.toLowerCase()));
  if (f.integrations?.length) pool = pool.filter((r) => overlap(r.integrations, f.integrations!) > 0);
  if (f.trigger?.length) pool = pool.filter((r) => overlap(r.trigger_type, f.trigger!) > 0);
  if (f.onlyRag) pool = pool.filter((r) => r.is_rag);
  if (f.onlyAi) pool = pool.filter((r) => r.has_ai);
  if (f.excludeUnmaintained) pool = pool.filter((r) => !r.unmaintained);

  const ranked = pool
    .map((r) => ({
      r,
      score:
        (f.integrations ? overlap(r.integrations, f.integrations) : 0) +
        (f.trigger ? overlap(r.trigger_type, f.trigger) : 0),
    }))
    .sort((a, b) => b.score - a.score || b.r.popularity - a.r.popularity)
    .map((x) => x.r);
  return dedupByName(ranked).slice(0, limit);
}
