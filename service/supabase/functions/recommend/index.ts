/**
 * Supabase Edge Function (Deno): questionnaire intake -> faceted retrieval -> DeepSeek -> email.
 * Deployment target for the Astro web. Mirrors the local pipeline in ../../src/.
 *
 * Requires (etapa 2): the catalog loaded into `templates` (migrations 001+003) with facet
 * columns, and these secrets set:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY, RESEND_API_KEY, MAIL_FROM
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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/** Booking link shown as the email CTA. Override with the BOOKING_URL secret. */
const BOOKING_URL = Deno.env.get("BOOKING_URL") ?? "https://cal.com/your-handle/intro";

const CORS = {
  // Restrict this to your site's origin in production; "*" allows any page to call it.
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface Intake {
  company: string; email: string; pain_primary: string;
  niche?: string; city?: string; team_size?: string; contact_name?: string;
  pain_volume?: string; pain_time_each?: string; pain_cost?: string;
  current_tools?: string[]; input_channels?: string[]; wants_ai?: string;
  budget_band?: string; urgency?: string;
}

// Single source of truth for pricing (mirrors ../../src/recommend.ts).
const PRICING: Record<string, { setup_usd: [number, number]; blurb: string }> = {
  "Audit": { setup_usd: [150, 300], blurb: "solo diagnóstico" },
  "Single Automation": { setup_usd: [800, 1500], blurb: "1 workflow" },
  "System": { setup_usd: [2000, 4000], blurb: "3-5 workflows" },
};
const CARE_PLAN_USD_MO: [number, number] = [150, 400];
const PRICING_GRID =
  Object.entries(PRICING)
    .map(([tier, p]) => `${tier} ${p.setup_usd[0]}-${p.setup_usd[1]} (${p.blurb})`)
    .join(", ") + `, Care Plan ${CARE_PLAN_USD_MO[0]}-${CARE_PLAN_USD_MO[1]}/mes.`;

/** Snap the price to the declared tier's grid so the number can't drift from the tier. */
// deno-lint-ignore no-explicit-any
function normalizeRecommendation(rec: any): any {
  const grid = PRICING[rec?.tier];
  if (!grid) return rec;
  return {
    ...rec,
    price_estimate: {
      setup_usd: [grid.setup_usd[0], grid.setup_usd[1]],
      care_plan_usd_mo: [CARE_PLAN_USD_MO[0], CARE_PLAN_USD_MO[1]],
    },
  };
}

function money(r: [number, number]) { return `USD ${r[0]}–${r[1]}`; }
function esc(s: string) { return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!)); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const intake = (await req.json()) as Intake;
    if (!intake?.email || !intake?.company) {
      return json({ error: "Faltan company / email" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1) lead
    const { data: lead } = await supabase
      .from("leads")
      .insert({
        company: intake.company, email: intake.email, niche: intake.niche,
        city: intake.city, team_size: intake.team_size, contact_name: intake.contact_name,
        pain_primary: intake.pain_primary, current_tools: intake.current_tools ?? [],
        input_channels: intake.input_channels ?? [], wants_ai: intake.wants_ai,
        budget_band: intake.budget_band, urgency: intake.urgency, source: "web",
      })
      .select("id").single();

    // 2) hybrid retrieval: embed the query with built-in gte-small (no key),
    //    then facet-filter + semantic-rank via match_templates_faceted (migration 004).
    const queryText =
      `${intake.company} (${intake.niche ?? ""}). Dolor: ${intake.pain_primary}. ` +
      `Herramientas: ${(intake.current_tools ?? []).join(", ")}.`;
    // deno-lint-ignore no-explicit-any
    const session = new (globalThis as any).Supabase.ai.Session("gte-small");
    const query_embedding = await session.run(queryText, { mean_pool: true, normalize: true });

    // workflows: when current_tools/input_channels are set, self-hosted rows (empty facets)
    // are naturally excluded by the array-overlap filter.
    const { data: workflows = [] } = await supabase.rpc("match_templates_faceted", {
      query_embedding,
      match_count: 12,
      filter_integrations: intake.current_tools?.length ? intake.current_tools : null,
      filter_trigger: intake.input_channels?.length ? intake.input_channels : null,
      filter_is_rag: intake.wants_ai === "rag" ? true : null,
    });

    // software: self-hosted, semantic-ranked
    const { data: software = [] } = await supabase.rpc("match_templates_faceted", {
      query_embedding,
      match_count: 6,
      filter_source: "self-hosted",
    });

    // 3) DeepSeek synthesis (price snapped to the tier's grid)
    const rec = normalizeRecommendation(await synthesize(intake, workflows ?? [], software ?? []));

    // 4) persist recommendation
    await supabase.from("recommendations").insert({
      lead_id: lead?.id, query_text: intake.pain_primary, summary: rec.summary,
      recommended_software: rec.recommended_software, recommended_workflows: rec.recommended_workflows,
      suggested_stack: rec.suggested_stack, complexity: rec.complexity,
      implementation_days: rec.implementation_days, price_estimate: rec.price_estimate,
      tier: rec.tier, matched_template_ids: (workflows ?? []).map((w: any) => w.id),
      llm_model: "deepseek/deepseek-chat",
    });

    // 5) email — URLs resueltas server-side desde los arrays de la RPC (no del LLM)
    await sendEmail(intake.email, `Tu plan de automatización para ${intake.company} · Savante`, renderHtml(intake, rec, workflows ?? [], software ?? []));

    return json({ ok: true, message: `Te enviamos tu plan a ${intake.email}` });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

async function synthesize(intake: Intake, workflows: any[], software: any[]) {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  const candidates = workflows
    .map((w) => `- ${w.name} [import_ref=${w.import_ref ?? w.id}] (${w.category ?? "?"})`).join("\n");
  const softwareList = software
    .map((s) => `- ${s.name} [id=${s.id}] (${s.category ?? "?"})`).join("\n");
  const messages = [
    {
      role: "system",
      content:
        "Sos consultor de automatización de Savante. Recomendá SÓLO items de la lista provista, " +
        "citando import_ref. No inventes. Precio dentro de: " + PRICING_GRID + " " +
        "El tier debe reflejar el ALCANCE: 1 automatización => 'Single Automation'; si recomendás " +
        "3 o más automatizaciones DISTINTAS (no variantes del mismo flujo) => tier='System' y precio " +
        "acorde. No subcotices. " +
        "roi_note: si el perfil trae volumen Y tiempo por unidad, estimá horas/mes recuperadas " +
        "(volumen × tiempo, redondeado) en una frase con el cálculo a la vista, marcado como estimación; " +
        "si faltan esos datos, devolvé roi_note=null. NUNCA inventes números. " +
        "watch_outs: 2-3 detalles que se suelen subestimar en ESTE flujo concreto (validación, formatos " +
        "variables, casos borde, manejo de errores). Específicos al caso, no genéricos. " +
        "Respondé SÓLO un JSON con: " +
        "summary, roi_note (string|null), watch_outs ([string]), " +
        "recommended_software ([{id,name,why}]), recommended_workflows ([{import_ref,name,why}]), " +
        "suggested_stack, complexity, implementation_days, price_estimate ({setup_usd:[min,max],care_plan_usd_mo:[min,max]}), tier. En español.",
    },
    {
      role: "user",
      content: `NEGOCIO: ${intake.company} (${intake.niche ?? ""}). Dolor: ${intake.pain_primary}. ` +
        `Herramientas: ${(intake.current_tools ?? []).join(", ")}. Presupuesto: ${intake.budget_band ?? "?"}.\n` +
        ((intake.pain_volume || intake.pain_time_each || intake.pain_cost)
          ? `MÉTRICAS PARA ROI: ${[
              intake.pain_volume && `Volumen: ${intake.pain_volume}.`,
              intake.pain_time_each && `Tiempo por unidad: ${intake.pain_time_each}.`,
              intake.pain_cost && `Costo del dolor: ${intake.pain_cost}.`,
            ].filter(Boolean).join(" ")}\n`
          : "") + `\n` +
        `WORKFLOWS n8n CANDIDATOS (elegí 2-4):\n${candidates || "(ninguno)"}\n\n` +
        `SOFTWARE OPEN-SOURCE CANDIDATO (elegí 0-3):\n${softwareList || "(ninguno)"}`,
    },
  ];
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "deepseek/deepseek-chat", messages, response_format: { type: "json_object" }, temperature: 0.3 }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content ?? "{}";
  const json = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  return JSON.parse(json);
}

/** Normaliza para matchear nombres entre la salida del LLM y los candidatos de la RPC. */
function norm(s: unknown) { return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim(); }

/**
 * Índice de URLs reales a partir de las filas de la RPC. La URL SIEMPRE sale de acá
 * (import_ref de la DB), nunca de lo que devuelva el LLM, que sólo elige qué ítems.
 * Sólo se indexan import_ref que sean URLs http(s) — algunos workflows curados no traen.
 */
// deno-lint-ignore no-explicit-any
function urlIndex(rows: any[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows ?? []) {
    const url = typeof r?.import_ref === "string" && /^https?:\/\//i.test(r.import_ref) ? r.import_ref : null;
    if (!url) continue;
    if (r.id != null) m.set(`id:${String(r.id)}`, url);
    m.set(`ref:${r.import_ref}`, url);
    if (r.name) m.set(`name:${norm(r.name)}`, url);
  }
  return m;
}

// deno-lint-ignore no-explicit-any
function renderHtml(i: Intake, rec: any, workflows: any[], software: any[]): string {
  const wfIdx = urlIndex(workflows);
  const swIdx = urlIndex(software);
  const wf = (rec.recommended_workflows ?? []).map((w: any) => {
    const url = wfIdx.get(`ref:${w.import_ref}`) ?? wfIdx.get(`name:${norm(w.name)}`);
    return `<li><b>${esc(w.name)}</b> — ${esc(w.why)}${url ? ` <a href="${esc(url)}" style="color:#666">(ver flujo de referencia)</a>` : ""}</li>`;
  }).join("");
  const sw = (rec.recommended_software ?? []).map((s: any) => {
    const url = swIdx.get(`id:${String(s.id)}`) ?? swIdx.get(`name:${norm(s.name)}`);
    return `<li><b>${esc(s.name)}</b> — ${esc(s.why)}${url ? ` <a href="${esc(url)}" style="color:#666">(sitio)</a>` : ""}</li>`;
  }).join("");
  const watch = (rec.watch_outs ?? []).map((w: string) => `<li>${esc(w)}</li>`).join("");
  const roiBlock = rec.roi_note
    ? `<div style="background:#f5f3ff;border-left:3px solid #7c3aed;padding:12px 16px;margin:20px 0;border-radius:4px">
    <p style="margin:0;font-weight:600">El número que importa</p><p style="margin:4px 0 0">${esc(rec.roi_note)}</p></div>`
    : "";
  const p = rec.price_estimate ?? { setup_usd: PRICING["Single Automation"].setup_usd, care_plan_usd_mo: CARE_PLAN_USD_MO };
  return `<!doctype html><html><body style="font-family:system-ui,Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px">
  <h2>Tu plan de automatización — ${esc(i.company)}</h2>
  <p>${esc(rec.summary ?? "")}</p>
  ${roiBlock}
  ${wf ? `<h3>Automatizaciones recomendadas</h3><ul>${wf}</ul>` : ""}
  ${sw ? `<h3>Software open-source sugerido</h3><ul>${sw}</ul>` : ""}
  <h3>Arquitectura</h3><p>${esc(rec.suggested_stack ?? "")}</p>
  ${watch ? `<h3>Lo que la mayoría subestima</h3>
  <p style="color:#666;margin:0 0 4px;font-size:14px">Donde estos flujos suelen fallar en producción —y por qué el detalle importa:</p><ul>${watch}</ul>` : ""}
  <h3 style="margin-bottom:2px">Estimado preliminar</h3>
  <p style="color:#666;margin:0 0 4px;font-size:14px">Rango orientativo según lo que nos contaste. La propuesta cerrada, a tu medida, la definimos en la llamada.</p>
  <p>Complejidad: <b>${esc(String(rec.complexity ?? ""))}</b> · Tiempo: <b>${rec.implementation_days ?? "?"} días</b><br>
  Setup: <b>${money(p.setup_usd)}</b> · Care Plan: <b>${money(p.care_plan_usd_mo)}/mes</b> · Plan: <b>${esc(String(rec.tier ?? ""))}</b></p>
  <p style="margin-top:24px">Para implementarlo en tu stack lo hacemos nosotros. Agendá una llamada y lo dejamos andando:</p>
  <p><a href="${esc(BOOKING_URL)}" style="background:#111;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Ver horarios disponibles</a></p>
  <p style="color:#666;font-size:14px">En esos 30 minutos lo aterrizamos a un caso real tuyo y te mostramos el flujo funcionando con tus propios datos.</p>
</body></html>`;
}

async function sendEmail(to: string, subject: string, html: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) { console.log("RESEND_API_KEY ausente — email no enviado (dry)"); return; }
  const from = Deno.env.get("MAIL_FROM") ?? "Savante <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}
