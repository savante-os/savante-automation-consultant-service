# 🏗️ Solution Architecture — Recommendation Engine + Lead Funnel

> The technical "how" connecting the local corpus to the recommendation engine and the
> intake → retrieval → quote funnel.
> It answers the underlying question: **train a model, do retrieval, or ask structured questions?**

---

## 0. TL;DR — the decision

- **No training / no fine-tuning.** The corpus changes often (new workflows and software),
  fine-tuning teaches style rather than facts, and it hallucinates exact template names. It
  destroys precision exactly where you need it in order to quote a price.
- **Yes to retrieval** over the existing corpus (`templates` + `match_templates` already exist in
  [`migrations/001_templates.sql`](../migrations/001_templates.sql)), because it yields **real
  citations**: you can show the concrete workflow/software you would deploy. That justifies the
  price.
- **The three ideas are one funnel, not alternatives:**
  `Structured questions → retrieval → LLM synthesizes recommendation + quote → lead DB`.
- **LLM:** DeepSeek via OpenRouter. `leads.free_credits_used` and a global counter are the
  intended hook for per-lead quota enforcement (not implemented).

---

## 1. Why retrieval and not a trained model

| Criterion | Fine-tuning / trained model | Retrieval (chosen) |
|---|---|---|
| **Changing data** | Retrain for every new workflow/software (expensive, slow) | Reindex one record and you are done |
| **Factual precision** | Hallucinates template and integration names | Returns the real template, with its `import_ref` |
| **Citability** | Cannot "show" what it would deploy | Cites the exact workflow/software → justifies the quote |
| **Upfront cost** | High (dataset + training + eval) | Low (embeddings + one LLM behind an API) |
| **Commercial risk** | Unverifiable recommendations | Recommendation traceable to an actual corpus item |

> Rule: **the LLM reasons, the corpus supplies the facts.** The LLM never invents the catalog;
> it only selects from, and explains, what retrieval returned.

> **Important:** retrieval here is not purely semantic. It is **hybrid — facet filter first,
> semantic ranking second** (see [`INGESTION_AND_TAGGING.md`](INGESTION_AND_TAGGING.md)).
> The filtering questions do most of the work through exact `WHERE` clauses; the embedding only
> orders the already-filtered subset. That is what minimizes the margin of error.

---

## 2. The three ideas, unified into one funnel

What looks like three competing options is really four stages of a single flow:

```
┌─────────────────────┐   ┌──────────────────┐   ┌─────────────────────┐   ┌──────────────┐
│ 1. INTAKE           │   │ 2. RETRIEVAL     │   │ 3. SYNTHESIS (LLM)  │   │ 4. LEAD DB   │
│ Structured          │──▶│ Retrieval over   │──▶│ DeepSeek/OpenRouter │──▶│ Supabase     │
│ questions           │   │ the corpus       │   │ recommendation +    │   │ lead +       │
│ (profile = lead)    │   │ (pgvector)       │   │ quote + stack       │   │ recommendation│
└─────────────────────┘   └──────────────────┘   └─────────────────────┘   └──────────────┘
        │                                                                          │
        └──────────── the whole intake is stored as a lead from step 1 ────────────┘
```

- **Structured questions** (instead of free-form chat) → they guide a non-technical person,
  guarantee that every business field is captured, and **each answer is lead data**.
  See [`INTAKE_QUESTIONNAIRE.md`](INTAKE_QUESTIONNAIRE.md).
- **Retrieval** → translates a business problem (not keywords) into workflows + self-hosted
  software.
- **LLM** → assembles the readable proposal: what to automate, with which stack, how long, how
  complex, and an estimated price (anchored to the `PRICING` grid in code).
- **Lead DB** → a record of the intake with its problem, suggested stack, and quote.

---

## 3. Components and stack

| Component | Technology | Notes |
|---|---|---|
| **Database + vectors** | Supabase Postgres + pgvector | Set `SUPABASE_URL` to your own project |
| **Template index** | `templates` table + `match_templates` RPC | [`migrations/001_templates.sql`](../migrations/001_templates.sql) |
| **Facets + hybrid retrieval** | facet columns + `match_templates_faceted` | [`migrations/003_facets.sql`](../migrations/003_facets.sql) · [`INGESTION_AND_TAGGING.md`](INGESTION_AND_TAGGING.md) |
| **Software index** | same `templates` table, distinguished by `source` | produced by ingestion from the local corpus |
| **Leads + recommendations** | `leads`, `recommendations` tables | [`migrations/002_leads.sql`](../migrations/002_leads.sql) |
| **Embeddings** | `gte-small` (384 dims) | key-free: Transformers.js locally, `Supabase.ai` for queries — see [`migrations/004_embeddings_gte_small.sql`](../migrations/004_embeddings_gte_small.sql) |
| **Synthesis LLM** | DeepSeek via **OpenRouter** | cheap; the model is swappable |
| **Orchestration** | n8n (self-hosted) | the same engine the recommendations target |
| **Frontend** | web form | structured questions + acknowledgment screen |

> **Why OpenRouter:** a single API for switching models/providers without rewriting anything.
> You can start on DeepSeek (negligible cost) and move to a stronger model without touching the
> architecture.

