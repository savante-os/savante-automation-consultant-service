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
  googleCalendarTool: "Google Calendar", googleDocs: "Google Docs",
  googleDocsTool: "Google Docs", gmail: "Gmail", gmailTool: "Gmail",
  facebookGraphApi: "Facebook", facebookLeadAds: "Facebook Lead Ads",
  whatsApp: "WhatsApp", telegram: "Telegram", telegramTool: "Telegram",
  microsoftOutlook: "Outlook", microsoftOutlookTool: "Outlook",
  microsoftExcel: "Excel", microsoftTeams: "Teams", microsoftOneDrive: "Microsoft One Drive",
  hubspot: "HubSpot", wooCommerce: "WooCommerce", wooCommerceTool: "WooCommerce",
  wordpress: "WordPress", openAi: "OpenAI", postgres: "Postgres", postgresTool: "Postgres",
  mySql: "MySQL", mySqlTool: "MySQL", redis: "Redis",
  clickUp: "ClickUp", bambooHr: "BambooHR", quickbooks: "QuickBooks",
  pipedrive: "Pipedrive", salesforce: "Salesforce", airtable: "Airtable",
  airtableTool: "Airtable", notion: "Notion", notionTool: "Notion",
  slack: "Slack", stripe: "Stripe", shopify: "Shopify", twilio: "Twilio",
  zendesk: "Zendesk", jira: "Jira", jiraTool: "Jira", github: "GitHub",
  gitlab: "GitLab", supabase: "Supabase", mongoDb: "MongoDB", mongoDbTool: "MongoDB",
  linkedIn: "LinkedIn", youTube: "YouTube", googleBigQuery: "BigQuery",
  awsS3: "AWS S3", microsoftSql: "MS SQL", emailSend: "Email", spotify: "Spotify",
  discord: "Discord", trello: "Trello", baserow: "Baserow", baserowTool: "Baserow",
  nocoDb: "Noco Db", wordpressTool: "WordPress", monday: "Monday Com",
  mondayCom: "Monday Com", reddit: "Reddit", twitter: "Twitter", linkedInTool: "LinkedIn",
  webflow: "Webflow", strava: "Strava", zoom: "Zoom",
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

/** Non-trigger node base name -> canonical business output/destination channel. */
const SINK_CHANNEL: Record<string, string> = {
  googleSheets: "spreadsheet", microsoftExcel: "spreadsheet", spreadsheetFile: "spreadsheet",
  airtable: "spreadsheet", baserow: "spreadsheet", nocoDb: "spreadsheet",
  gmail: "email", microsoftOutlook: "email", emailSend: "email", emailReadImap: "email",
  sendGrid: "email", mailjet: "email", mailerLite: "email",
  slack: "chat", telegram: "chat", discord: "chat", whatsApp: "chat",
  mattermost: "chat", teams: "chat", microsoftTeams: "chat",
  postgres: "database", mySql: "database", mongoDb: "database", supabase: "database",
  redis: "database", mssql: "database", microsoftSql: "database", snowflake: "database",
  hubspot: "crm", pipedrive: "crm", salesforce: "crm", zohoCrm: "crm", copper: "crm",
  googleDocs: "document", notion: "document", confluence: "document", googleSlides: "document",
  twilio: "notification", pushover: "notification", pagerDuty: "notification",
};

export interface NodeFacets {
  integrations: string[];   // friendly app names (no plumbing, no triggers)
  triggerChannels: string[]; // canonical input channels
  outputTargets: string[];   // canonical output/destination channels
  hasAi: boolean;
  isRag: boolean;
}

/** Extract all node-derived facets from a list of raw node `type` strings. */
export function facetsFromNodeTypes(types: string[]): NodeFacets {
  const integrations = new Set<string>();
  const channels = new Set<string>();
  const outputs = new Set<string>();
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
    if (norm in SINK_CHANNEL) outputs.add(SINK_CHANNEL[norm]);
    if (PLUMBING.has(norm)) continue;

    integrations.add(NAME_ALIASES[norm] ?? titleize(norm));
  }

  return {
    integrations: [...integrations].sort(),
    triggerChannels: [...channels].sort(),
    outputTargets: [...outputs].sort(),
    hasAi,
    isRag,
  };
}
