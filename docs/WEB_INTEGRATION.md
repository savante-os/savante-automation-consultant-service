# 🔌 Recommendation Service — Product Documentation + Web Integration

> Reference document for **embedding the service in a website** and finishing the integration.
> It covers the full functionality: what it does for the user (product) and how it works
> internally (technical). It does not cover UI design — it describes the functionality the
> frontend is built on top of.
>
> It complements, and does not replace: [`SOLUTION_ARCHITECTURE.md`](SOLUTION_ARCHITECTURE.md)
> (the "why"), [`INTAKE_QUESTIONNAIRE.md`](INTAKE_QUESTIONNAIRE.md) (the questionnaire), and
> [`INGESTION_AND_TAGGING.md`](INGESTION_AND_TAGGING.md) (the facets).

---

## 1. What it is (TL;DR)

An **automation recommendation engine** that turns a business questionnaire into a
**personalized plan with a quote**, delivered by email, leaving the user one click away from
**booking a call**. Each run **captures a qualified lead**.

```
┌──────────────┐   ┌──────────────────┐   ┌────────────────────┐   ┌──────────────┐   ┌───────────┐
│ 1. INTAKE    │   │ 2. RETRIEVAL     │   │ 3. SYNTHESIS (LLM) │   │ 4. PERSIST   │   │ 5. DELIVER│
│ Structured   │──▶│ Hybrid retrieval │──▶│ DeepSeek/OpenRouter│──▶│ Supabase     │──▶│ Email +   │
│ questionnaire│   │ (facets+vector)  │   │ structured JSON    │   │ lead + reco  │   │ booking   │
└──────────────┘   └──────────────────┘   └────────────────────┘   └──────────────┘   └───────────┘
       │                                                                                     │
       └──────────── the lead is saved from step 1; the email is the deliverable ────────────┘
```

**Key UX point:** the result is **not shown on screen** — it is **sent by email**. The page shows
only an acknowledgment: *"Done, we sent your plan to [email]"*.

---

## 2. Product experience (what the web app has to build)

### 2.1 Step 1 — Structured questionnaire

A guided form (NOT free-form chat), in business language. Every answer maps to a `leads` column
and/or feeds retrieval. Canonical detail in
[`INTAKE_QUESTIONNAIRE.md`](INTAKE_QUESTIONNAIRE.md). Field summary:

| Block | Fields | Role |
|---|---|---|
| **A — Identity** | `company`, `niche`, `country`, `city`, `team_size`, `contact_name`, `email` | Creates the lead |
| **B — Pain** | `pain_primary`, `pain_volume`, `pain_time_each`, `pain_cost`, `pain_secondary` | **Retrieval query text** (B1+B5) + ROI/tier (B2–B4) |
| **C — Technical** | `current_tools`, `input_channels`, `output_targets`, `hosting_pref`, `wants_ai` | **Hard facet filter** (the bulk of the matching) |
| **D — Commercial** | `urgency`, `budget_band`, `decision_role` | Prioritizes the lead + anchors the price |
| **E — Close** | `email`, `contact_name`, `company`, `consent` | Delivery address for the plan |

**Important for the frontend — select options:** the values of the Block C multi-selects
(`current_tools`, `input_channels`, …) **must come from the real corpus**, not be invented.
Ingestion writes `out/stats.json` with the top integrations, channels, and categories that
actually exist **in your corpus**; the frontend should read from there. Rule: **do not offer a
filter with no inventory behind it.**

**Minimum fields for a usable lead:** `company` · `niche` · `country` · `email` ·
`pain_primary` · `pain_volume` · `current_tools` · `budget_band` · `urgency`.

**Progressive saving:** the lead can be created as soon as there is a contact + niche (Block A);
the rest enriches it. The current edge function creates it in a single call at the end (see §4).

### 2.2 Step 2 — Acknowledgment screen

After submitting the questionnaire, the page shows only: *"Done, we sent your plan to [email]"*.
The edge function responds `{ ok: true, message: "Te enviamos tu plan a <email>" }`.

### 2.3 Step 3 — The email is the deliverable

The plan is delivered as an HTML email (`renderEmailHtml` in
[`../service/src/email.ts`](../service/src/email.ts)). Structure:

