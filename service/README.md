# Servicio — Prototipo standalone (ingesta + retrieval por facetas)

Prototipo separado para **probar el motor de recomendación antes de embeberlo en la web de
Savante** (Astro + Tailwind). Esta primera etapa valida la **calidad del retrieval** con
**facetas determinísticas, sin embeddings ni API keys**.

Implementa el Paso 2 del embudo descrito en
[`../docs/INGESTION_AND_TAGGING.md`](../docs/INGESTION_AND_TAGGING.md) y
[`../docs/SOLUTION_ARCHITECTURE.md`](../docs/SOLUTION_ARCHITECTURE.md).

## Qué hace

1. **Ingesta** (`npm run ingest`): recorre `../data` (~14k JSON del corpus), extrae facetas de
   forma determinística (categoría, integraciones, canal de entrada, IA/RAG, licencia/stack) y
   genera:
   - `out/catalog.json` — el "templates" local (un registro por workflow/software).
   - `out/stats.json` — stats del corpus para **poblar los selects del cuestionario** con
     valores que existen de verdad (top integraciones global y por categoría, canales, etc.).
2. **Consulta** (`npm run query`): harness que filtra el catálogo por facetas (el stand-in
   local de `match_templates_faceted`, migración 003) y rankea por overlap de facetas.
   Sirve para validar que **el filtro duro hace el grueso del trabajo** antes de sumar semántica.

3. **Recomendación + email** (`npm run recommend`): toma un intake (la salida del cuestionario,
   con empresa + email del Bloque E), corre el retrieval por facetas, sintetiza la recomendación
   con **DeepSeek vía OpenRouter** y **entrega el plan por email** (Resend). Corre **offline**
   por defecto: si no hay `OPENROUTER_API_KEY` usa un mock, y si no hay `RESEND_API_KEY` escribe
   el email a `out/` (dry-run). El mismo flujo está como **edge function** en
   `supabase/functions/recommend/` para que la web de Astro lo llame.

## Uso

```bash
npm install
npm run ingest                 # construye out/catalog.json + out/stats.json

# validación de retrieval (sin keys):
npm run query -- --trigger email --integrations "Gmail" --ai          # recruiting: CV por email
npm run query -- --category crm --source self-hosted --no-unmaintained   # reemplazar HubSpot
npm run query -- --rag --limit 5                                       # base de conocimiento / RAG

# flujo completo cuestionario → recomendación → email (offline: mock + dry-run):
npm run recommend                              # usa fixtures/intake.sample.json
npm run recommend -- --intake mi-intake.json   # intake propio
# con OPENROUTER_API_KEY en .env → síntesis real con DeepSeek
# con RESEND_API_KEY en .env y --send → envía el email de verdad
```

Copiá `.env.example` a `.env` para sumar keys. El intake (lo que produce el cuestionario)
sigue el shape de `fixtures/intake.sample.json` y los bloques de
[`../docs/INTAKE_QUESTIONNAIRE.md`](../docs/INTAKE_QUESTIONNAIRE.md).

Flags de `query` (todos opcionales; omitir una faceta = ignorarla): `--category`,
`--integrations "a,b"`, `--trigger "email,form"`, `--ai`, `--rag`, `--source`,
`--no-unmaintained`, `--limit`.

## Resultado de referencia

En un corpus de prueba del orden de 10^4 workflows, una consulta típica (canal email +
una integración concreta + IA) **colapsa el conjunto de candidatos en torno a dos órdenes de
magnitud aplicando sólo el filtro por facetas**, antes de rankear.

Eso es lo que sostiene el diseño: el filtro duro aporta la precisión, el semántico sólo ordena
lo que ya es aplicable. Las cifras exactas dependen del corpus que uses; `npm run ingest` genera
`out/stats.json` con el censo del tuyo.

## Estructura

