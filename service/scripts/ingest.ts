/**
 * Ingest the local corpus (../data) into a local catalog of faceted records.
 * Deterministic: no embeddings, no API keys. Run: npm run ingest
 *
 * Outputs:
 *   out/catalog.json  — every record with facets (the local "templates" table)
 *   out/stats.json    — corpus stats to seed the questionnaire selects
 */
import { readdir, readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toRecord, type CatalogRecord } from "../src/ingest-core.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DATA_DIR = resolve(HERE, "../../data");
const OUT_DIR = resolve(HERE, "../out");

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && entry.name.endsWith(".json") && entry.name !== "index.json") yield full;
  }
}

function tally(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}
function topN(map: Map<string, number>, n: number) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ value: k, count: v }));
}

async function main() {
  try { await stat(DATA_DIR); } catch {
    console.error(`✗ No encuentro el corpus en ${DATA_DIR}. ¿Está el directorio data/ local?`);
    process.exit(1);
  }

  const records: CatalogRecord[] = [];
  let scanned = 0, skipped = 0, errored = 0;

  // stats accumulators
  const bySource = new Map<string, number>();
  const byCategory = new Map<string, number>();
  const integrations = new Map<string, number>();
  const triggers = new Map<string, number>();
  const licenses = new Map<string, number>();
  let aiCount = 0, ragCount = 0;
  // integrations per category (for context-aware selects)
  const intByCat = new Map<string, Map<string, number>>();

  for await (const file of walk(DATA_DIR)) {
    scanned++;
    const relPath = relative(DATA_DIR, file);
    let raw: any;
    try { raw = JSON.parse(await readFile(file, "utf8")); }
    catch { errored++; continue; }

    const rec = toRecord(relPath, raw);
    if (!rec) { skipped++; continue; }
    records.push(rec);

    tally(bySource, rec.source);
    if (rec.category) tally(byCategory, rec.category);
    if (rec.license) tally(licenses, rec.license);
    if (rec.has_ai) aiCount++;
    if (rec.is_rag) ragCount++;
    for (const i of rec.integrations) {
      tally(integrations, i);
      if (rec.category) {
        if (!intByCat.has(rec.category)) intByCat.set(rec.category, new Map());
        tally(intByCat.get(rec.category)!, i);
      }
    }
    for (const t of rec.trigger_type) tally(triggers, t);

    if (scanned % 2000 === 0) console.log(`  …${scanned} archivos`);
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, "catalog.json"), JSON.stringify(records));

  const stats = {
    generated_at: new Date().toISOString().slice(0, 10),
    totals: { scanned, ingested: records.length, skipped, errored },
    by_source: Object.fromEntries(bySource),
    ai: { has_ai: aiCount, is_rag: ragCount },
    top_categories: topN(byCategory, 40),
    top_integrations: topN(integrations, 60),
    trigger_channels: topN(triggers, 20),
    licenses: topN(licenses, 20),
    top_integrations_by_category: Object.fromEntries(
      [...intByCat.entries()].map(([cat, m]) => [cat, topN(m, 12)])
    ),
  };
  await writeFile(join(OUT_DIR, "stats.json"), JSON.stringify(stats, null, 2));

  console.log(`\n✓ Ingesta lista`);
  console.log(`  escaneados: ${scanned} · ingeridos: ${records.length} · sin datos: ${skipped} · JSON inválido: ${errored}`);
  console.log(`  por fuente:`, Object.fromEntries(bySource));
  console.log(`  con IA: ${aiCount} · con RAG: ${ragCount}`);
  console.log(`\n  Top 15 integraciones:`);
  for (const { value, count } of topN(integrations, 15)) console.log(`    ${String(count).padStart(5)}  ${value}`);
  console.log(`\n  Canales de entrada (trigger):`);
  for (const { value, count } of topN(triggers, 12)) console.log(`    ${String(count).padStart(5)}  ${value}`);
  console.log(`\n  → out/catalog.json y out/stats.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