1. **Diagnosis** (the LLM's `summary`) — the bottleneck in 2–3 sentences.
2. **Recommended automations** — each with its "why" and a discreet
   *"(see reference flow)"* link to the workflow template.
3. **Suggested open-source software** (where applicable).
4. **Proposed architecture** (`suggested_stack`).
5. **Preliminary estimate** — complexity, time, setup, and care plan. Explicitly labeled as an
   *estimate*: the final proposal is given on the call (no discount is promised; the number can
   go up depending on scope).
6. **Booking CTA** — the configured `BOOKING_URL` link (see §8).

### 2.4 Step 4 — The call

The CTA leads to a 45-minute booking event on the owner's calendar. The booking asks for **only**
name + email (required) and phone (optional) — everything else is already in the intake and is
matched by email. Company, pain, budget, etc. are not asked again.

### 2.5 Per-lead quota

`leads.free_credits_used` and a global counter are the intended hook for per-lead quota
enforcement (not implemented).

---

## 3. Technical architecture

| Component | Technology | Where |
|---|---|---|
| **Web endpoint** | Supabase Edge Function (Deno) | [`../service/supabase/functions/recommend/index.ts`](../service/supabase/functions/recommend/index.ts) |
| **DB + vectors** | Supabase Postgres + pgvector | your own Supabase project |
| **Template/software index** | `templates` table + `match_templates_faceted` RPC | migrations 001/003/004 |
| **Leads + recommendations** | `leads`, `recommendations` tables | migration 002 |
| **Embeddings** | gte-small (384-dim) | local: Transformers.js · query: `Supabase.ai` (no key) |
| **Synthesis LLM** | DeepSeek via OpenRouter | one API, swappable model |
| **Email** | Resend (HTTP API) | same module in Node and Deno |
| **Frontend** | your site (interactive island) | to build; POSTs the intake to the endpoint |

**Why these choices** (summary): retrieval and not fine-tuning → it gives **real citations** (the
exact template that gets deployed, which justifies the price). **Hybrid** retrieval (facets
first, semantic second) → the hard filter lowers the error rate; the embedding only orders the
subset. The same gte-small model at ingestion and query time → coherent similarity without an
OpenAI key.

---

## 4. API contract (the `recommend` edge function)

What the frontend consumes. It is the flow from §2.1, integrated into a single POST.

**Endpoint:** `POST {SUPABASE_URL}/functions/v1/recommend`
**CORS:** `ALLOWED_ORIGIN` (defaults to `*` — restrict it in production), methods
`POST, OPTIONS`, headers `authorization, content-type`.

> ⚠️ **The endpoint has no authentication and no rate limiting.** It runs with the service role
> key, calls a paid LLM, and sends mail to a caller-supplied address. Add both before deploying —
> see the warning block at the top of the function.

**Request body (JSON)** — `Intake` shape:

```jsonc
{
  "company": "Talento Norte Staffing",   // required
  "email": "mariana@example.com",        // required
  "pain_primary": "We process hundreds of CVs by hand...",
  "niche": "recruiting",
  "city": "Monterrey",
  "team_size": "12",
  "contact_name": "Mariana",
  "current_tools": ["Gmail", "Google Sheets"],   // -> integrations filter
  "input_channels": ["email"],                    // -> trigger_type filter
  "wants_ai": "ia",                               // ninguna | ia | rag -> is_rag/has_ai filter
  "budget_band": "600-1200",
  "urgency": "ya"
}
```

> Minimum endpoint validation: `company` and `email` are mandatory → `400` if missing.
> The full intake shape (all blocks) is in [`../service/src/intake.ts`](../service/src/intake.ts).

**What it does internally (in order):**

1. Inserts the `lead` (with `source: "web"`).
2. Builds the query text and embeds it with gte-small (`Supabase.ai`, no key).
3. `match_templates_faceted(...)` → 12 workflows (filtered by tools/channels/RAG) + 6 software
   entries (`source='self-hosted'`).
4. Synthesis with DeepSeek (it may only cite candidates from retrieval).
5. Persists the `recommendation` (with `matched_template_ids` for traceability).
6. Sends the email with the plan.

**Response (200):** `{ "ok": true, "message": "Te enviamos tu plan a <email>" }`
**Errors:** `400` `{ "error": "Faltan company / email" }` · `500` `{ "error": "<detail>" }`

**Integration recommendation (frontend):** the form does a `fetch` POST with the intake; on
`ok:true` it shows the acknowledgment. Consider returning a `lead_id` if you later want to tie
the booking to the lead without relying on the email (not returned today — see §9).

---

## 5. Data model (Supabase)

### `templates` (indexed corpus — migrations 001 + 003 + 004)

Workflow templates **and** self-hosted software live in the same table; `source` distinguishes
them. Key columns: `id` (PK), `source`, `name`, `category`, `tags[]`, `integrations[]`,
`trigger_type[]`, `has_ai`, `is_rag`, `description`, `import_ref`, `popularity`, `content`,
`license`, `stack`, `unmaintained`, `embedding vector(384)`.
Indexes: HNSW on `embedding`; GIN on `integrations`/`trigger_type`/`tags` (for `&&` overlap).
RPC: `match_templates_faceted(query_embedding, match_count, filter_category, filter_integrations,
filter_trigger, filter_is_rag, filter_source, exclude_unmaintained)` → hard `WHERE` filter +
cosine-similarity ranking.

### `leads` (migration 002)

One record per intake (created even if the user does not finish). Fields = blocks A–D of the
questionnaire, plus funnel control: `free_credits_used`, `email_verified`, `status`
(`new|recommended|contacted|audit_paid|won|lost`), `source`. **There is no phone column** (the
optional booking phone lives on the calendar side, not in the intake).

> This table holds personal data and is protected by row level security with no policies
> (deny by default). See [`../migrations/002_leads.sql`](../migrations/002_leads.sql).

### `recommendations` (migration 002)

One record per engine run, linked to the `lead`. Stores the LLM JSON (`summary`,
`recommended_software`, `recommended_workflows`, `suggested_stack`, `complexity`,
`implementation_days`, `price_estimate`, `tier`), the `matched_template_ids` that grounded it,
`llm_model`, and `was_paid`.

---

## 6. The recommendation engine (detail)

### 6.1 Hybrid retrieval

Hard facet filter **first**, semantic ranking **second**. Block C builds the exact `WHERE`
(`integrations &&`, `trigger_type &&`, `is_rag`, `source`); Block B supplies the embedding that
orders the already-filtered subset. Reference validation: on a test corpus, a typical case
(email channel + one concrete integration + AI) collapses the candidate set by roughly two orders
of magnitude using facets alone. Local stand-in for the RPC:
[`../service/src/retrieve.ts`](../service/src/retrieve.ts).

### 6.2 Synthesis (anti-hallucination)

The LLM receives **only** the profile + the retrieval candidates, and returns **JSON** (not
prose). Prompt rules ([`../service/src/recommend.ts`](../service/src/recommend.ts)):

1. It may only recommend items from the provided lists (citing `import_ref`/`id`).
2. It never invents names.
3. The price must fall inside the grid.
4. If retrieval is not useful → it says so and sets `tier='Audit'`.
5. **The tier reflects the scope:** 1 automation → `Single Automation`; 3+ distinct ones (not
   variants) → `System`, priced accordingly (anti-underquoting).
6. It responds with JSON only, using the schema keys.

### 6.3 Pricing guardrails (single source of truth)

The grid lives in **one constant**, `PRICING`
([`../service/src/recommend.ts`](../service/src/recommend.ts)), from which both the prompt and
this document derive:

| Tier | Setup |
|---|---|
| Audit | USD 150–300 |
| Single Automation | USD 800–1500 |
| System | USD 2000–4000 |
| Care Plan | USD 150–400/month |

`normalizeRecommendation()` **snaps the price to the declared tier's grid** after synthesis, no
matter what the LLM's arithmetic did. Covered by tests (`npm test`,
[`../service/test/`](../service/test)): price↔tier invariants and the email render.

