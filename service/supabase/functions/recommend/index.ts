/**
 * Supabase Edge Function (Deno): questionnaire intake -> faceted retrieval -> DeepSeek -> email.
 * Deployment target for the Astro web. Mirrors the local pipeline in ../../src/.
 *
 * Pipeline: progressive facet fallback retrieval, a hard `uses_ai` constraint, channel/
 * use-case-aware ranking, a niche boost for self-hosted software, grounded synthesis with
 * retries, tier/day/complexity/budget coherence, a deterministic ROI note, and sanitization
 * of tools the client is replacing. Retrieval and synthesis live in `../_shared/` and are
 * shared with the catalog-search function and the local pipeline in service/src/.
 *
 * Requires: the catalog loaded into `templates` (migrations 001 -> 009) and these secrets:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY, RESEND_API_KEY, MAIL_FROM
 *   Optional: BOOKING_URL, SITE_URL, ALLOWED_ORIGIN, MAIL_CC, MAIL_REPLY_TO, MAIL_AVATAR_URL,
 *   RECOMMEND_DEBUG_SECRET (debug mode: send the same value in the `x-recommend-debug-secret`
 *   header to get the raw pipeline output back without writing a lead or sending email —
 *   useful for regression runs).
 *
 * Deploy:  supabase functions deploy recommend
 * Local:   supabase functions serve recommend
 *
 * ⚠️  SECURITY WARNING — NOT PRODUCTION READY AS-IS
 *
 *   This endpoint has NO AUTHENTICATION and NO RATE LIMITING. It runs with the
 *   Supabase service role key (full DB access, bypasses RLS), calls a paid LLM
 *   through OpenRouter, and sends mail via Resend to a caller-supplied address.
 *
 *   Deployed open, it is an abuse vector on three fronts:
 *     1. Unbounded LLM spend — anyone can burn your OpenRouter credits.
 *     2. Outbound email relay — anyone can make it mail arbitrary recipients.
 *     3. Unbounded writes to `leads` / `recommendations`.
 *
 *   ADD BOTH BEFORE DEPLOYING:
 *     - Authentication (verify a Supabase JWT, a shared secret, or a CAPTCHA
 *       / Turnstile token issued by your own frontend), and
 *     - Rate limiting (per IP and per email, plus a global spend cap).
 *
 *   Set ALLOWED_ORIGIN to your site's origin; it defaults to "*", which allows
 *   any page on the internet to call this function from a browser.
 */
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  PRICING, CARE_PLAN_USD_MO, synthesizeRecommendationGrounded,
  type CandidateRow, type SynthesizeResult,
} from "../_shared/recommend-synthesis.ts";
import {
  buildQueryText, workflowFacetLevels, dedupByName, extractPainChannels, inferUseCase,
  rankWorkflowsByChannel, rankSoftwareByNiche, deriveToolsToReplace, type Intake,
} from "../_shared/retrieval.ts";

/** Booking link shown as the email CTA. Override with the BOOKING_URL secret. */
const BOOKING_URL = Deno.env.get("BOOKING_URL") ?? "https://cal.com/your-handle/intro";
/** Optional site link in the email footer (omitted when SITE_URL is unset). */
const SITE_URL = Deno.env.get("SITE_URL") ?? null;

const CORS = {
  // Restrict this to your site's origin in production; "*" allows any page to call it.
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-recommend-debug-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MIN_CANDIDATES = 6;
const OVERFETCH = 24;
const BRAND_VIOLET = "#7c3aed";

function money(r: [number, number]) { return `USD ${r[0]}–${r[1]}`; }
function esc(s: string) { return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!)); }

