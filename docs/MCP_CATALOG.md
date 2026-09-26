# MCP catalog assistant — design and implementation

> Status: **Phase 1 + 2 implemented** (keyed HTTP API, OpenAPI, Streamable HTTP MCP
> on the same `catalog-search` function), now with 5 tools: `search_automations`,
> `search_software`, `get_template`, `list_categories`, `recommend_automation`
> (migration 006). **Phase 3 DB side in repo** (migration 007: `mcp_users.auth_user_id`,
> the `on_auth_user_created` trigger, and the four `create_own_api_key`/
> `revoke_own_api_key`/`list_own_api_keys`/`list_own_usage_by_day` RPCs). The
> signup/login/dashboard UI is part of the website frontend and is not in this repository.
> Prerequisite: `templates` must be loaded or search returns empty hits.
>
> Complements [`SOLUTION_ARCHITECTURE.md`](SOLUTION_ARCHITECTURE.md) (retrieval)
> and [`WEB_INTEGRATION.md`](WEB_INTEGRATION.md) (website funnel). This surface is
> a **hosted catalog MCP**, not a copy of the email / booking funnel.

---

## 0. TL;DR

People connect **their** Claude, ChatGPT, or Cursor to Savante. They ask in
plain language which automation they need. **Their** model does the talking;
**our** Supabase index (`templates` + `match_templates_faceted`) grounds the
answer in real n8n workflows and self-hosted software.

Every caller is a **real user in the database** (email + login). Each user
gets an **API key** for Cursor/Claude/GPT. MCP requests send the key, not
the password. The log stores `user_id` so we know who made which call.

Do **not** ship this as an anonymous public MCP. Do **not** put the Supabase
`service_role` key in anyone’s MCP config.

---

## 1. Problem

The website questionnaire is the right funnel for a quoted plan + lead + call.
Many operators already live in Cursor, Claude, or ChatGPT. They will not open
a form to ask “what should we automate?”

If those assistants answer from training data, they invent workflow names.
Savante already has the corpus and hybrid retrieval. An MCP (and a GPT Action
on the same HTTP API) is how that index shows up inside the tools people use.

---

## 2. Product experience

1. User **creates an account** on Savante (email + password, via Supabase Auth).
   That row is how we identify a person.
2. After login they get (or create) an API key `sav_live_…` and paste it into
   Cursor MCP settings, a Claude connector, or a Custom GPT Action
   (Bearer header). They never put email/password in MCP config.
3. They ask: *“We get CVs on Gmail, dump them in a sheet, and lose candidates.
   What should we automate?”*
4. The client model calls our tools. We return a **small set of real catalog
   hits** (id, name, integrations, short description, import_ref / URL).
5. Their model explains which automation fits. We do **not** run DeepSeek on
   every chat in v1.

Website vs MCP:

| Surface | Job |
|---------|-----|
| Web intake → `recommend` edge function | Lead + quoted plan + email + booking |
| MCP / GPT Actions | Discovery: “which automation exists for this pain?” |

Do not force MCP users through the email-wall on every search, or they will
not connect it. Optional later: `save_plan` with explicit consent.

---

## 3. Non-goals (v1)

- Full recommend JSON (tier, price grid, ROI copy) inside the MCP.
- Writing to `leads` / `recommendations` on every search.
- Returning full n8n workflow JSON (scrape bait). Summaries + refs only.
- Training or fine-tuning a model.
- Replacing the Astro questionnaire.
- Unauthenticated access.

---

## 4. Architecture

```
Signup / login (browser)
        │  email + password  →  Supabase Auth
        ▼
   mcp_users  ──issues──►  sav_live_… key

Cursor / Claude / ChatGPT
        │  Bearer sav_live_…   (not the password)
        ▼
┌───────────────────────────────────────┐
│  HTTP API  (source of truth)          │
│  POST /v1/search/automations          │
│  POST /v1/search/software             │
│  GET  /v1/templates/:id               │
│  auth → rate limit → embed → RPC      │
└───────────────┬───────────────────────┘
        ┌───────┴────────┐
        ▼                ▼
   Thin MCP server    OpenAPI spec
   (Claude, Cursor)   (ChatGPT Actions)
        │
        ▼
   Supabase (Savante project)
   - auth.users (passwords)
   - mcp_users / mcp_api_keys / mcp_request_log
   - templates + match_templates_faceted
```

