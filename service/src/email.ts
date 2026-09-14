/**
 * Render the recommendation as an HTML email and deliver it.
 * Provider: Resend (HTTP API — works in both Node and Deno edge functions).
 * Swap providers by replacing `sendEmail` only. Dry-run writes the email to disk.
 */
import type { Intake } from "./intake.js";
import type { Recommendation } from "./recommend.js";

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}
const money = (r: [number, number]) => `USD ${r[0]}–${r[1]}`;

/** Booking link shown as the email CTA. Override with BOOKING_URL in .env. */
const BOOKING_URL = process.env.BOOKING_URL ?? "https://cal.com/your-handle/intro";

export function renderEmailHtml(i: Intake, rec: Recommendation): string {
  const wf = rec.recommended_workflows.map((w) =>
    `<li><b>${esc(w.name)}</b> — ${esc(w.why)}${w.import_ref ? ` <a href="${esc(w.import_ref)}" style="color:#666">(ver flujo de referencia)</a>` : ""}</li>`).join("");
  const sw = rec.recommended_software.map((s) =>
    `<li><b>${esc(s.name)}</b> — ${esc(s.why)}</li>`).join("");
  const watch = (rec.watch_outs ?? []).map((w) => `<li>${esc(w)}</li>`).join("");

  const roiBlock = rec.roi_note
    ? `<div style="background:#f5f3ff;border-left:3px solid #7c3aed;padding:12px 16px;margin:20px 0;border-radius:4px">
    <p style="margin:0;font-weight:600">El número que importa</p>
    <p style="margin:4px 0 0">${esc(rec.roi_note)}</p>
  </div>`
    : "";

  return `<!doctype html><html><body style="font-family:system-ui,Arial,sans-serif;color:#1a1a1a;max-width:640px;margin:0 auto;padding:24px">
  <h2 style="margin:0 0 4px">Tu plan de automatización — ${esc(i.company)}</h2>
  <p style="color:#666;margin:0 0 20px">Preparado por Savante a partir de lo que nos contaste.</p>

  <p>${esc(rec.summary)}</p>

  ${roiBlock}

  ${wf ? `<h3>Automatizaciones recomendadas</h3><ul>${wf}</ul>` : ""}
  ${sw ? `<h3>Software open-source sugerido</h3><ul>${sw}</ul>` : ""}

  <h3>Arquitectura propuesta</h3>
  <p>${esc(rec.suggested_stack)}</p>

  ${watch ? `<h3>Lo que la mayoría subestima</h3>
  <p style="color:#666;margin:0 0 4px;font-size:14px">Donde estos flujos suelen fallar en producción —y por qué el detalle importa:</p>
  <ul>${watch}</ul>` : ""}

  <h3 style="margin-bottom:2px">Estimado preliminar</h3>
  <p style="color:#666;margin:0 0 4px;font-size:14px">Rango orientativo según lo que nos contaste. La propuesta cerrada, a tu medida, la definimos en la llamada.</p>
  <table style="border-collapse:collapse;margin:12px 0">
    <tr><td style="padding:4px 16px 4px 0;color:#666">Complejidad</td><td><b>${esc(String(rec.complexity))}</b></td></tr>
    <tr><td style="padding:4px 16px 4px 0;color:#666">Tiempo estimado</td><td><b>${rec.implementation_days} días</b></td></tr>
    <tr><td style="padding:4px 16px 4px 0;color:#666">Inversión (setup)</td><td><b>${money(rec.price_estimate.setup_usd)}</b></td></tr>
    <tr><td style="padding:4px 16px 4px 0;color:#666">Care Plan</td><td><b>${money(rec.price_estimate.care_plan_usd_mo)}/mes</b></td></tr>
    <tr><td style="padding:4px 16px 4px 0;color:#666">Plan sugerido</td><td><b>${esc(String(rec.tier))}</b></td></tr>
  </table>

  <p style="margin-top:24px">Para implementarlo en tu stack lo hacemos nosotros. Agendá una llamada y lo dejamos andando:</p>
  <p><a href="${esc(BOOKING_URL)}" style="background:#111;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Ver horarios disponibles</a></p>
  <p style="color:#666;font-size:14px">En esos 30 minutos lo aterrizamos a un caso real tuyo y te mostramos el flujo funcionando con tus propios datos.</p>
  <p style="color:#999;font-size:12px;margin-top:24px">Recibís esto porque pediste un plan de automatización en Savante. Si no fuiste vos, ignoralo.</p>
</body></html>`;
}

export const emailSubject = (i: Intake) => `Tu plan de automatización para ${i.company} · Savante`;

export interface SendOptions {
  apiKey?: string;
  from?: string;
  dryRunDir?: string;   // if set (and no key), write the email here instead of sending
}

export interface SendResult { delivered: boolean; via: "resend" | "dry-run"; id?: string; path?: string }

export async function sendEmail(
  to: string, subject: string, html: string, opts: SendOptions = {},
): Promise<SendResult> {
  const key = opts.apiKey ?? process.env.RESEND_API_KEY;
  const from = opts.from ?? process.env.MAIL_FROM ?? "Savante <onboarding@resend.dev>";

  if (!key) {
    // Dry-run: persist the rendered email so we can inspect it without sending.
    if (opts.dryRunDir) {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await mkdir(opts.dryRunDir, { recursive: true });
      const path = join(opts.dryRunDir, `email-${to.replace(/[^a-z0-9]/gi, "_")}.html`);
      await writeFile(path, html);
      return { delivered: false, via: "dry-run", path };
    }
    return { delivered: false, via: "dry-run" };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { delivered: true, via: "resend", id: data?.id };
}