function isDebugMode(req: Request): boolean {
  const secret = Deno.env.get("RECOMMEND_DEBUG_SECRET");
  if (!secret) return false;
  return req.headers.get("x-recommend-debug-secret") === secret;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const intake = (await req.json().catch(() => null)) as Intake | null;
  if (!intake?.email || !intake?.company || !intake?.pain_primary) {
    return json({ error: "Faltan company / email / pain_primary" }, 400);
  }

  const debug = isDebugMode(req);
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // 1) lead — persist the FULL intake, skipped entirely in debug mode so regression
  //    runs don't pollute the leads table. This insert is the only step whose failure produces
  //    a 500: past this point we always have a lead id to attach errors to.
  let leadId: string | null = null;
  if (!debug) {
    const { data: lead, error: leadErr } = await supabase
      .from("leads")
      .insert({
        company: intake.company, email: intake.email, niche: intake.niche,
        country: intake.country, city: intake.city, team_size: intake.team_size,
        contact_name: intake.contact_name,
        pain_primary: intake.pain_primary, pain_secondary: intake.pain_secondary,
        pain_volume: intake.pain_volume, pain_time_each: intake.pain_time_each,
        pain_cost: intake.pain_cost,
        current_tools: intake.current_tools ?? [], input_channels: intake.input_channels ?? [],
        output_targets: intake.output_targets ?? [], hosting_pref: intake.hosting_pref,
        wants_ai: intake.wants_ai, budget_band: intake.budget_band, urgency: intake.urgency,
        decision_role: intake.decision_role, source: "web",
      })
      .select("id").single();

    if (leadErr || !lead) {
      console.error("recommend: failed to insert lead", leadErr);
      return json({ error: "No pudimos registrar tu solicitud, reintentá en unos minutos." }, 500);
    }
    leadId = lead.id;
  }

  try {
    const result = await runPipeline(supabase, intake, leadId, debug);
    if (!debug && leadId) await supabase.from("leads").update({ status: "recommended" }).eq("id", leadId);
    return result;
  } catch (e) {
    console.error("recommend: pipeline failed for lead", leadId, e);
    if (debug) return json({ error: String(e) }, 500);
    if (leadId) await supabase.from("leads").update({ status: "error" }).eq("id", leadId).catch(() => {});
    await sendEmail(intake.email, "Recibimos tu solicitud — Savante", acknowledgementHtml(intake))
      .catch((mailErr) => console.error("recommend: ack email failed for lead", leadId, mailErr));
    // Never surface a raw 500 to the client for a pipeline failure past lead creation —
    // the lead is safe, and the user gets an acknowledgement either way.
    return json({ ok: true, message: `Recibimos tu info. Te escribimos a ${intake.email} en menos de 24h.` });
  }
});