One HTTP API; MCP is a thin wrapper. Do not implement retrieval twice.

**Embeddings:** query text must use **gte-small (384-d)**, same as
[`migrations/004_embeddings_gte_small.sql`](../migrations/004_embeddings_gte_small.sql).
Options: `Supabase.ai` inside an edge function, or a small embed step next to
the API. Mixing OpenAI 1536-d vectors will miss or error.

**Database role:** a dedicated Postgres role that can `SELECT` on `templates`,
`EXECUTE` `match_templates_faceted`, and insert/update `mcp_api_keys` /
`mcp_request_log`. Never `SERVICE_ROLE` in the MCP process config that users
could see. Keys and Auth live in server env / Supabase secrets.

Prerequisite: catalog actually loaded (`npm run load-supabase` after ingest +
embed). If `templates` is empty, the MCP is a dead product.

---

## 5. Tools (MCP) / endpoints (HTTP)

Map 1:1. Tool names are what the client model sees.

### 5.1 `search_automations`

**When:** user describes a pain, tools, or channels.

| Arg | Type | Maps to |
|-----|------|---------|
| `pain` | string (required) | query text → embedding |
| `tools` | string[] | `filter_integrations` |
| `channels` | string[] | `filter_trigger` |
| `wants_ai` | `none` \| `ia` \| `rag` | `filter_is_rag` / skip |
| `limit` | int, default 8, max 12 | `match_count` |

Returns n8n-oriented rows (do not pass `filter_source = self-hosted`).
Each hit: `id`, `name`, `category`, `integrations`, `trigger_type`, `has_ai`,
`is_rag`, `description` (truncated), `import_ref`, `similarity`.

Hard facet filter first, semantic rank second — same contract as
[`INGESTION_AND_TAGGING.md`](INGESTION_AND_TAGGING.md).

### 5.2 `search_software`

Same `pain` embedding; `filter_source = 'self-hosted'`;
`exclude_unmaintained = true`. Optional `category`. Limit 6.

### 5.3 `get_template`

`id` (required). Single row, same public fields. 404 if missing.

### 5.4 `list_categories`

No args. Distinct `templates_public.category` values + row counts
(`public.list_template_categories()`, migration 006). Helps a client model scope a
search before calling `search_automations`/`search_software`.

### 5.5 `recommend_automation`

**When:** the user describes a business problem in plain language and wants a
recommendation, not just a list of hits.

| Arg | Type | Maps to |
|-----|------|---------|
| `problem_description` | string (required) | query text → embedding, and the LLM prompt |

Runs the same retrieval as `search_automations`/`search_software` (embed →
`match_templates_faceted` for workflows and for `self-hosted` software), then
reuses the **same DeepSeek/OpenRouter synthesis** the `recommend/` edge function uses
for the website funnel — factored into
[`_shared/recommend-synthesis.ts`](../service/supabase/functions/_shared/recommend-synthesis.ts)
so there is exactly one synthesis implementation, not two.

Deliberately **discovery-only**, consistent with §5.6/§3 non-goals: the response is
`{ summary, roi_note, watch_outs, recommended_workflows, recommended_software,
matched_template_ids }`. It does **not** include `tier`/`price_estimate`/`complexity`/
`implementation_days` (the priced funnel), and it does **not** write to `leads` or
`recommendations`, and does not send email. For a quoted plan, point the user at the
website intake.

Quota: its own `recommend` bucket (10/day free, 100/day paid) — separate from `search`
and `lookup` — because it triggers an LLM call.

### 5.6 Out of v1

`save_plan`, full priced `recommend_plan` output over MCP, writing to `leads` from MCP.

---

## 6. Users, passwords, API keys, and usage tracking

