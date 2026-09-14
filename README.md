# Savante Automation Consultant Service

An **automation recommendation engine**. It turns a structured business questionnaire into a
personalized automation plan: which workflows to build, which self-hosted software to run, a
suggested stack, a complexity/effort estimate, and a preliminary price range — delivered as an
HTML email.

The interesting part is the retrieval: it does **not** treat "find me the right workflow" as a
pure semantic search problem.

## How it works

```
Structured intake  ->  Facet filter  ->  Semantic rank  ->  Grounded synthesis  ->  Delivery
```

**1. Structured intake, not free-form chat.** A guided questionnaire in business language.
Every answer maps to a typed field — the tools already in use, input channels, hosting
preference, whether AI belongs in the loop. Free-form chat produces under-specified queries;
typed fields produce a query the retrieval layer can actually filter on.
See [`docs/INTAKE_QUESTIONNAIRE.md`](docs/INTAKE_QUESTIONNAIRE.md).

**2. Filter first, then rank semantically.** Every indexed item is tagged at ingestion time with
deterministic *facets* — integrations, trigger channel, category, hosting model, AI usage.
A query applies those facets as a hard SQL filter, and only then ranks the surviving rows by
vector similarity.

> This ordering is the core design decision. Semantic-only search will happily return a
> beautiful Salesforce workflow to someone who does not use Salesforce — it is *similar*, but
> it is not *applicable*. A facet filter cannot make that mistake. Embeddings decide **ordering
> within an already-valid candidate set**; they never decide validity.

Facets are computed deterministically from structure, not inferred by a model, so the same
input always yields the same tags and the filter stays auditable.
See [`docs/INGESTION_AND_TAGGING.md`](docs/INGESTION_AND_TAGGING.md).

**3. The model reasons, the index supplies the facts.** Synthesis is grounded in the rows that
survived retrieval, so every recommendation is traceable to a real indexed item rather than a
plausible-sounding invention. Pricing is snapped to a grid defined in code, so the quoted number
cannot drift from the declared tier — the model chooses the tier, the code chooses the number.

**4. Delivery.** The plan is rendered as an HTML email. The flow persists the intake and the
resulting recommendation, including the IDs of the rows that grounded it, for traceability.

Embeddings are `gte-small` (384-dim): Transformers.js locally for ingestion, and Supabase's
built-in `Supabase.ai` for query embeddings — no third-party embedding key required.

## Quickstart

The full pipeline runs offline, with no API keys — synthesis falls back to a deterministic mock
and the email is written to `out/` instead of being sent.

```bash
cd service
npm install
npm test           # unit tests for retrieval, pricing, and the email render
npm run recommend  # end-to-end on the sample intake in fixtures/, dry-run
```

To run it against your own index and Supabase project:

```bash
cd service
cp .env.example .env      # SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY, ...

npm run ingest            # build the catalog + deterministic facets
npm run embed             # local gte-small embeddings (no API key)

# apply migrations 001 -> 004 to your Supabase project (supabase db push, or paste the SQL)
npm run load-supabase     # idempotent upsert of catalog + embeddings into `templates`

supabase functions deploy recommend   # HTTP endpoint (read the security notes first)
```

## Repository layout

| Path | Description |
|------|-------------|
| `service/src/` | The engine: facet ingestion, faceted retrieval, synthesis, email render |
| `service/scripts/` | CLI entry points for ingest, embed, query, load, and recommend |
| `service/supabase/functions/recommend/` | Edge Function (Deno) exposing the flow over HTTP |
| `migrations/` | Postgres + pgvector schema: templates, facets, leads, embeddings |
| `docs/` | Architecture, ingestion/tagging, intake design, and web integration |

This repository contains the **engine only**. The corpus it indexes is held locally, is
gitignored, and is not published here — neither the workflow files themselves nor any catalog,
index, or manifest derived from them. Point the ingestion scripts at your own corpus.
See [`NOTICE`](NOTICE).

## Security / production notes

Read this before deploying anything.

- **The `recommend` edge function has no authentication and no rate limiting.** It runs with the
  Supabase **service role key**, calls a paid LLM via OpenRouter, and sends mail via Resend to a
  caller-supplied address. Deployed as-is it is an open relay for both LLM spend and outbound
  email. **Add authentication and rate limiting before deploying it.** See the warning block at
  the top of [`service/supabase/functions/recommend/index.ts`](service/supabase/functions/recommend/index.ts).
- **Restrict CORS.** `ALLOWED_ORIGIN` defaults to `*`. Set it to your site's origin.
- **Row level security is required on the lead tables.** `leads` and `recommendations` hold
  personal data (contact name, email, company, budget, urgency, decision role). Supabase exposes
  public tables through PostgREST, so without RLS the anon key can read every row.
  [`migrations/002_leads.sql`](migrations/002_leads.sql) enables RLS on both tables and
  intentionally defines **no policies** — deny by default. The edge function uses the service
  role key, which bypasses RLS. Do not add a permissive policy without deciding who may read them.
- **Never ship the service role key to a browser.** It is a server-side secret.

## Configuration

| Variable | Used by | Purpose |
|---|---|---|
| `SUPABASE_URL` | edge + scripts | Project URL (`https://<your-project-ref>.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | edge + `load-supabase` | Server-side writes; bypasses RLS |
| `OPENROUTER_API_KEY` | edge + synthesis | LLM synthesis (unset -> deterministic mock) |
| `RESEND_API_KEY` | edge + email | Email delivery (unset -> dry-run to `out/`) |
| `MAIL_FROM` | edge + email | Sender address |
| `BOOKING_URL` | edge + email | Booking link used as the email CTA |
| `ALLOWED_ORIGIN` | edge | CORS origin (defaults to `*` — restrict it) |

## Documentation

- [`docs/SOLUTION_ARCHITECTURE.md`](docs/SOLUTION_ARCHITECTURE.md) — why retrieval over fine-tuning, and the overall design
- [`docs/INGESTION_AND_TAGGING.md`](docs/INGESTION_AND_TAGGING.md) — deterministic facets + hybrid retrieval (filter-first, semantic-rank)
- [`docs/INTAKE_QUESTIONNAIRE.md`](docs/INTAKE_QUESTIONNAIRE.md) — the structured intake that feeds retrieval
- [`docs/WEB_INTEGRATION.md`](docs/WEB_INTEGRATION.md) — embedding the recommend API in a website

## License

[MIT](LICENSE). See [`NOTICE`](NOTICE) for what this repository does and does not include.