---

## 7. Operations — data pipeline and deploy

The `data/` corpus is **not in Git** (nor is any index derived from it). To populate the index:

```bash
cd service
npm install
npm run ingest          # data/ -> out/catalog.json + out/stats.json (deterministic facets)
npm run embed           # local gte-small embeddings (no key)

# apply migrations 001 -> 004 in Supabase (CLI: supabase db push, or paste the SQL)
cp .env.example .env     # fill in SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
npm run load-supabase    # idempotent upsert of catalog + embeddings into templates

# deploy the endpoint and set secrets
supabase functions deploy recommend
supabase secrets set OPENROUTER_API_KEY=... RESEND_API_KEY=... MAIL_FROM="Savante <hello@example.com>"
```

Offline test of the full flow with no keys (mock + dry-run, writes the email to `out/`):
`npm run recommend`. With `OPENROUTER_API_KEY` it runs real synthesis; with `RESEND_API_KEY` and
`--send`, it actually sends.

---

## 8. Environment variables / secrets

| Variable | Where | What for |
|---|---|---|
| `SUPABASE_URL` | edge + scripts | project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | edge + `load-supabase` | write leads/recommendations, load templates |
| `OPENROUTER_API_KEY` | edge + synthesis | DeepSeek (without this key → local mock) |
| `RESEND_API_KEY` | edge + email | delivery (without this key → local dry-run) |
| `MAIL_FROM` | edge + email | sender (default `Savante <onboarding@resend.dev>`) |
| `BOOKING_URL` | edge + email | booking link used as the email CTA (default `https://cal.com/your-handle/intro`) |
| `ALLOWED_ORIGIN` | edge | CORS origin (default `*` — restrict it in production) |

