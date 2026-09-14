/**
 * Load the faceted catalog + gte-small embeddings into Supabase `templates`
 * (migrations 001 + 003 + 004). Batched upsert by id (idempotent).
 *
 * Needs in .env:  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Prereqs:        npm run ingest && npm run embed
 *
 *   npm run load-supabase
 *   npm run load-supabase -- --no-embeddings   # facets only (semantic ranking disabled)
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import type { CatalogRecord } from "../src/ingest-core.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const OUT = resolve(HERE, "../out");

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("✗ Falta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env");
    process.exit(1);
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const raw: CatalogRecord[] = JSON.parse(await readFile(resolve(OUT, "catalog.json"), "utf8"));
  const catalog = [...new Map(raw.map((r) => [r.id, r])).values()];
  if (catalog.length < raw.length) {
    console.log(`  ${raw.length - catalog.length} duplicados omitidos (${catalog.length} únicos)`);
  }

  let embMap = new Map<string, number[]>();
  if (!process.argv.includes("--no-embeddings")) {
    try {
      const emb: { id: string; embedding: number[] }[] = JSON.parse(await readFile(resolve(OUT, "embeddings.json"), "utf8"));
      embMap = new Map(emb.map((e) => [e.id, e.embedding]));
      console.log(`  ${embMap.size} embeddings cargados`);
    } catch {
      console.warn("  ⚠ out/embeddings.json no encontrado — cargo sólo facetas (corré npm run embed)");
    }
  }

  const rows = catalog.map((r) => ({
    id: r.id, source: r.source, name: r.name, category: r.category,
    tags: r.tags, integrations: r.integrations, trigger_type: r.trigger_type,
    has_ai: r.has_ai, is_rag: r.is_rag, description: r.description,
    import_ref: r.import_ref ?? r.id, popularity: r.popularity, content: r.content,
    license: r.license, stack: r.stack, unmaintained: r.unmaintained,
    embedding: embMap.get(r.id) ?? null,
  }));

  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const { error } = await supabase.from("templates").upsert(slice, { onConflict: "id" });
    if (error) { console.error(`✗ batch ${i}: ${error.message}`); process.exit(1); }
    process.stdout.write(`\r  upsert ${Math.min(i + BATCH, rows.length)}/${rows.length}   `);
  }
  console.log(`\n✓ ${rows.length} registros en templates`);
}

main().catch((e) => { console.error(e); process.exit(1); });