async function runPipeline(supabase: SupabaseClient, intake: Intake, leadId: string | null, debug: boolean): Promise<Response> {
  // 2) embed the query with built-in gte-small (no key needed).
  const queryText = buildQueryText(intake);
  // deno-lint-ignore no-explicit-any
  const session = new (globalThis as any).Supabase.ai.Session("gte-small");
  const query_embedding = await session.run(queryText, { mean_pool: true, normalize: true });

  const painChannels = extractPainChannels(intake);
  const useCase = inferUseCase(intake);
  const toolsToReplace = deriveToolsToReplace(intake);

  // uses_ai is a HARD business constraint (client explicitly said no AI) — applied on every
  // fallback level below, never relaxed, unlike the convenience filters in the ladder.
  const aiFilters = {
    filter_is_rag: intake.wants_ai === "rag" ? true : null,
    filter_uses_ai: intake.wants_ai === "ninguna" ? false : null,
  };

  // 3) progressive fallback retrieval with channel/use-case ranking: try filter levels from richest to most relaxed until we have enough distinct
  //    candidates, then rank by channel/use-case/tool-overlap fit before cutting to 12.
  const levels = workflowFacetLevels(intake);
  let workflows: CandidateRow[] = [];
  let fallback_level = levels.length - 1;
  const filtersApplied = { ...levels[levels.length - 1], ...aiFilters };
  for (let level = 0; level < levels.length; level++) {
    const { data, error } = await supabase.rpc("match_templates_faceted", {
      query_embedding, match_count: OVERFETCH, filter_category: null,
      filter_source: null, exclude_unmaintained: true, ...levels[level], ...aiFilters,
    });
    if (error) throw new Error(`match_templates_faceted (level ${level}): ${error.message}`);
    const ranked = rankWorkflowsByChannel(dedupByName((data ?? []) as CandidateRow[]), painChannels, useCase, intake.current_tools ?? []);
    if (ranked.length >= MIN_CANDIDATES || level === levels.length - 1) {
      workflows = ranked.slice(0, 12);
      fallback_level = level;
      break;
    }
  }

  // software: self-hosted, semantic-ranked, boosted (not filtered) by niche
  const { data: softwareRaw, error: swErr } = await supabase.rpc("match_templates_faceted", {
    query_embedding, match_count: 6, filter_category: null,
    filter_source: "self-hosted", exclude_unmaintained: true,
  });
  if (swErr) throw new Error(`match_templates_faceted (software): ${swErr.message}`);
  const software = rankSoftwareByNiche((softwareRaw ?? []) as CandidateRow[], intake.niche);

  // 4) DeepSeek synthesis with grounding enforced + commercial coherence (roi_note,
  //    tier/day/complexity/budget, tool-replacement sanitization).
  const rec: SynthesizeResult = await synthesizeRecommendationGrounded(intake, workflows, software, {
    apiKey: Deno.env.get("OPENROUTER_API_KEY"),
  }, { painChannels, useCase, toolsToReplace, softwareCandidates: software });

  if (debug) {
    return json({ ok: true, debug: true, rec, workflows, software, tools_to_replace: toolsToReplace, pain_channels: painChannels, use_case: useCase });
  }

  // 5) persist recommendation + full retrieval trace
  await supabase.from("recommendations").insert({
    lead_id: leadId, query_text: queryText, summary: rec.summary,
    recommended_software: rec.recommended_software, recommended_workflows: rec.recommended_workflows,
    suggested_stack: rec.suggested_stack, complexity: rec.complexity,
    implementation_days: rec.implementation_days, price_estimate: rec.price_estimate,
    tier: rec.tier, matched_template_ids: workflows.map((w) => String(w.id ?? "")),
    llm_model: Deno.env.get("OPENROUTER_API_KEY") ? "deepseek/deepseek-chat" : "mock",
    retrieval_trace: {
      query_text: queryText,
      filters_applied: filtersApplied,
      fallback_level,
      pain_channels: painChannels,
      use_case: useCase,
      tools_to_replace: toolsToReplace,
      candidates: workflows.map((w) => ({ id: w.id, name: w.name, similarity: w.similarity ?? null })),
      software_candidates: software.map((s) => ({ id: s.id, name: s.name, similarity: s.similarity ?? null })),
      rejected_citations: rec.retrieval_meta.rejected_citations,
      llm_retries: rec.retrieval_meta.llm_retries,
    },
  });

  // 6) email — URLs resueltas server-side desde los arrays de la RPC (no del LLM)
  await sendEmail(
    intake.email,
    `Tu plan de automatización para ${intake.company} · Savante`,
    renderHtml(intake, rec, workflows, software),
  );

  return json({ ok: true, message: `Te enviamos tu plan a ${intake.email}` });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

/** Normaliza para matchear nombres entre la salida del LLM y los candidatos de la RPC. */
function norm(s: unknown) { return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim(); }

/**
 * Índice de URLs reales a partir de las filas de la RPC. La URL SIEMPRE sale de acá
 * (import_ref de la DB), nunca de lo que devuelva el LLM, que sólo elige qué ítems.
 * Sólo se indexan import_ref que sean URLs http(s) — algunos workflows curados no traen.
 */
function urlIndex(rows: CandidateRow[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows ?? []) {
    const url = typeof r?.import_ref === "string" && /^https?:\/\//i.test(r.import_ref) ? r.import_ref : null;
    if (!url) continue;
    if (r.id != null) m.set(`id:${String(r.id)}`, url);
    if (r.import_ref) m.set(`ref:${r.import_ref}`, url);
    if (r.name) m.set(`name:${norm(r.name)}`, url);
  }
  return m;
}

function renderHtml(i: Intake, rec: SynthesizeResult, workflows: CandidateRow[], software: CandidateRow[]): string {
  const avatar = Deno.env.get("MAIL_AVATAR_URL") ?? null;
  const wfIdx = urlIndex(workflows);
  const swIdx = urlIndex(software);
  const wf = (rec.recommended_workflows ?? []).map((w) => {
    const url = wfIdx.get(`ref:${w.import_ref}`) ?? wfIdx.get(`name:${norm(w.name)}`);
    return `<li style="margin-bottom:10px"><b>${esc(w.name)}</b> — ${esc(w.why)}${url ? ` <a href="${esc(url)}" style="color:${BRAND_VIOLET}">ver flujo de referencia</a>` : ""}</li>`;
  }).join("");
  const sw = (rec.recommended_software ?? []).map((s) => {
    const url = swIdx.get(`id:${String(s.id)}`) ?? swIdx.get(`name:${norm(s.name)}`);
    return `<li style="margin-bottom:10px"><b>${esc(s.name)}</b> — ${esc(s.why)}${url ? ` <a href="${esc(url)}" style="color:${BRAND_VIOLET}">sitio</a>` : ""}</li>`;
  }).join("");
  const watch = (rec.watch_outs ?? []).map((w: string) => `<li style="margin-bottom:6px">${esc(w)}</li>`).join("");
  const roiBlock = rec.roi_note
    ? `<div style="background:#f5f3ff;border-left:3px solid ${BRAND_VIOLET};padding:12px 16px;margin:20px 0;border-radius:8px">
    <p style="margin:0;font-weight:600;color:#111">El número que importa</p><p style="margin:4px 0 0;color:#333">${esc(rec.roi_note)}</p></div>`
    : "";
  const p = rec.price_estimate ?? { setup_usd: PRICING["Single Automation"].setup_usd, care_plan_usd_mo: CARE_PLAN_USD_MO };
  const greeting = i.contact_name ? esc(i.contact_name) : "hola";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:#111">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">
<tr><td style="background:linear-gradient(135deg,#111 0%,#1f1f23 55%,#2e1065 100%);padding:28px 24px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    ${avatar ? `<td width="72" valign="top" style="padding-right:16px">
      <img src="${esc(avatar)}" alt="Agente Savante" width="64" height="64" style="display:block;border-radius:50%;-webkit-border-radius:50%;-moz-border-radius:50%;border:3px solid rgba(255,255,255,.25);outline:none">
    </td>` : ""}
    <td valign="middle">
      <p style="margin:0;font-size:18px;font-weight:700;color:#fff">Agente Savante</p>
      <p style="margin:4px 0 0;font-size:14px;color:rgba(255,255,255,.75)">Análisis de automatización con IA · Savante</p>
    </td>
  </tr></table>
</td></tr>
<tr><td style="padding:28px 24px 8px">
  <p style="margin:0 0 16px;font-size:15px;color:#444">Hola ${greeting},</p>
  <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3">Tu plan de automatización — ${esc(i.company)}</h1>
  <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#333">${esc(rec.summary ?? "")}</p>
  ${roiBlock}
  ${wf ? `<h2 style="margin:24px 0 8px;font-size:17px">Automatizaciones recomendadas</h2><ul style="margin:0;padding-left:20px;color:#333;line-height:1.5">${wf}</ul>` : ""}
  ${sw ? `<h2 style="margin:24px 0 8px;font-size:17px">Software open-source sugerido</h2><ul style="margin:0;padding-left:20px;color:#333;line-height:1.5">${sw}</ul>` : ""}
  <h2 style="margin:24px 0 8px;font-size:17px">Arquitectura</h2>
  <p style="margin:0 0 20px;line-height:1.6;color:#333">${esc(rec.suggested_stack ?? "")}</p>
  ${watch ? `<h2 style="margin:24px 0 8px;font-size:17px">Lo que la mayoría subestima</h2>
  <p style="color:#666;margin:0 0 8px;font-size:14px">Donde estos flujos suelen fallar en producción:</p>
  <ul style="margin:0 0 20px;padding-left:20px;color:#333;line-height:1.5">${watch}</ul>` : ""}
  <h2 style="margin:24px 0 4px;font-size:17px">Estimado preliminar</h2>
  <p style="color:#666;margin:0 0 12px;font-size:14px">Rango orientativo según lo que nos contaste. La propuesta cerrada la definimos en la llamada.</p>
  <p style="margin:0 0 24px;line-height:1.6">Complejidad: <b>${esc(String(rec.complexity ?? ""))}</b> · Tiempo: <b>${rec.implementation_days ?? "?"} días</b><br>
  Setup: <b>${money(p.setup_usd)}</b> · Care Plan: <b>${money(p.care_plan_usd_mo)}/mes</b> · Plan: <b>${esc(String(rec.tier ?? ""))}</b></p>
  <p style="margin:0 0 12px">Para implementarlo en tu stack lo hacemos nosotros. Agendá una llamada y lo dejamos andando:</p>
  <p style="margin:0 0 24px"><a href="${esc(BOOKING_URL)}" style="display:inline-block;background:#111;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Ver horarios disponibles</a></p>
  <p style="color:#666;font-size:14px;margin:0 0 8px;line-height:1.5">En esos 30 minutos lo aterrizamos a un caso real tuyo y te mostramos el flujo funcionando con tus propios datos.</p>
</td></tr>
<tr><td style="padding:16px 24px 24px;border-top:1px solid #eee;background:#fafafa">
  <p style="margin:0;font-size:12px;color:#888;line-height:1.5">Este análisis fue generado por el agente de automatización de Savante a partir de tu cuestionario. Si respondés a este correo, un consultor humano del equipo te acompaña en los próximos pasos.</p>
  ${SITE_URL ? `<p style="margin:8px 0 0;font-size:12px;color:#aaa"><a href="${esc(SITE_URL)}" style="color:#888">${esc(SITE_URL.replace(/^https?:\/\//, ""))}</a></p>` : ""}
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function acknowledgementHtml(i: Intake): string {
  return `<!doctype html><html><body style="font-family:system-ui,Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px">
  <h2>Recibimos tu solicitud — Savante</h2>
  <p>Hola${i.contact_name ? ` ${esc(i.contact_name)}` : ""}, ya tenemos los datos de <b>${esc(i.company)}</b>.</p>
  <p>Tuvimos un problema generando tu plan automáticamente. Nuestro equipo lo va a armar a mano y
  te lo enviamos a <b>${esc(i.email)}</b> en menos de 24 horas.</p>
  <p>Si es urgente, agendá una llamada directamente:
  <a href="${esc(BOOKING_URL)}">${esc(BOOKING_URL)}</a></p>
</body></html>`;
}

async function sendEmail(to: string, subject: string, html: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) { console.log("RESEND_API_KEY ausente — email no enviado (dry)"); return; }
  const from = Deno.env.get("MAIL_FROM") ?? "Savante <onboarding@resend.dev>";
  const replyTo = Deno.env.get("MAIL_REPLY_TO");
  const ccRaw = Deno.env.get("MAIL_CC");
  const cc = ccRaw ? ccRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const payload: Record<string, unknown> = { from, to, subject, html };
  if (replyTo) payload.reply_to = replyTo;
  if (cc?.length) payload.cc = cc;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}