**Goal:** every request is attributable to a **person**, not an anonymous IP.
That is part of the product build, not an afterthought.

There are **two credentials**. Mixing them is a bug.

| Credential | Where it is used | What it proves |
|------------|------------------|----------------|
| **Email + password** (or magic link) | Savante signup / dashboard only | “This is the human account” |
| **API key** `sav_live_…` | Every MCP / GPT / HTTP search call | “This request belongs to that account” |

Cursor, Claude, and ChatGPT **must not** send username and password on each
tool call. Those clients store a static secret in config; a password there
gets leaked, is hard to rotate, and does not map cleanly to logs.

Flow:

1. `auth.users` + `mcp_users` — create the person (Supabase Auth; we do **not**
   store a plaintext password in our tables).
2. User (logged in) creates an API key. We show it once.
3. MCP sends `Authorization: Bearer sav_live_…`.
4. API hashes the key, finds `mcp_api_keys` → `user_id`, writes
   `mcp_request_log(user_id, api_key_id, tool, …)`.

Dashboard query: “who searched this week?” = join log → `mcp_users.email`.

Use **Supabase Auth** for password hashing, sessions, and reset email. Do not
roll a custom `password` column on `mcp_users`.

v1 signup: email + password on a small page (or invite-only Auth users).
Magic link is an acceptable substitute; the requirement is a stable `user_id`.

### 6.1 API key issuance

- Prefix: `sav_live_` (add `sav_test_` later for staging).
- Show the secret **once**. Store `key_prefix` (first ~12 chars) +
  `key_hash` (SHA-256 of the full secret). Never store plaintext.
- HTTP: `Authorization: Bearer sav_live_…` (also accept `X-Api-Key`).
- Missing/invalid → `401`. Revoked → `403`.

### 6.2 Suggested schema (migration later)

```sql
-- Sketch only; not applied yet.
-- id = auth.users.id  (created at signup; password lives in Auth, not here)

create table public.mcp_users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  name text,
  plan text not null default 'free',  -- free | paid
  created_at timestamptz default now()
);

create table public.mcp_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.mcp_users (id) on delete cascade,
  name text,                          -- e.g. "Cursor"
  key_prefix text not null,           -- sav_live_abcd
  key_hash text not null unique,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz default now()
);

create table public.mcp_request_log (
  id bigint generated always as identity primary key,
  at timestamptz default now(),
  api_key_id uuid references public.mcp_api_keys (id) on delete set null,
  user_id uuid references public.mcp_users (id) on delete set null,
  tool text not null,                 -- search_automations | search_software | get_template
  status int not null,                -- 200, 401, 429, 500
  latency_ms int,
  result_count int,
  -- facets only, not the user's full chat transcript
  filters jsonb default '{}'::jsonb
);

create index mcp_request_log_user_at on public.mcp_request_log (user_id, at desc);
```

Log **tool + filters + counts**. Do not log raw Bearer tokens, full workflow
JSON, or the entire chat.

Admin queries (later UI or SQL): users, keys, calls/day, 429s, top tools,
top integration filters. `public.mcp_usage_by_day` (migration 006) already covers
calls/ok/429/auth-failures/avg-latency per client email, per day, per tool — the
starting point for plan pricing.

### 6.3 Rate limits (v1 defaults)

Per key, sliding 24h window (edge or a counter table):

| Plan | `search_*` / 24h | `get_template` + `list_categories` / 24h | `recommend_automation` / 24h |
|------|------------------|-------------------------------------------|-------------------------------|
| `free` | 30 | 60 | 10 |
| `paid` | 300 | 600 | 100 |

`recommend_automation` gets its own bucket (not folded into `search_*`) because it
triggers an LLM call and is meaningfully more expensive per request.

Over quota → `429` + `Retry-After`. Always write the log row (including 401/429)
so dashboards show abuse and failed auth.

### 6.4 API key vs OAuth

| | v1 API key | Later OAuth |
|--|------------|-------------|
| Tracking | Good if 1 key / user | Account is the identity |
| Cursor | Headers in `mcp.json` | Heavier |
| ChatGPT Actions | Native API key | Extra |
| Claude remote MCP | Often awkward | Preferred |