> **Note on embedding dimensions:** migration `001` originally provisioned `vector(1536)` for an
> OpenAI model. Migration `004` switches the column to 384 dims for `gte-small`. If you prefer a
> different model, change the dims in `004` and reindex — both sides must use the same model, or
> similarity scores are meaningless.

---

## 4. The flow in detail

### Step 1 — Structured intake

The person answers a guided questionnaire (not a chat). A record is created in `leads`
**immediately**, even if they do not finish. Key fields: niche, size, current tools, the primary
pain, manual-process volume, approximate budget, contact.
→ Full detail in [`INTAKE_QUESTIONNAIRE.md`](INTAKE_QUESTIONNAIRE.md).

### Step 2 — Retrieval (hybrid: filter first, semantic second)

1. The structured answers (Block C) build the **hard facet filter**
   (`category`, `integrations`, `trigger_type`, `is_rag`, `source`).
2. The pain (Block B) is turned into a query string and embedded.
3. `match_templates_faceted(...)` filters by facets **and** ranks by similarity → a top-N of
   candidates that **already satisfy** the exact filters (nothing is selected by embedding alone).

> This lowers the margin of error: the LLM chooses among ~10–30 filtered candidates rather than
> the whole corpus. Facet and ingestion detail in
> [`INGESTION_AND_TAGGING.md`](INGESTION_AND_TAGGING.md).
> Function: [`migrations/003_facets.sql`](../migrations/003_facets.sql).

### Step 3 — LLM synthesis

The LLM (DeepSeek/OpenRouter) receives **only** the business profile plus the retrieval results,
and must return **structured JSON**, not free prose:

```jsonc
{
  "summary": "2-3 sentence diagnosis of the bottleneck",
  "recommended_software": [{ "id": "...", "name": "...", "why": "..." }],
  "recommended_workflows": [{ "import_ref": "...", "name": "...", "why": "..." }],
  "suggested_stack": "Proposed architecture in one paragraph",
  "complexity": "Baja | Media | Alta",
  "implementation_days": 3,
  "price_estimate": { "setup_usd": [600, 1200], "care_plan_usd_mo": [150, 400] },
  "tier": "Audit | Single Automation | System"
}
```

**Prompt rules (anti-hallucination):**

- It may only recommend items present in the retrieval context (citing `id` / `import_ref`).
- The price must fall inside the grid defined in code (`PRICING` in `service/src/recommend.ts`).
- If retrieval returns nothing relevant, it says so and offers a call — it does not invent.

### Step 4 — Persistence and delivery

- The recommendation is stored in `recommendations`, linked to the `lead`.
- The plan is delivered to the user by email; the page shows only an acknowledgment.
- A follow-up workflow can be triggered on the lead (outside this repository).

---

## 5. Per-lead quota

`leads.free_credits_used` and a global counter are the intended hook for per-lead quota
enforcement (not implemented).

---

## 6. Why structured questions and not an open retrieval chat

| Free-form retrieval chat | Structured questions (chosen) |
|---|---|
| A non-technical user does not know what to ask | You guide them; you always get the data that matters |
| Incomplete / inconsistent lead data | Every answer is a clean, queryable field |
| Hard to quote (missing context) | You have volume, budget, tools → a precise quote |
| Expensive (many LLM calls per conversation) | 1 LLM call per recommendation → cheap, scales |

> Free-form chat can be added **later** as an advanced mode. The intake funnel itself should stay
> structured.

---

## 7. Corpus ingestion (how the index gets filled)

The local corpus is not in Git, and neither is any index derived from it. Ingestion pipeline:

1. Walk the local corpus and build the catalog (`out/catalog.json`).
2. For each item: build `content` (name + category + description + integrations).
3. Generate the embedding (`gte-small`, 384 dims — local, no API key).
4. `upsert` into `templates` (`source` distinguishes workflow templates from self-hosted software).
5. Reindex only what changed (idempotent by `id`).

Reference volumes and categories come from `out/stats.json`, which ingestion generates from
whichever corpus you point it at.

---

## 8. Implementation roadmap (MVP → product)

| Phase | Deliverable | Result |
|---|---|---|
| **MVP-0** | Ingest the corpus into `templates` (step 7) | Queryable retrieval |
| **MVP-1** | `002_leads.sql` migration + intake endpoint | Lead capture |
| **MVP-2** | Retrieval → LLM endpoint (structured JSON) + quota control | Recommendation with quota enforcement |
| **MVP-3** | Frontend (categories + search + results) | User experience |
| **MVP-4** | Follow-up workflow over the lead DB | Connected funnel |

---

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| LLM recommends something that does not exist | Prompt restricted to retrieval context + validate `id`/`import_ref` against the DB |
| LLM cost spikes | Global cap + per-lead rate limit + per-query cost logging |
| Quote out of line with the market | Force the price onto the `PRICING` grid in the prompt, and validate it in code |
| Junk leads inflate the DB | Email verification + a personalization field in the intake |
| Stale corpus | Periodic idempotent re-ingestion; carry the `unmaintained` flag through from the source data |
