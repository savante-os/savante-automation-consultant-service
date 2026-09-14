/**
 * Deterministic facet extraction from n8n node types.
 * See docs/INGESTION_AND_TAGGING.md. No LLM / no embeddings here — pure rules.
 */

/** Core/control-flow nodes that are NOT integrations (noise for the `integrations` facet). */
export const PLUMBING = new Set<string>([
  "stickyNote", "set", "if", "switch", "code", "function", "functionItem",
  "merge", "splitInBatches", "splitOut", "filter", "aggregate", "noOp", "wait",
  "limit", "html", "dateTime", "itemLists", "sort", "removeDuplicates",
  "renameKeys", "compareDatasets", "summarize", "markdown", "xml", "crypto",
  "debugHelper", "executeWorkflow", "executeCommand", "respondToWebhook",
  "httpRequest", "httpRequestTool", "start", "stopAndError", "executionData",
  "convertToFile", "extractFromFile", "editImage", "readWriteFile",
  "moveBinaryData", "spreadsheetFile", "form", "formCompletion",
  "n8nTrainingCustomerDatastore", "n8nTrainingCustomerMessenger", "noOpTool",
  "dataTable", "rssFeedRead", "n8n", "ftp", "ssh", "graphql", "webhook",
  "respondToWebhookTool", "toolCode", "toolHttpRequest", "toolWorkflow",
]);

/** Trigger node base name -> canonical business input channel. */
const TRIGGER_CHANNEL: Record<string, string> = {
  scheduleTrigger: "schedule", cron: "schedule", interval: "schedule",
  formTrigger: "form", typeformTrigger: "form", jotFormTrigger: "form",
  formIoTrigger: "form", surveyMonkeyTrigger: "form", wufoo: "form",
  gmailTrigger: "email", microsoftOutlookTrigger: "email", emailReadImap: "email",
  postmarkTrigger: "email", mailjetTrigger: "email", mailerLiteTrigger: "email",
  telegramTrigger: "chat", slackTrigger: "chat", chatTrigger: "chat",
  discordTrigger: "chat", mcpTrigger: "chat",
  whatsAppTrigger: "whatsapp", twilioTrigger: "whatsapp",
  webhook: "webhook",
  manualTrigger: "manual", errorTrigger: "manual", evaluationTrigger: "manual",
  executeWorkflowTrigger: "manual", n8nTrigger: "manual",
  localFileTrigger: "file", googleDriveTrigger: "file",
  microsoftOneDriveTrigger: "file", boxTrigger: "file",
};

/** Friendly-name overrides where the node base name isn't presentable as-is. */
const NAME_ALIASES: Record<string, string> = {
  googleSheets: "Google Sheets", googleSheetsTool: "Google Sheets",
  googleDrive: "Google Drive", googleCalendar: "Google Calendar",
  googleDocs: "Google Docs", gmail: "Gmail", facebookGraphApi: "Facebook",
  facebookLeadAds: "Facebook Lead Ads", whatsApp: "WhatsApp",
  microsoftOutlook: "Outlook", microsoftExcel: "Excel", microsoftTeams: "Teams",
  hubspot: "HubSpot", wooCommerce: "WooCommerce", wordpress: "WordPress",
  openAi: "OpenAI", postgres: "Postgres", mySql: "MySQL", redis: "Redis",
  clickUp: "ClickUp", bambooHr: "BambooHR", quickbooks: "QuickBooks",
  pipedrive: "Pipedrive", salesforce: "Salesforce", airtable: "Airtable",
  notion: "Notion", slack: "Slack", telegram: "Telegram", stripe: "Stripe",
  shopify: "Shopify", twilio: "Twilio", zendesk: "Zendesk", jira: "Jira",
  github: "GitHub", gitlab: "GitLab", supabase: "Supabase", mongoDb: "MongoDB",
  linkedIn: "LinkedIn", youTube: "YouTube", googleBigQuery: "BigQuery",
  awsS3: "AWS S3", microsoftSql: "MS SQL", emailSend: "Email", spotify: "Spotify",
};

function titleize(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

/** Parse a raw n8n node type into its kind + base name. */
function parseType(type: string): { kind: "base" | "langchain" | "other"; base: string } {
  if (type.startsWith("n8n-nodes-base.")) return { kind: "base", base: type.slice("n8n-nodes-base.".length) };
  if (type.startsWith("@n8n/n8n-nodes-langchain.")) return { kind: "langchain", base: type.slice("@n8n/n8n-nodes-langchain.".length) };
  return { kind: "other", base: type };
}

export interface NodeFacets {
  integrations: string[];   // friendly app names (no plumbing, no triggers)
  triggerChannels: string[]; // canonical input channels
  hasAi: boolean;
  isRag: boolean;
}

/** Extract all node-derived facets from a list of raw node `type` strings. */
export function facetsFromNodeTypes(types: string[]): NodeFacets {
  const integrations = new Set<string>();
  const channels = new Set<string>();
  let hasAi = false;
  let isRag = false;

  for (const t of types) {
    const { kind, base } = parseType(t);

    if (kind === "langchain") {
      hasAi = true;
      if (/vectorStore|embeddings|documentDefaultDataLoader|textSplitter|retriever/i.test(base)) isRag = true;
      continue;
    }
    if (kind !== "base") continue;

    if (base in TRIGGER_CHANNEL) {
      const ch = TRIGGER_CHANNEL[base];
      if (ch !== "manual") channels.add(ch);
      continue;
    }
    if (/Trigger$/.test(base)) {
      // Unknown SaaS trigger -> "app-event" channel + count the app as an integration
      channels.add("app-event");
      const app = base.replace(/Trigger$/, "");
      if (!PLUMBING.has(app)) integrations.add(NAME_ALIASES[app] ?? titleize(app));
      continue;
    }
    if (base === "openAi") { hasAi = true; }
    // Normalize the "...Tool" variants (e.g. googleSheetsTool -> googleSheets)
    const norm = base.length > 4 && base.endsWith("Tool") ? base.slice(0, -4) : base;
    if (PLUMBING.has(norm)) continue;

    integrations.add(NAME_ALIASES[norm] ?? titleize(norm));
  }

  return {
    integrations: [...integrations].sort(),
    triggerChannels: [...channels].sort(),
    hasAi,
    isRag,
  };
}
