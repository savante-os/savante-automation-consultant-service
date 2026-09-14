/**
 * Embed the local catalog with gte-small (384-dim). No API key.
 * Reads out/catalog.json, writes out/embeddings.json = [{ id, embedding }].
 * Used by the semantic re-rank (local proof) and by load-supabase.ts.
 *
 *   npm run embed                 # all records
 *   npm run embed -- --limit 500  # quick subset for testing
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { embed } from "../src/embeddings.js";
import type { CatalogRecord } from "../src/ingest-core.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const OUT = resolve(HERE, "../out");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const catalog: CatalogRecord[] = JSON.parse(await readFile(resolve(OUT, "catalog.json"), "utf8"));
  const limit = arg("limit") ? Number(arg("limit")) : catalog.length;
  const records = catalog.slice(0, limit);
  const BATCH = 32;

  const result: { id: string; embedding: number[] }[] = [];
  const t0 = Date.now();
  for (let i = 0; i < records.length; i += BATCH) {
    const slice = records.slice(i, i + BATCH);
    const vecs = await embed(slice.map((r) => r.content.slice(0, 1200)));
    slice.forEach((r, j) => result.push({ id: r.id, embedding: vecs[j] }));
    if ((i / BATCH) % 10 === 0 || i + BATCH >= records.length) {
      const done = Math.min(i + BATCH, records.length);
      const rate = done / ((Date.now() - t0) / 1000);
      process.stdout.write(`\r  ${done}/${records.length}  (${rate.toFixed(0)}/s)   `);
    }
  }
  await writeFile(resolve(OUT, "embeddings.json"), JSON.stringify(result));
  console.log(`\n✓ ${result.length} embeddings (${EMBEDDING_NOTE}) → out/embeddings.json`);
}

const EMBEDDING_NOTE = "gte-small / 384d";
main().catch((e) => { console.error(e); process.exit(1); });