```
src/facets.ts        node-type → integraciones/canales/IA/RAG (blacklist plumbing + aliases)
src/ingest-core.ts   parseo de un archivo del corpus → registro con facetas
src/retrieve.ts      retrieval por facetas (stand-in de match_templates_faceted)
src/intake.ts        adaptadores del intake para el pipeline local (tipos en _shared/retrieval.ts)
src/recommend.ts     re-export de _shared/recommend-synthesis.ts (síntesis, pricing, grounding)
src/email.ts         render HTML del plan + envío Resend (con dry-run)
scripts/ingest.ts    recorre data/ → catalog.json + stats.json
scripts/query.ts     harness de retrieval por facetas
scripts/recommend.ts cuestionario → retrieval → síntesis → email (corre offline)
scripts/issue-mcp-key.ts  emite / revoca API keys del catalog search (imprime el secreto una vez)
scripts/eval-mcp.ts  evaluación del MCP por capas (ver docs/MCP_TEST_PLAN.md)
scripts/diagnostics/ SQL de línea base (candidatos vacíos, vocabulario de facetas) para tu proyecto
fixtures/            intake de ejemplo (persona "Mariana", recruiting)
supabase/functions/_shared/    retrieval + síntesis + API del catálogo, compartido por las edge functions y src/
supabase/functions/recommend/  edge function (Deno) = el mismo flujo para la web de Astro
supabase/functions/catalog-search/ API HTTP del catálogo + MCP JSON-RPC (API keys → RPC por facetas). Sin leads.
openapi/mcp-search.yaml        OpenAPI para Custom GPT Actions (REST /v1, mismas keys)
examples/cursor-mcp.json       snippet de MCP remoto para Cursor/Claude (placeholders)
out/                 (gitignored) catalog.json, stats.json, emails dry-run
```

## Etapa 2 — Embeddings + Supabase + edge function

Ranking semántico con **gte-small (384d)**: corre **local sin key** para la ingesta
(Transformers.js) y **lo trae Supabase integrado** en las edge functions (`Supabase.ai`) para
la consulta. Mismo modelo ambos lados → similitud coherente.

```bash
# 1) generar embeddings locales del catálogo (sin keys; ~15 min para 14k)
npm run embed
#    -> habilita el rerank semántico local automáticamente:
npm run recommend         # ahora dice "(semantic rerank)" y el top mejora

# 2) aplicar migraciones en Supabase (001 → 009)  [necesita acceso al proyecto]
#    via Supabase CLI:  supabase db push
#    o pegando migrations/00X_*.sql en el SQL editor

# 3) cargar catálogo + embeddings a la tabla templates
cp .env.example .env      # completar SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
npm run load-supabase

# 4) desplegar la edge function (Deno) y setear secrets
supabase functions deploy recommend
supabase secrets set OPENROUTER_API_KEY=... RESEND_API_KEY=... MAIL_FROM="Savante <hello@example.com>"
```

Migraciones relevantes: `001_templates` (tabla + RPC), `002_leads` (leads/recomendaciones),
`003_facets` (columnas de faceta), `004_embeddings_gte_small` (vector 384 + match semántico),
`005_mcp_keys` (API keys + log de uso del catalog search), `006_mcp_catalog_extras`
(categorías + vista `mcp_usage_by_day`), `007_mcp_self_service_auth` (vincula `mcp_users` con
Supabase Auth + RPCs `create_own_api_key`/`revoke_own_api_key`/`list_own_api_keys`/
`list_own_usage_by_day` para un dashboard self-service), `008_facet_normalization` (matching de
facetas case-insensitive + facetas `uses_ai`/`primary_channels`/`use_case`, RPC de 11 parámetros),
`009_recommendation_tracing` (`recommendations.retrieval_trace`).

## Pipeline de recomendación (edge `recommend`)

1. **Lead primero.** Se persiste el intake completo; es el único paso cuyo fallo devuelve 500.
2. **Retrieval con escalera de fallback.** Se prueban combinaciones de facetas de la más rica a
   la más relajada (herramientas + canal + caso de uso → … → sólo semántico) hasta tener al menos
   6 candidatos distintos. `wants_ai = "ninguna"` es un filtro duro que se aplica en todos los
   niveles. Los candidatos se re-rankean por canal del dolor, caso de uso y solapamiento de
   herramientas.
3. **Software self-hosted** por similitud semántica, con boost (no filtro) por nicho.
4. **Síntesis grounded.** Toda cita fuera de la lista de candidatos se descarta; si no queda
   ningún workflow, un reintento correctivo y, en último caso, top-3 determinístico. Tier, días,
   complejidad y presupuesto se reconcilian en código; el ROI se calcula en código.
5. **Traza.** `recommendations.retrieval_trace` guarda query, filtros, nivel de fallback,
   candidatos, citas rechazadas y reintentos.
