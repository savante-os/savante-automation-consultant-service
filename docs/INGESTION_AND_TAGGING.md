# 🏷️ Ingestion + Facet Tagging — Hybrid Retrieval (filter first, rank semantically)

> Details **Step 2** of the funnel described in
> [`SOLUTION_ARCHITECTURE.md`](SOLUTION_ARCHITECTURE.md): how deterministic facets are extracted
> from the corpus so the questionnaire can filter precisely and semantic retrieval is reduced to
> a ranker. Associated migration: [`migrations/003_facets.sql`](../migrations/003_facets.sql).

---

## 0. TL;DR — why facets and not embeddings alone

- The corpus carries **deterministic structural signal** (category, integrations, trigger, AI
  usage) that can be extracted without an LLM and without embeddings.
- **Hybrid retrieval:** filter on exact facets (`WHERE`) **first**, then use semantic similarity
  **only to order** the already-filtered subset.
- Result: the LLM chooses among ~10–30 candidates that **already satisfy** the hard filters,
  instead of the entire corpus. **Less hallucination, explainable recommendations, cheaper.**
- **Golden rule:** every filtering question in the questionnaire must map to an extractable
  facet. If it does not translate into a `WHERE` clause, it is not useful as a filter.

---

## 1. The evidence (what each source shape provides)

### Marketplace-style (`sales/`, `marketing/`, `support/`, `ai-rag/`, `document-ops/`, `multimodal-ai/`)
- `meta.category` + `meta.description` (About / How it works / Use Cases sections).
- Full **`nodes[].type`** → the exact integrations.

### Curated (`AI Summarization/`, `HR_and_Recruitment/`, `Gmail_and_Email_Automation/`, …)
- `meta.category`, `name`, **`nodes[].type`**. (`tags` arrives empty — we generate it.)

### Self-hosted (`self-hosted/<category>/`)
- Already tagged: `meta.category`, `license`, `stack`, `unmaintained`, and `workflow.tags[]`
  (`self-hosted`, `open-source`, license, stack, category). Nearly ready to use as-is.

### Node-type classes

Node types fall into four classes, and only two of them are useful as facets:

| Class | Examples | Use for facets |
|---|---|---|
| **Plumbing (noise)** | `stickyNote`, `httpRequest`, `code`, `set`, `if`, `wait`, `merge`, `splitInBatches`, `noOp` | **Exclude** from the `integrations` facet |
| **Apps (integrations)** | `googleSheets`, `gmail`, `telegram`, `slack`, `googleDrive`, `airtable`, `hubspot`, `notion`, `whatsApp`, `postgres`, `supabase`, `facebookGraphApi`, `emailSend` | → `integrations[]` |
| **Triggers (input channel)** | `scheduleTrigger`, `formTrigger`, `webhook`, `telegramTrigger`, `manualTrigger`, `chatTrigger`, `emailReadImap` | → `trigger_type[]` |
| **LangChain (AI/RAG)** | `agent`, `chainLlm`, `lmChat*`, `embeddings*`, `vectorStore*`, `textSplitter*`, `documentDefaultDataLoader` | → `has_ai`, `is_rag` |

> Plumbing nodes dominate by raw frequency, which is precisely why naively counting node types
> produces a useless "integrations" list. The blacklist below is what makes the facet meaningful.

---

## 2. The facets (controlled vocabulary)

Every workflow/software entry is ingested with these facets, alongside the `content` string used
for the embedding:

| Facet | Type | Where it comes from | Maps to question… |
|---|---|---|---|
| `category` | text | `meta.category` (normalized to the aisle vocabulary) | A2 niche / aisle |
| `integrations` | text[] | `nodes[].type` (apps, plumbing excluded) → friendly name | C1 current tools |
| `trigger_type` | text[] | `*Trigger` nodes → `{schedule, form, webhook, chat, email, telegram, manual}` | C2 input channel |
| `output_targets` | text[] | apps used as a destination (heuristic: app node after the trigger) | C3 where it ends up |
| `has_ai` | bool | any LangChain node present | "do you want AI?" |
| `is_rag` | bool | any `vectorStore*` / `embeddings*` node present | "knowledge base / RAG?" |
| `source` | text | ingestion-assigned source label | C4 self-hosted or not |
| `license` | text | self-hosted only | C4 / compliance |
| `stack` | text | self-hosted only | technical filter |
| `unmaintained` | bool | self-hosted only | exclude abandoned projects |

### Node-type → friendly-name mapping (excerpt)

Keep a versioned dictionary. Base rule: `n8n-nodes-base.<x>` → `<x>` capitalized, except for
plumbing (blacklist) and aliases (`facebookGraphApi` → Facebook, `lmChatOpenRouter` → OpenRouter).

