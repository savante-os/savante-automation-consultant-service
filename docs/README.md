# Docs

This folder is **technical** only. Marketing, niche targeting, cold outreach, and commercial playbooks are not published here.

## In this repository

| File | What it covers |
|------|----------------|
| [`SOLUTION_ARCHITECTURE.md`](SOLUTION_ARCHITECTURE.md) | RAG vs fine-tuning, intake → retrieval → LLM → lead DB |
| [`INGESTION_AND_TAGGING.md`](INGESTION_AND_TAGGING.md) | Deterministic facets + hybrid retrieval |
| [`INTAKE_QUESTIONNAIRE.md`](INTAKE_QUESTIONNAIRE.md) | Questionnaire fields that feed retrieval and leads |
| [`WEB_INTEGRATION.md`](WEB_INTEGRATION.md) | How the Astro site calls the recommend edge function |
| [`MCP_CATALOG.md`](MCP_CATALOG.md) | Keyed HTTP + Streamable HTTP MCP search over the same templates index |
| [`MCP_TEST_PLAN.md`](MCP_TEST_PLAN.md) | Layered test plan (protocol → contract → relevance → grounding → concurrency → logs) for the MCP server |

## Not in this repository

Commercial and go-to-market material (niche targeting, outreach sequences, consulting playbooks)
is deliberately not published here. `docs/private/` is gitignored for that purpose.