Ship **Auth + keys** together. OAuth for Claude.ai later still points at the
same `mcp_users.id` (`auth.users.id`).

---

## 7. Client setup

Placeholder host only — replace `YOUR_PROJECT` and `sav_live_YOUR_KEY`. Never put
`SUPABASE_SERVICE_ROLE_KEY` in a client config.

**Cursor** — copy [`service/examples/cursor-mcp.json`](../service/examples/cursor-mcp.json)
into MCP settings (`url` + `Authorization: Bearer sav_live_…`).

**Claude** — remote MCP / connector at the same `/mcp` URL and Bearer header.
If the host blocks API keys, that is Phase 4 OAuth.

**ChatGPT** — Custom GPT Actions from [`service/openapi/mcp-search.yaml`](../service/openapi/mcp-search.yaml)
(REST `/v1/...`, same Bearer key). Do not point GPT Actions at `/mcp`.

---

## 8. Security and scraping

The catalog is a business asset. Treat the MCP as a **public search API**.

- Auth on every route.
- Truncated descriptions; no full `content` / workflow graph.
- Dedicated DB role; RLS on `mcp_*` tables (users see only their keys).
- Passwords only via Supabase Auth; never in `mcp_request_log` or MCP headers.
- Hash keys; revoke in one update (`revoked_at`).
- Do not commit keys, hashes of real keys, or your project's `service_role` key.
- CORS: MCP/GPT servers only; this is not a browser app in v1.

---

## 9. Build phases

### Phase 0 — Verify the index

Confirm `templates` is populated and `match_templates_faceted` returns
sensible rows for a known pain (e.g. email + Gmail + AI). If this fails,
stop.

### Phase 1 — HTTP search API + keys — **done in repo**

Invite-only keys for a private beta (each key still belongs to an `mcp_users`
row and is written on `mcp_request_log.user_id`). Linking `mcp_users.id` to
`auth.users` and a public email+password page is Phase 3 — do not issue
orphan keys with no user row.

- Migration: [`migrations/005_mcp_keys.sql`](../migrations/005_mcp_keys.sql)
  (`mcp_users`, hashed `mcp_api_keys`, `mcp_request_log`, usage RPCs,
  `templates_public`).
- Edge function: [`service/supabase/functions/catalog-search/`](../service/supabase/functions/catalog-search/)
  (`API key → quota → gte-small embed → match_templates_faceted → log`).
- Shared handler + tests: [`service/supabase/functions/_shared/mcp-catalog.ts`](../service/supabase/functions/_shared/mcp-catalog.ts),
  [`service/test/mcp-catalog.test.ts`](../service/test/mcp-catalog.test.ts).
- Issue a key: `npm run issue-mcp-key -- --email you@example.com`.
- OpenAPI (GPT Actions): [`service/openapi/mcp-search.yaml`](../service/openapi/mcp-search.yaml).
- Host: same as `recommend` — Supabase Edge Function + `Supabase.ai` gte-small.
- Retention: log table commented for ~90 days; no purge job yet.

### Phase 2 — MCP wrapper + OpenAPI — **done in repo**

- Deployed as the `catalog-search` edge function (REST and MCP on the same function).
- OpenAPI: [`service/openapi/mcp-search.yaml`](../service/openapi/mcp-search.yaml).
- Snippets: [`service/examples/cursor-mcp.json`](../service/examples/cursor-mcp.json)
  (same shape for Claude connectors). GPT Actions import the OpenAPI file.

### Phase 2.1 — `list_categories` + `recommend_automation` + observability — **done in repo**

- Migration: [`migrations/006_mcp_catalog_extras.sql`](../migrations/006_mcp_catalog_extras.sql)
  (`list_template_categories()`, `mcp_usage_by_day` view).
- `recommend_automation` reuses the `recommend/` edge function's DeepSeek synthesis via
  the new shared module
  [`service/supabase/functions/_shared/recommend-synthesis.ts`](../service/supabase/functions/_shared/recommend-synthesis.ts)
  (`recommend/index.ts` was refactored to call the same module — one synthesis
  implementation, not two). Response omits `tier`/`price_estimate` (see §5.5).