```
BLACKLIST (plumbing — these are not integrations):
  stickyNote, httpRequest*, code, set, if, switch, wait, merge, splitInBatches, splitOut,
  filter, aggregate, noOp, limit, function, html, convertToFile, extractFromFile, dataTable,
  respondToWebhook, manualTrigger (counts as trigger=manual, not as an app)

  (*) httpRequest = "custom API" — weak signal, not listed as a concrete app.
```

---

## 3. Ingestion pipeline (idempotent)

For each file in the corpus:

1. **Parse** the JSON (marketplace / curated / self-hosted shape).
2. **Category:** normalize `meta.category` to the aisle vocabulary.
3. **Integrations:** extract `nodes[].type`, drop plumbing, map to friendly names, deduplicate
   → `integrations[]`.
4. **Triggers:** detect `*Trigger` nodes → `trigger_type[]`.
5. **AI/RAG:** set `has_ai` / `is_rag` from the presence of LangChain / vectorStore nodes.
6. **Tags:** union of `category + integrations + trigger_type + (has_ai?ai) + (is_rag?rag) + source`.
7. **content:** `name + description + integrations + tags` — the only thing that gets vectorized.
8. **Embed** `content` with **`gte-small` (384 dims)** — runs **locally without an API key** via
   Transformers.js, and is **built into Supabase Edge Functions** (`Supabase.ai`) for embedding
   the query. The same model on both sides means coherent similarity (see `migrations/004`).
9. **`upsert`** by `id` into `templates` (see `migrations/003` and `004` for columns/dims).

> **Why gte-small and not OpenAI:** the setup uses Supabase + OpenRouter, with no OpenAI key.
> gte-small is key-free on both sides. Tradeoff: lower quality than a large model, and it is
> EN-first (the corpus is mixed EN/ES). Future upgrade: a multilingual embeddings API (change
> the dims in `migrations/004` and reindex) if more precision is needed.

> Everything in steps 2–6 is **deterministic** (no LLM). The embedding in step 8 is the only
> probabilistic part, and it is used solely to order within the already-filtered subset.

---

## 4. Hybrid retrieval (how it is used at query time)

```sql
-- pseudo: filter on facets (hard) and rank by similarity (soft)
select *,
       1 - (embedding <=> :query_embedding) as similarity
from templates
where (:category     is null or category = :category)
  and (:integrations is null or integrations && :integrations)   -- array overlap
  and (:trigger      is null or trigger_type && :trigger)
  and (:is_rag       is null or is_rag = :is_rag)
  and (:source       is null or source = :source)
  and unmaintained is not true
order by embedding <=> :query_embedding
limit :match_count;
```

- If the facets return **many** candidates → the embedding orders them.
- If they return **few or none** → relax facets progressively (drop the least critical one)
  before falling back to pure semantic search. Never recommend outside the filter silently.
- The LLM (step 3 of the funnel) receives that **already-filtered** top-N → less room for error.

The `match_templates_faceted` function in
[`migrations/003_facets.sql`](../migrations/003_facets.sql) implements this.

---

## 5. The golden rule for the questionnaire

> **Every filtering question must map to an extractable facet.**

If a question cannot be translated into a `WHERE` over the facets in §2, then either:

- rewrite it so that it can (prefer closed options — that is, facet values), or
- demote it to "enriches the lead / feeds the semantic text only", not a filter.

This closes the loop: the questionnaire design derives from the facets the corpus actually has,
not the other way around. See the question → facet mapping in
[`INTAKE_QUESTIONNAIRE.md`](INTAKE_QUESTIONNAIRE.md) §1–2.

---

## 6. Study the corpus before finalizing the questionnaire (data-driven)

Before freezing the options for each question, run these explorations over **your own** corpus so
that the select **values** are the ones that actually exist, and that have volume behind them:

| Questionnaire question | Exploratory query over the corpus | Purpose |
|---|---|---|
| C1 tools (`integrations`) | top integrations by frequency and by category | offer only apps that are actually covered |
| C2 channel (`trigger_type`) | trigger distribution | know which channels have real solutions |
| A2 niche (`category`) | count per category/aisle | prioritize aisles with a deep catalog |
| AI / RAG | share of workflows with `has_ai` / `is_rag` | decide whether it deserves a headline question |
| self-hosted | `license` / `stack` / `unmaintained` | compliance filters, and discarding abandoned projects |

`npm run ingest` writes `out/stats.json` with exactly this census for the corpus you point it at.

> Principle: **do not offer a filter you have no inventory for.** If almost no workflows use a
> given integration, that option should not be in the select (or should be marked "on request").
