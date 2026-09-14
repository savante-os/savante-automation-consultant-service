/**
 * Tests for the pricing/scope invariants. The LLM output is non-deterministic,
 * so we don't test the model — we test the deterministic guardrails around it:
 * the prompt carries the rules, and normalizeRecommendation enforces price↔tier.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMessages,
  normalizeRecommendation,
  synthesize,
  PRICING,
  CARE_PLAN_USD_MO,
  type Recommendation,
} from "../src/recommend.js";
import type { Intake } from "../src/intake.js";
import type { CatalogRecord } from "../src/ingest-core.js";

const intake: Intake = {
  company: "Talento Norte Staffing",
  email: "mariana@example.com",
  pain_primary: "Procesamos a mano cientos de CVs que llegan por email.",
  current_tools: ["Gmail", "Google Sheets"],
  input_channels: ["email"],
  wants_ai: "ia",
};

function wf(id: string, name: string): CatalogRecord {
  return {
    id, source: "curated", name, category: "Gmail", path: `${id}.json`,
    import_ref: `https://n8n.io/workflows/${id}`, popularity: 1, description: "",
    integrations: ["Gmail"], trigger_type: ["email"], has_ai: true, is_rag: false,
    tags: [], license: null, stack: null, unmaintained: false, content: "",
  };
}

function rec(partial: Partial<Recommendation>): Recommendation {
  return {
    summary: "x",
    recommended_software: [],
    recommended_workflows: [],
    suggested_stack: "n8n",
    complexity: "Media",
    implementation_days: 5,
    price_estimate: { setup_usd: [0, 0], care_plan_usd_mo: [0, 0] },
    tier: "Single Automation",
    ...partial,
  };
}

test("normalize snaps Single Automation price to the grid", () => {
  const out = normalizeRecommendation(rec({ tier: "Single Automation", price_estimate: { setup_usd: [50, 99], care_plan_usd_mo: [1, 2] } }));
  assert.deepEqual(out.price_estimate.setup_usd, [...PRICING["Single Automation"].setup_usd]);
  assert.deepEqual(out.price_estimate.care_plan_usd_mo, [...CARE_PLAN_USD_MO]);
});

test("normalize fixes a System tier the LLM underpriced (anti-subcotización)", () => {
  // LLM picked System but left a Single-sized number — code corrects the price.
  const out = normalizeRecommendation(rec({ tier: "System", price_estimate: { setup_usd: [800, 1500], care_plan_usd_mo: [150, 400] } }));
  assert.deepEqual(out.price_estimate.setup_usd, [2000, 4000]);
});

test("normalize leaves an unknown/custom tier untouched", () => {
  const input = rec({ tier: "Enterprise XL", price_estimate: { setup_usd: [9999, 99999], care_plan_usd_mo: [1, 1] } });
  const out = normalizeRecommendation(input);
  assert.deepEqual(out.price_estimate.setup_usd, [9999, 99999]);
});

test("prompt carries the scope→tier rule and the grid numbers", () => {
  const msgs = buildMessages(intake, [wf("a", "A")], []);
  const system = msgs[0].content;
  assert.match(system, /3 o más automatizaciones DISTINTAS/);
  assert.match(system, /tier='System'/);
  assert.match(system, /Single Automation 800-1500/);
  assert.match(system, /System 2000-4000/);
});

test("mock path returns a grid-valid Single Automation for one automation", async () => {
  const out = await synthesize(intake, [wf("a", "A")], [], { mock: true });
  assert.equal(out.tier, "Single Automation");
  assert.deepEqual(out.price_estimate.setup_usd, [800, 1500]);
});
