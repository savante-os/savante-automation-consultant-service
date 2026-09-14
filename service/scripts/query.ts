/**
 * Faceted retrieval harness — validates retrieval quality with NO embeddings.
 * Thin CLI over src/retrieve.ts (the local stand-in for match_templates_faceted, migration 003).
 *
 * Usage:
 *   npm run query -- --category Sales --integrations "Gmail,HubSpot" --trigger form --rag
 *   npm run query -- --integrations "Google Sheets" --source marketplace --limit 15
 *
 * Flags (all optional; omit a facet to ignore it):
 *   --category <c>            category contains (case-insensitive)
 *   --integrations "a,b,c"    must overlap at least one
 *   --trigger "email,form"    must overlap at least one input channel
 *   --rag / --ai             only is_rag / has_ai
 *   --source <s>              marketplace | curated | self-hosted | individual
 *   --no-unmaintained         exclude unmaintained (self-hosted)
 *   --limit <n>               default 10
 */
import { loadCatalog, facetedRetrieve, type FacetFilters } from "../src/retrieve.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
function list(name: string): string[] | undefined {
  const v = arg(name);
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
}

async function main() {
  let catalog;
  try { catalog = await loadCatalog(); }
  catch { console.error("✗ No hay out/catalog.json. Corré primero: npm run ingest"); process.exit(1); }

  const filters: FacetFilters = {
    category: arg("category"),
    integrations: list("integrations"),
    trigger: list("trigger"),
    onlyRag: flag("rag") || undefined,
    onlyAi: flag("ai") || undefined,
    source: arg("source") as FacetFilters["source"],
    excludeUnmaintained: flag("no-unmaintained") || undefined,
  };
  const limit = Number(arg("limit") ?? 10);

  // count of the hard-filtered pool (without the limit) for the validation message
  const all = facetedRetrieve(catalog, filters, Number.MAX_SAFE_INTEGER);
  const results = all.slice(0, limit);

  console.log(`\nFiltros → ${JSON.stringify(filters)}`);
  console.log(`Candidatos que cumplen el filtro duro: ${all.length} (de ${catalog.length})\n`);
  for (const r of results) {
    console.log(`• [${r.source}] ${r.name}`);
    console.log(`    cat: ${r.category ?? "—"} | trigger: ${r.trigger_type.join(",") || "—"} | ai:${r.has_ai} rag:${r.is_rag}`);
    if (r.integrations.length) console.log(`    integraciones: ${r.integrations.join(", ")}`);
  }
  if (results.length === 0) console.log("(sin resultados — relajá un filtro)");
}

main().catch((e) => { console.error(e); process.exit(1); });
