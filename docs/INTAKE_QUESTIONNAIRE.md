# 🧭 Intake Questionnaire — Automation Guide + Lead Capture

> **Step 1** of the funnel described in
> [`SOLUTION_ARCHITECTURE.md`](SOLUTION_ARCHITECTURE.md): structured questions that guide a
> non-technical person, feed retrieval, and **create the lead record** from the first answer.

> **Note on language:** the question wording below is given in English as the canonical spec.
> The reference implementation's user-facing copy (and the generated plan email) is in Spanish;
> translate the copy, not the field names.

---

## 0. Principles

- **Structured, not free-form chat.** Every question maps to a `leads` column (see
  [`migrations/002_leads.sql`](../migrations/002_leads.sql)).
- **Business language, not technical.** The user describes their pain; the system translates it
  into a stack.
- **Progressive.** The lead is saved as soon as there is a contact + niche; the rest enriches it.
- **Every answer serves two purposes:** (a) building the retrieval query, (b) qualifying the lead.
- **Golden rule (filter first):** every filtering question maps to an **extractable facet** of the
  corpus (`category`, `integrations`, `trigger_type`, `is_rag`…). That way the deterministic
  filter does the heavy lifting and the semantic step only ranks → less margin of error. See
  [`INGESTION_AND_TAGGING.md`](INGESTION_AND_TAGGING.md). If a question does not translate into a
  `WHERE`, it is demoted to "enriches the lead only", not a filter.

---

## 1. Questionnaire blocks

### Block A — Business identity (creates the lead)

| # | Question | `leads` column | Type |
|---|---|---|---|
| A1 | What is your company called? | `company` | text |
| A2 | What does it do? (industry) | `niche` | select + "other" |
| A3 | Which country/city do you operate in? | `country`, `city` | text |
| A4 | How many people work there? | `team_size` | range |
| A5 | Your name and contact email | `contact_name`, `email` | text (validate email) |

> The A2 options align to the catalog's top-level categories
> (Sales, Marketing, Operations, Support, HR, Finance, AI, Productivity).

### Block B — The pain (feeds retrieval)

| # | Question | Column | Type |
|---|---|---|---|
| B1 | Which manual, repetitive task eats the most of your time? | `pain_primary` | free text |
| B2 | How many times per day/week is that task done? | `pain_volume` | range |
| B3 | Roughly how long does it take each time? | `pain_time_each` | range |
| B4 | What happens if it is done badly or late? (a lead, a client, money) | `pain_cost` | select |
| B5 | Is there a second process that also hurts? | `pain_secondary` | free text |

> B1+B5 are the **primary retrieval query text**. B2–B4 feed the ROI calculation and the
> suggested tier (more volume/cost → higher tier).

### Block C — Technical context (this is the hard retrieval FILTER)

| # | Question | Column | Type | Corpus facet (WHERE) |
|---|---|---|---|---|
| C1 | Which tools do you use today? (CRM, mail, spreadsheets, WhatsApp, ATS…) | `current_tools` | multi-select | `integrations &&` |
| C2 | Where does the information come in from? (email, form, WhatsApp, job board…) | `input_channels` | multi-select | `trigger_type &&` |
| C3 | Where should it end up? (CRM, spreadsheet, Slack, an assigned task…) | `output_targets` | multi-select | `output_targets &&` |
| C4 | Do you prefer self-hosted tools, or does it not matter? | `hosting_pref` | select | `source = self-hosted` |
| C5 | Do you want it to use AI / a knowledge base (RAG)? | `wants_ai` | select | `has_ai` / `is_rag` |

> **Block C = deterministic facets** (see [`INGESTION_AND_TAGGING.md`](INGESTION_AND_TAGGING.md)).
> The **values** of each select must come from exploring the corpus (do not offer a filter with
> no inventory behind it). C1–C3 describe the flow: input → transformation → destination.

### Block D — Commercial qualification (prioritizes the lead)

| # | Question | Column | Type |
|---|---|---|---|
| D1 | When would you want this solved? | `urgency` | select (now / 1-3m / exploring) |
| D2 | Do you have an approximate budget in mind? | `budget_band` | select |
| D3 | Who decides on software/service purchases? | `decision_role` | select |

> D1–D3 prioritize the lead and help anchor the quote to the `PRICING` grid in
> `service/src/recommend.ts`.

### Block E — Close / delivery

> **Final stage of the questionnaire.** The result is NOT shown on screen: the plan is
> **delivered by email** and the page shows only an acknowledgment.

| # | Question | Column | Type |
|---|---|---|---|
| E1 | Which email should we send your automation plan to? | `email` | email (validate format) |
| E2 | Addressed to whom? | `contact_name` | text |
| E3 | (confirmation) Company / legal name | `company` | text (prefilled from A1) |
| E4 | I agree to receive the plan and updates by email | `consent` | checkbox |

Closing flow:

1. The `lead` is completed/updated with email + company + contact.
2. The engine runs (facets → retrieval → LLM) and the `recommendation` is persisted.
3. The plan is **sent by email** (HTML) and the page shows only an acknowledgment:
   *"Done, we sent your plan to [email]"*.

---

## 2. From answers to recommendation

```
Block A  ──▶ lead record (saved immediately)
Block C  ──▶ HARD FILTER (facets) ───────────┐  match_templates_faceted(...)
Block B  ──▶ query text ──▶ embedding ───────┤  filters by C, ranks by B
Block D  ──▶ suggested tier + lead priority + price anchor  (does not touch retrieval)
                         │
                         ▼   already-filtered top-N
              LLM (DeepSeek/OpenRouter) synthesizes the JSON recommendation
              (see SOLUTION_ARCHITECTURE.md §4, step 3)
```

> Block C builds the `WHERE` (exact facets) and Block B supplies the embedding that **orders**
> the subset. The semantic step never chooses on its own: filter first, rank second.

**Building the query text (example):**

> "A 12-person recruiting agency in Monterrey. Primary pain: processing CVs that arrive by email
> by hand, ~200/week, 10 min each; delays lose candidates. They currently use Gmail +
> spreadsheets. Information comes in by email and job boards, and should end up as a task
> assigned to the recruiter in their ATS."

That text → embedding → `match_templates` returns the CV-parsing + ATS workflows and software
such as a self-hosted ATS/CRM → the LLM assembles the proposal and the quote.

---

## 3. Output for the user

The result is delivered as a plan (email):

- **Diagnosis** (the LLM's `summary`).
- **Recommended software** + **recommended automations** (from retrieval, each with its "why").
- **Suggested stack**, **implementation time**, **complexity**.
- **Estimated price** (setup + care plan).

---

## 4. Checklist of minimum fields for a usable lead

`company` · `niche` · `country` · `email (verified)` · `pain_primary` · `pain_volume` ·
`current_tools` · `budget_band` · `urgency`

With those nine fields you can already run retrieval and generate a credible quote.
