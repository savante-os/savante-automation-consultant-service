/**
 * Tests for the email render: positioning copy, the booking CTA, the template
 * link as proof (not deliverable), HTML-escaping, and price visibility.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEmailHtml, emailSubject } from "../src/email.js";
import type { Intake } from "../src/intake.js";
import type { Recommendation } from "../src/recommend.js";

const intake: Intake = {
  company: "Acme & <Co>",
  email: "x@example.com",
  pain_primary: "p",
};

const rec: Recommendation = {
  summary: "Resumen del plan.",
  roi_note: "Estimado: ~200/semana × 10 min ≈ 130 hs/mes recuperadas.",
  watch_outs: [
    "Los CVs llegan en formatos dispares: hace falta validación, no sólo el caso feliz.",
    "Sin reintentos, una caída de la API pierde candidatos sin aviso.",
  ],
  recommended_software: [],
  recommended_workflows: [
    { import_ref: "https://n8n.io/workflows/123", name: "CV Screening", why: "Cubre el flujo." },
    { import_ref: null, name: "Sin link", why: "No tiene template." },
  ],
  suggested_stack: "n8n + Gmail + Sheets",
  complexity: "Media",
  implementation_days: 5,
  price_estimate: { setup_usd: [800, 1500], care_plan_usd_mo: [150, 400] },
  tier: "Single Automation",
};

test("escapes HTML in user-provided fields (no injection)", () => {
  const html = renderEmailHtml(intake, rec);
  assert.match(html, /Acme &amp; &lt;Co&gt;/);
  assert.doesNotMatch(html, /Acme & <Co>/);
});

test("CTA points to the configured booking URL, not a hardcoded personal link", () => {
  const html = renderEmailHtml(intake, rec);
  // Default when BOOKING_URL is unset; override it via the environment.
  assert.match(html, /href="https:\/\/cal\.com\/your-handle\/intro"/);
  // Guard against a personal/hardcoded booking link creeping back in: the only
  // booking host in the output must be the configured default.
  const bookingLinks = [...html.matchAll(/href="(https:\/\/cal\.com\/[^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(bookingLinks, ["https://cal.com/your-handle/intro"]);
});

test("frames the price as a preliminary estimate, not a closed quote", () => {
  const html = renderEmailHtml(intake, rec);
  assert.match(html, /Estimado preliminar/);
  assert.match(html, /USD 800–1500/);
  assert.match(html, /USD 150–400\/mes/);
});

test("template link renders as proof only when import_ref exists", () => {
  const html = renderEmailHtml(intake, rec);
  // present for the workflow that has a template...
  assert.match(html, /href="https:\/\/n8n\.io\/workflows\/123"[^>]*>\(ver flujo de referencia\)</);
  // ...and the workflow without import_ref shows no link
  const sinLinkFragment = html.slice(html.indexOf("Sin link"));
  assert.doesNotMatch(sinLinkFragment.slice(0, 80), /href=/);
});

test("renders the quantified ROI block when roi_note is present", () => {
  const html = renderEmailHtml(intake, rec);
  assert.match(html, /El número que importa/);
  assert.match(html, /130 hs\/mes/);
});

test("omits the ROI block when roi_note is null/absent", () => {
  const html = renderEmailHtml(intake, { ...rec, roi_note: null });
  assert.doesNotMatch(html, /El número que importa/);
});

test("renders watch-outs as the expertise signal", () => {
  const html = renderEmailHtml(intake, rec);
  assert.match(html, /Lo que la mayoría subestima/);
  assert.match(html, /validación/);
});

test("subject includes the company name", () => {
  assert.match(emailSubject(intake), /Acme & <Co>/);
});
