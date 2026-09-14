/**
 * End-to-end: questionnaire intake -> faceted retrieval -> DeepSeek synthesis -> email.
 * Runs offline with mock + dry-run by default (no keys needed).
 *
 *   npm run recommend                                  # uses fixtures/intake.sample.json, mock + dry-run
 *   npm run recommend -- --intake path/to/intake.json  # custom intake
 *   npm run recommend -- --send                        # real send (needs RESEND_API_KEY)
 *   (with OPENROUTER_API_KEY in env, the real DeepSeek synthesis runs automatically)
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog, loadEmbeddings, facetedRetrieve, semanticRerank } from "../src/retrieve.js";
import { type Intake, workflowFilters, softwareFilters, queryText } from "../src/intake.js";
import { embedOne } from "../src/embeddings.js";
import { synthesize } from "../src/recommend.js";
import { renderEmailHtml, emailSubject, sendEmail } from "../src/email.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const OUT_DIR = resolve(HERE, "../out");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const intakePath = arg("intake") ?? resolve(HERE, "../fixtures/intake.sample.json");
  const intake: Intake = JSON.parse(await readFile(intakePath, "utf8"));
  if (!intake.email) throw new Error("El intake no tiene email (Bloque E1).");

  const catalog = await loadCatalog();
  const embMap = await loadEmbeddings();
  const semantic = embMap.size > 0 && !process.argv.includes("--no-semantic");

  // 1) faceted retrieval (hard filter first). With embeddings, rank the WHOLE filtered
  //    set by semantic similarity (mirrors match_templates_faceted in the edge fn) —
  //    not a popularity-truncated subset, or low-popularity best matches get dropped.
  const ALL = Number.MAX_SAFE_INTEGER;
  let workflows = facetedRetrieve(catalog, workflowFilters(intake), semantic ? ALL : 12);
  const shFilter = softwareFilters(intake);
  let software = shFilter ? facetedRetrieve(catalog, shFilter, semantic ? ALL : 6) : [];

  if (semantic) {
    const qVec = await embedOne(queryText(intake));
    workflows = semanticRerank(workflows, qVec, embMap, 12);
    software = semanticRerank(software, qVec, embMap, 6);
  }

  console.log(`Retrieval → ${workflows.length} workflows, ${software.length} software${semantic ? " (semantic rerank)" : " (facets only)"}`);
  console.log(`  top workflow: ${workflows[0]?.name ?? "—"}`);

  // 2) synthesis (DeepSeek via OpenRouter; mock if no key)
  const forceMock = process.argv.includes("--mock") || !process.env.OPENROUTER_API_KEY;
  const rec = await synthesize(intake, workflows, software, { mock: forceMock });
  console.log(`Síntesis → tier=${rec.tier}, ${rec.recommended_workflows.length} workflows recomendados${forceMock ? " (MOCK)" : ""}`);

  // 3) email
  const html = renderEmailHtml(intake, rec);
  const wantSend = process.argv.includes("--send");
  const result = await sendEmail(intake.email, emailSubject(intake), html, {
    dryRunDir: wantSend ? undefined : OUT_DIR,
  });

  if (result.via === "dry-run") {
    console.log(`Email (dry-run) → ${result.path ?? "(sin escribir)"}`);
    console.log(`  Para enviar de verdad: poné RESEND_API_KEY y corré con --send`);
  } else {
    console.log(`Email enviado a ${intake.email} vía Resend (id=${result.id})`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