> **Query** embeddings need no key (gte-small is built into `Supabase.ai`).
> **Ingestion** embeddings need none either (Transformers.js, local).

---

## 9. Current state and technical debt (read before go-live)

**`src/` ↔ edge function parity: up to date.** The edge function has received the local pipeline's
improvements (new grid, `normalizeRecommendation`, the tier↔scope rule, and the email with the
booking CTA + "preliminary estimate" + the template as "(see reference flow)"). Both sides share
the same pricing source.

> Maintenance reminder: `src/recommend.ts` and `src/email.ts` (Node) and
> `supabase/functions/recommend/index.ts` (Deno) are **two copies** of the same flow. When you
> change pricing, the prompt, or the email copy, **update both** (the edge function does not
> import from `src/`). After touching the endpoint you must **redeploy**:
> `supabase functions deploy recommend`.

**Functional gaps:**

- **Authentication and rate limiting** on the endpoint — see §4. This is the blocking one.
- **Per-lead quota** (§2.5): the edge function always runs the LLM and sends; the global counter +
  `free_credits_used` are missing.
- **`lead_id` in the response**: not returned today; useful for tying the booking to the lead
  without relying on the email (link with a query param).
- **Email verification** before counting the lead as valid (`email_verified`).

---

## 10. Web integration checklist

- [ ] **Migrations 001→004 applied** in Supabase and `templates` populated (§7).
- [ ] **Secrets set** on the edge function (§8) and `recommend` deployed.
- [ ] **Authentication + rate limiting** added to the endpoint (§4) — do not go live without this.
- [x] **`src/` ↔ edge function parity** (§9): grid, tier rule, `normalizeRecommendation`, new
      email. *(redeploy after touching it)*
- [ ] **Questionnaire form** with blocks A–E; Block C selects populated from `out/stats.json`
      (values that exist in the corpus).
- [ ] **POST to the endpoint** with the `Intake` shape; handle `400`/`500`; show the
      acknowledgment on `ok:true`.
- [ ] **Email CTA → booking** verified against the configured `BOOKING_URL`.
- [ ] **Booking form** with only name+email (required) and phone (optional); matched by email.
- [ ] (Optional) **`lead_id`** returned and propagated to the booking link.

---

### File map (quick reference)

```
docs/INTAKE_QUESTIONNAIRE.md     the questionnaire (blocks A–E, field by field)
docs/SOLUTION_ARCHITECTURE.md    architecture decisions (retrieval vs fine-tuning, the funnel)
docs/INGESTION_AND_TAGGING.md    how facets are extracted from the corpus
service/src/intake.ts            intake types + intake → facet mapping
service/src/retrieve.ts          facet retrieval (stand-in for the RPC)
service/src/recommend.ts         PRICING (single source), prompt, normalizeRecommendation, synthesis
service/src/email.ts             plan render + Resend delivery
service/src/facets.ts            node type → integrations/channels/AI/RAG
service/src/ingest-core.ts       parse one corpus file → record with facets
service/scripts/*.ts             ingest · embed · query · recommend · load-supabase
service/supabase/functions/recommend/index.ts   ENDPOINT called by the web (⚠ see §4 and §9)
service/test/*.test.ts           pricing invariant + email render tests
migrations/001..004              templates + leads/recos + facets + 384-dim embeddings
```