6. **Errores.** Si algo falla después de crear el lead: `leads.status = 'error'` + email de acuse.

Modo debug: con `RECOMMEND_DEBUG_SECRET` seteado, un request con el header
`x-recommend-debug-secret` igual a ese valor devuelve la salida cruda del pipeline sin escribir
lead ni mandar email (útil para regresiones).

## Catalog search API + MCP

Búsqueda autenticada por API key sobre `templates` + `match_templates_faceted`. **No** es el
embudo del cuestionario: no escribe leads, no cotiza. `recommend_automation` reusa la misma
síntesis que `recommend` (vía `_shared/recommend-synthesis.ts`) pero sin tier ni precio. Quien
llama manda `sav_live_…` en `Authorization: Bearer` o `X-Api-Key`. Las descripciones se truncan
y `content` nunca se devuelve.

```bash
# después de aplicar 005 → 007
npm run issue-mcp-key -- --email you@example.com --name Cursor
# imprime el secreto una vez; con SUPABASE_* en .env inserta el hash

npm run issue-mcp-key -- --revoke --email you@example.com
# revoca todas las keys activas de ese email (--key-prefix sav_live_abcd1234 para una sola)

supabase functions deploy catalog-search
```

| Método | Path bajo `/functions/v1/catalog-search` | Tool |
|--------|----------------------------------------|------|
| POST | `/v1/search/automations` | `search_automations` |
| POST | `/v1/search/software` | `search_software` |
| GET | `/v1/templates/:id` | `get_template` |
| GET | `/v1/categories` | `list_categories` |
| POST | `/v1/recommend` | `recommend_automation` |
| POST | `/mcp` (también la raíz de la función) | Streamable HTTP MCP (JSON-RPC) |

Cuotas por key cada 24h (plan free): 30 `search_*`, 60 `get_template`/`list_categories`,
10 `recommend_automation` (ver `RATE_LIMITS`). `tools/call` por MCP comparte esas cuotas.
Observabilidad: `select * from mcp_usage_by_day order by day desc;`.

### Evaluación del MCP

`npm test` valida el contrato HTTP/JSON-RPC contra fakes en memoria y corre sin credenciales.
Para evaluar relevancia, grounding, concurrencia y logging contra un deploy real, ver
[`../docs/MCP_TEST_PLAN.md`](../docs/MCP_TEST_PLAN.md):

```bash
npx tsx scripts/eval-mcp.ts --mode offline                                        # smoke test, sin creds
npx tsx --env-file-if-exists=.env scripts/eval-mcp.ts --mode live                 # golden set + grounding
npx tsx --env-file-if-exists=.env scripts/eval-mcp.ts --mode live --concurrency   # ¿la cuota es atómica?
npx tsx --env-file-if-exists=.env scripts/eval-mcp.ts --mode live --check-logs    # ¿queda todo en mcp_request_log?
```

## Seguridad (leer antes de desplegar)

⚠️ **La edge function `recommend` no tiene autenticación ni rate limiting.** Corre con la
**service role key** de Supabase, llama a un LLM pago vía OpenRouter y envía email vía Resend a
una dirección provista por quien llama. Desplegada así es un relay abierto: cualquiera puede
quemar tus créditos de LLM y hacer que mande mails arbitrarios. **Agregá autenticación y rate
limiting antes de desplegarla** (ver el bloque de advertencia en
`supabase/functions/recommend/index.ts`).

- `ALLOWED_ORIGIN` controla el CORS y por default es `*`. Restringilo al origen de tu sitio.
- `002_leads.sql` habilita **RLS sin políticas** en `leads` y `recommendations` (deny by
  default): sin eso, la anon key puede leer todos los leads vía PostgREST. La edge function usa
  la service role key, que saltea RLS.
- La service role key es un secreto de servidor: nunca la expongas en el browser.

## Próximos pasos

- **Autenticación + rate limiting** en la edge function (ver Seguridad).
- **Cuota por lead** (migración 002): `free_credits_used` + contador global (no implementado).
- **UI del cuestionario en Astro** (isla interactiva) que postea el intake a la edge function →
  portable a la web de Savante.
- (Opcional) Embeddings multilingües si gte-small se queda corto en español (cambiar dims en
  `004` y reindexar).