- CLI revoke: `npm run issue-mcp-key -- --revoke --email you@example.com`
  (optionally `--key-prefix ...` to target one key).

### Phase 3 — Signup and dashboard

- Public signup / login (email + password) — UI lives in the website frontend
  (not in this repo), 100% client-side (`supabase-js` in the browser; the site can
  stay fully static).
- **DB side — done in repo**:
  [`migrations/007_mcp_self_service_auth.sql`](../migrations/007_mcp_self_service_auth.sql).
  `mcp_users.id` stays a standalone uuid (existing FKs on `mcp_api_keys`/
  `mcp_request_log` untouched); a new `auth_user_id` column links it to
  `auth.users(id)`. A trigger on `auth.users` (`handle_new_auth_user`) creates
  the `mcp_users` row at signup, or claims an existing invite-only row by
  email if one already exists (so the CLI-issued rows don't get orphaned).
  Four `security definer` RPCs, granted to `authenticated` only (never `anon`
  — includes an explicit `revoke ... from public` since Postgres grants
  EXECUTE to PUBLIC by default): `create_own_api_key(name)` (max 3 active
  keys/account, returns the secret once), `revoke_own_api_key(id)`,
  `list_own_api_keys()` (never returns `key_hash`), `list_own_usage_by_day()`
  (same shape as `mcp_usage_by_day`, scoped to the caller). No new RLS
  policies on the tables — every self-service path goes through these four
  functions.
- Logged-in page: create key (show once), revoke / rotate, see own usage —
  this is UI work in the website frontend, outside this repository.
  (CLI-only revoke exists today — see Phase 2.1 — this phase is the self-service UI.)
- Admin: calls per **user** (email) per day, not only per raw key
  (`mcp_usage_by_day` already gives the query; this phase is the UI on top of it).

### Phase 4 — optional

- OAuth for Claude.ai.
- `save_plan` (consent + email) if we want MCP traffic in `leads`.
- Paid plan limits.
- Do **not** duplicate website pricing synthesis unless we explicitly want
  quotes inside the chat.

---

## 10. Implementation notes (when coding)

- Reuse facet mapping from [`service/src/intake.ts`](../service/src/intake.ts)
  (`workflowFilters` / `softwareFilters` / `queryText`) so MCP filters match
  the questionnaire.
- Reuse RPC argument names from
  [`migrations/004_embeddings_gte_small.sql`](../migrations/004_embeddings_gte_small.sql).
- Keep MCP handlers boring: validate key → check quota → call API → map JSON
  to MCP `content`. No second retrieval algorithm.
- Auth on the wire: hashed API keys only. MCP handlers never verify passwords
  (Supabase Auth is for the Phase 3 dashboard).
- Paths: `migrations/005_mcp_keys.sql`, `service/supabase/functions/catalog-search/`
  (REST `/v1/...` and MCP `/mcp` on the same function). No separate `service/mcp/`.

---

## 11. Open questions (decide at build time)

1. Signup: public email+password vs invite-only Auth users for a private beta
   (accounts exist either way; only the door changes).
2. Host: Supabase Edge Function vs Cloudflare Worker in front of Supabase.
3. Embed path: `Supabase.ai` in-process vs a shared embed helper.
4. Whether truncated `import_ref` / marketplace URLs are OK to return
   publicly (ToS of upstream template sources).
5. Retention on `mcp_request_log` (e.g. 90 days).

---

## 12. Done when

- A person can sign up (email + password) and receive a key tied to their
  `mcp_users` / `auth.users` id.
- They can connect Cursor with that key, ask a business-pain question, and
  get named templates that exist in `templates`.
- The same question without a key fails closed. Password in the MCP header
  is rejected (keys only).
- We can answer “which **user** (email) used search this week?” from
  `mcp_request_log` joined to `mcp_users`.
- Website `recommend` flow is unchanged.
