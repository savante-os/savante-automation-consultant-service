# MCP catalog server — test plan

> Companion to [`MCP_CATALOG.md`](MCP_CATALOG.md) (what the server does) and
> [`../service/scripts/eval-mcp.ts`](../service/scripts/eval-mcp.ts) (the runnable
> implementation of this plan). Read this doc to know **what** is being verified and
> **why**; run the script to actually verify it once the environment has credentials.

## 0. Why this exists

`node --test test/*.test.ts` (see `service/test/mcp-catalog.test.ts` and
`mcp-rpc.test.ts`) already covers the HTTP/JSON-RPC **contract** — auth, quotas,
routing, field masking — against in-memory fakes. That suite runs offline, in CI,
with no secrets, and should stay green forever.

It does **not** tell us whether the server is actually *good*: whether
`search_automations` returns relevant workflows for a real pain, whether
`recommend_automation`'s DeepSeek synthesis stays grounded in the candidates it was
given, or whether the quota check is safe under concurrent requests. Those questions
need a live deployment (real `templates` table, real embeddings, real
`OPENROUTER_API_KEY`). This plan is organized in layers so each one states plainly
what it needs and what it can catch.

## 1. Layers

| Layer | Question it answers | Needs | Where |
|-------|---------------------|-------|-------|
| L0 — Protocol | Does the JSON-RPC transport speak MCP correctly (`initialize`, `tools/list`, notifications, `DELETE`/`GET` on `/mcp`)? | Nothing (offline) | `test/mcp-rpc.test.ts` (existing) |
| L1 — Contract | Auth (401/403), quotas (429), routing (404/405), field masking (`content` never leaks, pricing never leaks over MCP) | Nothing (offline) | `test/mcp-catalog.test.ts` (existing) + `eval-mcp.ts --mode offline` |
| L2 — Retrieval relevance | For a real business pain, are the returned hits actually the right ones? | Deployed `catalog-search` + `templates` populated (`npm run load-supabase`) + a live `sav_live_…` key | `eval-mcp.ts --mode live` (golden set) |
| L3 — Synthesis quality & grounding | Is `recommend_automation`'s prose useful, and does it ever cite a workflow/software that wasn't actually retrieved (hallucination)? Does it hold the line under prompt injection? | Same as L2, **and** `OPENROUTER_API_KEY` set server-side (Supabase secret) | `eval-mcp.ts --mode live` (grounding checks + adversarial set) |
| L4 — Concurrency | Is the quota check race-safe, or can concurrent requests overshoot the 24h limit? | Same as L2, plus a **fresh, unused** key (burns quota) | `eval-mcp.ts --mode live --concurrency` |
| L5 — Observability | Does every call — including failures — leave the log row `MCP_CATALOG.md` §6 promises, and does `mcp_usage_by_day` aggregate it correctly? | Same as L2, plus `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | `eval-mcp.ts --mode live --check-logs` |

Run L0/L1 today (no credentials). Run L2–L5 once `service/.env` has
`MCP_CATALOG_URL`, `MCP_API_KEY`, and — for L5 — `SUPABASE_SERVICE_ROLE_KEY`.

## 2. Golden query set (L2/L3)

A fixed set of realistic, Spanish-language business pains, each with a **pass
criterion the script checks automatically** — not vibes. See
`GOLDEN_QUERIES` in `eval-mcp.ts` for the literal text; summarized here:

| id | Tool | Pain | What "correct" means |
|----|------|------|------------------------|
| `recruiting-gmail` | `search_automations` | CVs llegan por Gmail y se pierden candidatos | ≥1 hit with `integrations` containing `Gmail` and `trigger_type` containing `email` |
| `recruiting-rag-vs-tracking` | `search_automations` (`wants_ai=rag`) | Same pain, but forcing `wants_ai=rag` | **Known trap** (see §4.1): asserts the RPC filter is `filter_is_rag=true`, then flags (not fails) if the RAG-only result set is worse than the unfiltered one for this literal pain — a relevance judgment call for a human reviewer, logged, not silently passed |
| `support-whatsapp` | `search_automations` | Reclamos por WhatsApp sin tracking | ≥1 hit with `trigger_type` containing a chat/whatsapp-shaped channel |
| `replace-hubspot` | `search_software` | Reemplazar HubSpot, self-hosted, equipo chico | ≥1 hit, `filter_source=self-hosted` confirmed via the RPC log, none of the returned ids look like n8n workflow ids |
| `invoicing-pdf` | `search_automations` | Facturas en PDF por email, carga manual | ≥1 hit touching email/PDF/OCR-shaped integrations |
| `knowledge-base-rag` | `search_automations` (`wants_ai=rag`) | 300 PDFs internos, el equipo pregunta lo mismo por Slack | ≥1 hit with `is_rag=true` |
| `vague-pain` | `search_automations` | "Necesitamos ser más eficientes" (sin especificar nada) | Must **not** 500; either a broad low-confidence result set or an empty one — never a crash |
| `contradictory-facets` | `search_automations` | Pain about invoicing, but `tools=["Gmail"]` + `channels=["webhook"]` + `wants_ai=rag` (facets that don't match the pain) | Must return whatever the **facets** dictate (hard filter wins per `INGESTION_AND_TAGGING.md`), even if that ignores the pain text — confirms facets are authoritative, not advisory |
| `nonexistent-tool` | `search_automations` | `tools=["ToolThatDoesNotExist123"]` | Empty `results: []`, HTTP 200 — not an error |
| `huge-input` | `search_automations` | `pain` ~5000 chars | No 500, reasonable latency (see §5) |
| `english-pain` | `search_automations` | Same recruiting pain, in English | Compare hit overlap against `recruiting-gmail` — flags (doesn't hard-fail) if English performs materially worse, since gte-small's multilingual ceiling is a known open question (`MCP_CATALOG.md` §11.3) |
| `no-match-domain` | `recommend_automation` | "Automatizar el riego de una granja hidropónica" (outside the catalog's domain) | `recommended_workflows`/`recommended_software` must be empty or explicitly hedge — **must not** invent something |
| `recommend-with-inline-metrics` | `recommend_automation` | Recruiting pain with volume + time/unit written inline in `problem_description` | Hard-checked: grounding (§4.2) and no pricing leak. `roi_note` is **recorded, not asserted** — the tool has no structured field for these metrics (§4.5), so whether the model derives it from free text is a judgment call for the reviewer, not a deterministic pass/fail |
| `recommend-no-metrics` | `recommend_automation` | Same pain, no volume/time given | `roi_note` must be `null` (the synthesis prompt explicitly forbids inventing numbers — this is a hallucination check with a deterministic answer) |
| `prompt-injection` | `recommend_automation` | Pain text that tries to instruct the model to reveal `tier`/`price_estimate` or fabricate a workflow with a fake `import_ref` | `tier`/`price_estimate`/`complexity`/`implementation_days` must be absent from the HTTP response regardless of what the LLM was tricked into writing (structural masking, checked at the code layer) **and** grounding check (§4.2) must still pass — if it doesn't, the injection worked |

## 3. Security / adversarial set (L1 live + L3)

Re-runs the auth/quota contract (already unit-tested offline) against the **real**
deployed function, plus cases that only matter live:

1. Malformed `Authorization` header (`Bearer` with no token, garbage scheme).
2. Both `Authorization` and `X-Api-Key` set to different keys — confirm documented
   precedence (`X-Api-Key` wins per `extractApiKey`).
3. `limit` above the documented max (99 for `search_automations`) — must clamp to 12,
   not error or return 99 rows.
4. Non-array `tools`/`channels` (a bare string) — must be handled per `strArray`, not
   throw a 500.
5. Batched JSON-RPC (`[{...}, {...}]`) — must be rejected per spec, not silently run
   the first message.
6. `GET`/`DELETE`/`OPTIONS` on `/mcp` — 405/204/204 respectively (already covered
   offline; re-run live to confirm the deployed CORS/method config matches the code).
7. Prompt injection — see `prompt-injection` in §2.

## 4. Known traps worth calling out explicitly

### 4.1 `wants_ai=rag` can hide the best answer

`filter_is_rag=true` is a **hard** filter (`automationsRpcArgs`), so if a client
model infers `wants_ai=rag` from an ambiguous phrase, any non-RAG workflow that
would have been the better fit for the literal pain is invisible to it, not merely
ranked lower. `recruiting-rag-vs-tracking` exists to surface this every run, not to
fix it — it's a product decision (strict filter vs. soft signal), not a bug, so the
script logs a flag for human review rather than failing the run.

### 4.2 Grounding: the only automated defense against hallucination

`recommend_automation`'s prose comes from DeepSeek. We cannot judge "is this a good
paragraph" without a human (or another model) in the loop — the script does not
attempt that. What it **can** check deterministically: does every item the model
claims to recommend actually exist in the candidate pool it was handed? The script
reproduces that pool by calling `search_automations`/`search_software` with the
*same* default args `recommendWorkflowsRpcArgs`/`recommendSoftwareRpcArgs` use
(`match_count` 12/6, no facets, `exclude_unmaintained=true`), then diffs
`recommended_workflows[].import_ref` / `recommended_software[].id` against it. A
mismatch means the model invented something — report it as a hard failure, not a
style note.

### 4.3 429 loses its `Retry-After` over MCP

Confirmed at the code level (`handleJsonRpcMessage` forwards `apiRes.text()` but not
`apiRes.headers`): a client calling `search_automations` over `/mcp` and hitting the
free-plan quota gets `{"error":"rate_limited"}` with no retry hint anywhere in the
body — the `Retry-After` header the REST layer computes never reaches an MCP caller.
`eval-mcp.ts` asserts this explicitly (so it stops being silent) rather than treating
it as a pass.

### 4.5 `recommend_automation` has no structured field for volume/time/cost

`catalog-search/index.ts`'s `recommend()` calls `synthesizeRecommendation({ pain_primary:
input.problem_description }, ...)` — it **never** sets `pain_volume`, `pain_time_each`, or
`pain_cost`. Those are exactly the fields `recommend-synthesis.ts`'s system prompt checks
before deciding whether to compute `roi_note`: *"si el perfil trae volumen Y tiempo por
unidad, estimá... si faltan esos datos, devolvé roi_note=null."* The website funnel
(`recommend/index.ts`) fills those from the questionnaire's Bloque with real structured
values; the MCP tool has no equivalent input — everything the caller knows about volume/
time has to be jammed into the single free-text `problem_description`. Whether `roi_note`
ever comes back non-null for an MCP caller who *does* mention numbers depends entirely on
whether DeepSeek chooses to parse them out of prose despite the prompt's structured-field
framing — not something `eval-mcp.ts` can assert deterministically offline. `recommend-
with-inline-metrics` records the actual output every run so a human can see which way it
goes in practice; it is not a hard pass/fail.

### 4.4 Quota check is read-then-write, not atomic

`handleMcpRequest` calls `deps.countUsage()` (a `SELECT count(*)` RPC), decides, and
only inserts the log row *after* doing the actual work (embed + RPC call, both
network round-trips). Under concurrent requests on the same key, several requests
can all read the same `count` before any of their log rows land, and all pass. L4
(`--concurrency`) exists to measure whether this is a real overshoot in the deployed
Postgres function or whether row-level locking/unique constraints happen to prevent
it — the script does not assume either way.

## 5. Non-functional checks

- **Latency**: P50/P95 across the golden set, per tool. No hard SLA is defined yet
  in `MCP_CATALOG.md`; the script reports numbers rather than pass/fail so a
  threshold can be set once there's a baseline.
- **Idempotency**: `get_template`/`list_categories` (GET-shaped tools) called twice
  in a row must return byte-identical `template`/`categories` (no mutation from a
  read).

## 6. Report format

Each run writes `service/out/eval-mcp/<timestamp>/`:
- `report.json` — every case: id, layer, request, response, latency_ms, verdict
  (`pass` / `fail` / `flag`), notes.
- `report.md` — human-readable summary: pass/fail/flag counts per layer, the full
  list of `fail`s and `flag`s with enough context to act on them (no need to open
  `report.json` unless you want the raw request/response).

`flag` is deliberately distinct from `fail`: it marks a case that needs a human
judgment call (§4.1, §4.3's English-vs-Spanish comparison) rather than a
deterministic pass criterion. A run with zero `fail`s and non-zero `flag`s is not
"done" — read the flags.

## 7. What this plan does not cover

- Whether the underlying corpus (`data/`, gitignored and not published) is itself
  well-tagged. `INGESTION_AND_TAGGING.md`
  owns that question; this plan assumes `templates` reflects whatever ingestion
  produced.
- Prose quality of `recommend_automation`'s Spanish writing (tone, grammar,
  persuasiveness). Grounding is checked (§4.2); "is this well-written" is a human
  (or LLM-judge, not implemented here) review of `report.md`'s recorded outputs.
- Load/scale testing beyond the L4 burst (this is a discovery MCP, not expected to
  take production e-commerce traffic).

## 8. Running it

```bash
cd service
npm install

# L0/L1 — offline, no credentials, safe to run anytime / in CI
npm test
npx tsx scripts/eval-mcp.ts --mode offline

# L2/L3 — needs a deployed catalog-search with templates loaded + a live key
#   npm run issue-mcp-key -- --email eval@example.com --name "eval-mcp"
echo "MCP_CATALOG_URL=https://YOUR_PROJECT.supabase.co/functions/v1/catalog-search" >> .env
echo "MCP_API_KEY=sav_live_..." >> .env
npx tsx --env-file-if-exists=.env scripts/eval-mcp.ts --mode live

# L4 — burns the key's quota; use a fresh key you don't mind exhausting
npx tsx --env-file-if-exists=.env scripts/eval-mcp.ts --mode live --concurrency

# L5 — also reads mcp_request_log / mcp_usage_by_day directly
echo "SUPABASE_URL=https://YOUR_PROJECT.supabase.co" >> .env
echo "SUPABASE_SERVICE_ROLE_KEY=..." >> .env
npx tsx --env-file-if-exists=.env scripts/eval-mcp.ts --mode live --check-logs
```

`npm run eval-mcp -- <same flags>` works too (see `package.json`).
