#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import * as dotenv from "dotenv";
import * as fs from "fs";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Config {
  apiKey: string;
  baseUrl: string;
  integrationApiKey?: string;
}

function loadConfig(): Config | null {
  // Primary: read directly from process.env (set via the MCP host's env block)
  let apiKey = (process.env.TALON_MANAGEMENT_API_KEY ?? process.env.TALON_API_KEY)?.trim();
  let baseUrl = process.env.TALON_BASE_URL?.trim().replace(/\/$/, "");
  let integrationApiKey = process.env.TALON_INTEGRATION_API_KEY?.trim();

  // Fallback: load from a .env file for local development
  if (!apiKey || !baseUrl) {
    const envFile =
      process.env.TALON_ENV_FILE ??
      `${process.env.HOME}/.claude/channels/talonone/.env`;
    try {
      const raw = fs.readFileSync(envFile, "utf-8");
      const parsed = dotenv.parse(raw);
      apiKey ??= (parsed.TALON_MANAGEMENT_API_KEY ?? parsed.TALON_API_KEY)?.trim();
      baseUrl ??= parsed.TALON_BASE_URL?.trim().replace(/\/$/, "");
      integrationApiKey ??= parsed.TALON_INTEGRATION_API_KEY?.trim();
    } catch {
      // no .env file present, that's fine
    }
  }

  if (apiKey && baseUrl) return { apiKey, baseUrl, integrationApiKey };
  return null;
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

async function talonFetch(
  config: Config,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const url = `${config.baseUrl}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `ManagementKey-v1 ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }

  if (!res.ok) {
    const code =
      res.status >= 500 ? ErrorCode.InternalError : ErrorCode.InvalidRequest;
    throw new McpError(
      code,
      `Talon.One API error ${res.status}: ${typeof json === "string" ? json : JSON.stringify(json)}`
    );
  }

  return json;
}

// ---------------------------------------------------------------------------
// Integration API HTTP client
// ---------------------------------------------------------------------------

async function integrationFetch(
  config: Config,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  if (!config.integrationApiKey) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Integration API key not configured. Run /talonone:configure to add your TALON_INTEGRATION_API_KEY."
    );
  }

  const url = `${config.baseUrl}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `ApiKey-v1 ${config.integrationApiKey}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }

  if (!res.ok) {
    const code =
      res.status >= 500 ? ErrorCode.InternalError : ErrorCode.InvalidRequest;
    throw new McpError(
      code,
      `Talon.One Integration API error ${res.status}: ${typeof json === "string" ? json : JSON.stringify(json)}`
    );
  }

  return json;
}

// ---------------------------------------------------------------------------
// Template cache (module-level, lives for the server process lifetime)
// ---------------------------------------------------------------------------

let templateCache: TalonTemplate[] | null = null;

interface TalonTemplateParam {
  name: string;
  type: string;
  description: string;
  attribute_id?: number;
}

interface TalonTemplate {
  id: number;
  name: string;
  description: string;
  instructions: string;
  state: string;
  applicationsIds: number[];
  templateParams: TalonTemplateParam[];
  campaignType?: string;
  tags?: string[];
  features?: string[];
}

async function fetchAllTemplates(config: Config): Promise<TalonTemplate[]> {
  if (templateCache) return templateCache;
  const result = (await talonFetch(config, "GET", "/v1/campaign_templates")) as {
    data: TalonTemplate[];
  };
  templateCache = result.data ?? [];
  return templateCache;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: "talonone", version: "0.1.0" },
  {
    instructions: `You help users create Talon.One campaigns conversationally.

Rules:
1. Campaigns MUST be created from a template — always call list_campaign_templates first if the user hasn't specified one.
2. After the user picks a template, call get_campaign_template to read its template_params (placeholder definitions).
3. Try to infer placeholder values from what the user already said (match by param name, description, and type).
4. For any remaining unfilled params, ask ONE question at a time — include the param description and type as context.
5. Confirm all placeholder values before calling create_campaign_from_template.
6. Only "available" state templates can be used.`,
  }
);

// ---------------------------------------------------------------------------
// Tool: list_applications
// ---------------------------------------------------------------------------

server.tool(
  "list_applications",
  "List all Talon.One applications (deployments) accessible with the configured API key.",
  {},
  async () => {
    const config = loadConfig();
    if (!config) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Talon.One credentials not configured. Run /talonone:configure to set up your API key and base URL.",
          },
        ],
      };
    }

    const result = (await talonFetch(config, "GET", "/v1/applications")) as {
      data: Array<{ id: number; name: string; description?: string; currency?: string; timezone?: string }>;
    };

    const apps = result.data ?? [];
    if (apps.length === 0) {
      return { content: [{ type: "text" as const, text: "No applications found." }] };
    }

    const text = apps
      .map(
        (a) =>
          `ID: ${a.id} | Name: ${a.name}${a.description ? ` | ${a.description}` : ""}${a.currency ? ` | Currency: ${a.currency}` : ""}`
      )
      .join("\n");

    return { content: [{ type: "text" as const, text }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: list_campaign_templates
// ---------------------------------------------------------------------------

server.tool(
  "list_campaign_templates",
  "List campaign templates available for a specific Talon.One application. Only returns templates with state 'available'.",
  {
    applicationId: z
      .coerce.number()
      .int()
      .describe("The ID of the Talon.One application to filter templates for."),
  },
  async ({ applicationId }) => {
    const config = loadConfig();
    if (!config) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Talon.One credentials not configured. Run /talonone:configure to set up your API key and base URL.",
          },
        ],
      };
    }

    const all = await fetchAllTemplates(config);
    const templates = all.filter(
      (t) =>
        t.state === "available" || t.state === "enabled"
    ).filter(
      (t) =>
        !Array.isArray(t.applicationsIds) ||
        t.applicationsIds.length === 0 ||
        t.applicationsIds.includes(applicationId)
    );

    if (templates.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No available campaign templates found for application ${applicationId}.`,
          },
        ],
      };
    }

    const text = templates
      .map((t) => {
        const paramNames =
          t.templateParams?.map((p) => p.name).join(", ") || "none";
        return `ID: ${t.id} | Name: ${t.name}\n  Description: ${t.description || "(none)"}\n  Placeholders: ${paramNames}`;
      })
      .join("\n\n");

    return { content: [{ type: "text" as const, text }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: get_campaign_template
// ---------------------------------------------------------------------------

server.tool(
  "get_campaign_template",
  "Get full details of a campaign template including its placeholder parameters (template_params). Call this after the user picks a template to understand what values need to be filled.",
  {
    applicationId: z
      .coerce.number()
      .int()
      .describe("The ID of the Talon.One application."),
    templateId: z
      .coerce.number()
      .int()
      .describe("The ID of the campaign template to retrieve."),
  },
  async ({ applicationId, templateId }) => {
    const config = loadConfig();
    if (!config) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Talon.One credentials not configured. Run /talonone:configure to set up your API key and base URL.",
          },
        ],
      };
    }

    const all = await fetchAllTemplates(config);
    const matchesApp = (t: TalonTemplate) =>
      !Array.isArray(t.applicationsIds) ||
      t.applicationsIds.length === 0 ||
      t.applicationsIds.includes(applicationId);

    const template = all.find((t) => t.id === templateId && matchesApp(t));

    if (!template) {
      // Invalidate cache and retry once
      templateCache = null;
      const refreshed = await fetchAllTemplates(config);
      const retried = refreshed.find((t) => t.id === templateId && matchesApp(t));
      if (!retried) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Template ${templateId} not found for application ${applicationId}.`,
            },
          ],
        };
      }
      return formatTemplate(retried);
    }

    return formatTemplate(template);
  }
);

function formatTemplate(t: TalonTemplate) {
  const params =
    t.templateParams?.length > 0
      ? t.templateParams
          .map(
            (p) =>
              `  - ${p.name} (${p.type}): ${p.description || "(no description)"}`
          )
          .join("\n")
      : "  (no placeholders)";

  const text = [
    `Template ID: ${t.id}`,
    `Name: ${t.name}`,
    `Description: ${t.description || "(none)"}`,
    `Instructions: ${t.instructions || "(none)"}`,
    `State: ${t.state}`,
    `Campaign type: ${t.campaignType || "advanced"}`,
    `Tags: ${t.tags?.join(", ") || "(none)"}`,
    `Features: ${t.features?.join(", ") || "(none)"}`,
    ``,
    `Placeholders (template_params):`,
    params,
  ].join("\n");

  return { content: [{ type: "text" as const, text }] };
}

// ---------------------------------------------------------------------------
// Tool: create_campaign_from_template
// ---------------------------------------------------------------------------

const BindingSchema = z.object({
  name: z.string().describe("Must match a templateParams[].name exactly."),
  type: z.string().optional().describe("Binding kind, e.g. 'templateParameter'."),
  expression: z.array(z.unknown()).describe("A Talang expression, e.g. ['identity', value]."),
  valueType: z.string().optional().describe("'string', 'number', or 'boolean'."),
  attributeId: z.coerce.number().optional(),
  description: z.string().optional(),
  minValue: z.coerce.number().optional(),
  maxValue: z.coerce.number().optional(),
});

server.tool(
  "create_campaign_from_template",
  "Create a new campaign in a Talon.One application from a template, supplying values for all required template placeholders.",
  {
    applicationId: z
      .coerce.number()
      .int()
      .describe("The ID of the Talon.One application."),
    templateId: z
      .coerce.number()
      .int()
      .describe("The ID of the campaign template to use."),
    name: z.string().describe("A user-facing name for the new campaign."),
    description: z
      .string()
      .optional()
      .describe("Optional description for the campaign."),
    tags: z
      .array(z.string())
      .optional()
      .describe("Optional list of tags for the campaign."),
    templateParamValues: z
      .array(BindingSchema)
      .optional()
      .describe(
        "Values for template placeholders. Each entry must have a 'name' matching a template_params entry and an 'expression' array."
      ),
  },
  async ({ applicationId, templateId, name, description, tags, templateParamValues }) => {
    const config = loadConfig();
    if (!config) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Talon.One credentials not configured. Run /talonone:configure to set up your API key and base URL.",
          },
        ],
      };
    }

    const body: Record<string, unknown> = {
      name,
      templateId: templateId,
    };
    if (description) body.description = description;
    if (tags?.length) body.tags = tags;
    if (templateParamValues?.length) {
      body.templateParamValues = templateParamValues.map((b) => ({
        name: b.name,
        type: b.type ?? "templateParameter",
        expression: b.expression,
        valueType: b.valueType,
      }));
    }

    const result = await talonFetch(
      config,
      "POST",
      `/v1/applications/${applicationId}/create_campaign_from_template`,
      body
    );

    const res = result as {
      campaign?: { id?: number; name?: string; state?: string; templateId?: number };
      id?: number; name?: string; state?: string; templateId?: number;
    };
    const campaign = res.campaign ?? res;

    const text = [
      `Campaign created successfully!`,
      `ID: ${campaign.id}`,
      `Name: ${campaign.name}`,
      `State: ${campaign.state}`,
    ].join("\n");

    return { content: [{ type: "text" as const, text }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: create_attribute
// ---------------------------------------------------------------------------

server.tool(
  "create_attribute",
  "Create a new custom attribute in Talon.One for a given entity (e.g. CustomerProfile, CustomerSession, CartItem, Coupon, Campaign, Event).",
  {
    entity: z
      .enum(["CustomerProfile", "CustomerSession", "CartItem", "Coupon", "Campaign", "Event"])
      .describe("The entity this attribute belongs to."),
    name: z
      .string()
      .describe("Internal camelCase name for the attribute (e.g. 'loyaltyTier'). No spaces."),
    title: z
      .string()
      .describe("Human-readable display name shown in the Talon.One UI."),
    type: z
      .enum(["string", "number", "boolean", "time", "(list string)", "(list number)", "(list time)", "(list location)"])
      .describe("Data type of the attribute."),
    description: z
      .string()
      .describe("A short description of what this attribute represents."),
    editable: z
      .boolean()
      .optional()
      .describe("Whether this attribute can be edited after creation. Defaults to true."),
    suggestions: z
      .array(z.string())
      .optional()
      .describe("Optional list of suggested values shown in the UI."),
    eventType: z
      .string()
      .optional()
      .describe("Required when entity is 'Event' — the event type this attribute belongs to."),
  },
  async ({ entity, name, title, type, description, editable = true, suggestions = [], eventType }) => {
    const config = loadConfig();
    if (!config) {
      return {
        content: [{
          type: "text" as const,
          text: "Talon.One credentials not configured. Run /talonone:configure to set up your API key and base URL.",
        }],
      };
    }

    const body: Record<string, unknown> = {
      entity,
      name,
      title,
      type,
      description,
      editable,
      suggestions,
    };
    if (eventType) body.eventType = eventType;

    const result = await talonFetch(config, "POST", "/v1/attributes", body) as {
      id?: number;
      name?: string;
      title?: string;
      entity?: string;
      type?: string;
    };

    const text = [
      `Attribute created successfully!`,
      `ID: ${result.id}`,
      `Name: ${result.name}`,
      `Title: ${result.title}`,
      `Entity: ${result.entity}`,
      `Type: ${result.type}`,
    ].join("\n");

    return { content: [{ type: "text" as const, text }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: list_attributes
// ---------------------------------------------------------------------------

server.tool(
  "list_attributes",
  "List all custom attributes defined in this Talon.One account, optionally filtered by entity type. Use this to discover available attributes before constructing a session payload — only attributes returned here may be used.",
  {
    entity: z
      .enum(["CustomerProfile", "CustomerSession", "CartItem", "Coupon", "Campaign", "Event"])
      .optional()
      .describe("Filter attributes by entity type. Omit to return all attributes."),
  },
  async ({ entity }) => {
    const config = loadConfig();
    if (!config) {
      return {
        content: [{
          type: "text" as const,
          text: "Talon.One credentials not configured. Run /talonone:configure to set up your API key and base URL.",
        }],
      };
    }

    const qs = entity ? `?entity=${encodeURIComponent(entity)}&pageSize=1000` : "?pageSize=1000";
    const result = (await talonFetch(config, "GET", `/v1/attributes${qs}`)) as {
      data: Array<{ id: number; entity: string; name: string; title: string; type: string; description?: string }>;
    };

    const attrs = result.data ?? [];
    if (attrs.length === 0) {
      return { content: [{ type: "text" as const, text: "No custom attributes found." }] };
    }

    const text = attrs
      .map((a) => `[${a.entity}] ${a.name} (${a.type})${a.title ? ` — "${a.title}"` : ""}${a.description ? `: ${a.description}` : ""}`)
      .join("\n");

    return { content: [{ type: "text" as const, text }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: list_customer_profiles
// ---------------------------------------------------------------------------

server.tool(
  "list_customer_profiles",
  "List customer profiles in a Talon.One application. Use this during quiz mode to show the user which existing profiles they can test against.",
  {
    applicationId: z
      .coerce.number()
      .int()
      .describe("The ID of the Talon.One application."),
    pageSize: z
      .coerce.number()
      .int()
      .optional()
      .describe("Maximum number of profiles to return. Defaults to 20."),
  },
  async ({ applicationId, pageSize = 20 }) => {
    const config = loadConfig();
    if (!config) {
      return {
        content: [{
          type: "text" as const,
          text: "Talon.One credentials not configured. Run /talonone:configure to set up your API key and base URL.",
        }],
      };
    }

    const result = (await talonFetch(
      config,
      "GET",
      `/v1/applications/${applicationId}/customers?pageSize=${pageSize}`
    )) as {
      data: Array<{ id: number; integrationId: string; created?: string; attributes?: Record<string, unknown> }>;
      totalResultSize?: number;
    };

    const profiles = result.data ?? [];
    if (profiles.length === 0) {
      return { content: [{ type: "text" as const, text: "No customer profiles found for this application." }] };
    }

    const total = result.totalResultSize ?? profiles.length;
    const lines = profiles.map((p) => {
      const attrs = p.attributes && Object.keys(p.attributes).length > 0
        ? ` | Attributes: ${Object.entries(p.attributes).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}`
        : "";
      return `Integration ID: ${p.integrationId}${attrs}`;
    });

    const header = total > profiles.length
      ? `Showing ${profiles.length} of ${total} profiles:\n`
      : `${profiles.length} profile(s):\n`;

    return { content: [{ type: "text" as const, text: header + lines.join("\n") }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: update_customer_session
// ---------------------------------------------------------------------------

const CartItemSchema = z.object({
  name: z.string().describe("Product name."),
  sku: z.string().describe("Product SKU or identifier."),
  quantity: z.coerce.number().describe("Number of units."),
  price: z.coerce.number().describe("Unit price (in the account's base currency)."),
  category: z.string().optional().describe("Product category."),
  weight: z.coerce.number().optional().describe("Item weight in grams."),
  attributes: z.record(z.unknown()).optional().describe("Custom CartItem attributes."),
});

server.tool(
  "update_customer_session",
  "Create or update a customer session in Talon.One via the Integration API. This triggers campaign evaluation and returns the effects (discounts, loyalty points, coupons) along with which campaigns fired or failed. Use this as the core tool for basket/cart testing.",
  {
    sessionId: z
      .string()
      .describe("A unique identifier for this test session. Use any string — it will be created if it doesn't exist."),
    profileId: z
      .string()
      .describe("The integration ID of an existing customer profile. Must already exist — never pass a new profile ID."),
    state: z
      .enum(["open", "closed", "cancelled"])
      .describe("Session state: 'open' = active/shopping, 'closed' = checkout complete, 'cancelled' = abandoned."),
    cartItems: z
      .array(CartItemSchema)
      .optional()
      .describe("Items in the cart/basket."),
    couponCodes: z
      .array(z.string())
      .optional()
      .describe("Coupon codes to apply to this session."),
    referralCode: z
      .string()
      .optional()
      .describe("Referral code to apply."),
    channel: z
      .string()
      .optional()
      .describe("Sales channel (e.g. 'retail_web', 'mobile_app'). Must match a configured channel in Talon.One."),
    attributes: z
      .record(z.unknown())
      .optional()
      .describe("Custom CustomerSession attributes. Only include attributes returned by list_attributes for the CustomerSession entity."),
    dry: z
      .boolean()
      .optional()
      .describe("If true, evaluates the session without persisting any changes or effects. Useful for previewing campaign outcomes."),
    now: z
      .string()
      .optional()
      .describe("Override the current timestamp for campaign evaluation. ISO 8601 format, e.g. '2026-12-24T18:00:00Z'. Use this to test time-based campaigns at a specific date/time."),
  },
  async ({ sessionId, profileId, state, cartItems, couponCodes, referralCode, channel, attributes, dry, now }) => {
    const config = loadConfig();
    if (!config) {
      return {
        content: [{
          type: "text" as const,
          text: "Talon.One credentials not configured. Run /talonone:configure to set up your API key and base URL.",
        }],
      };
    }

    const sessionBody: Record<string, unknown> = { profileId, state };
    if (cartItems?.length) sessionBody.cartItems = cartItems;
    if (couponCodes?.length) sessionBody.couponCodes = couponCodes;
    if (referralCode) sessionBody.referralCode = referralCode;
    if (channel) sessionBody.channel = channel;
    if (attributes && Object.keys(attributes).length > 0) sessionBody.attributes = attributes;

    const body = { customerSession: sessionBody };

    const params = new URLSearchParams();
    if (dry) params.set("dry", "true");
    if (now) params.set("now", now);
    const qs = params.size > 0 ? `?${params.toString()}` : "";

    const result = await integrationFetch(config, "PUT", `/v2/customer_sessions/${encodeURIComponent(sessionId)}${qs}`, body) as {
      session?: {
        id?: string;
        profileId?: string;
        state?: string;
        cartItems?: unknown[];
        total?: number;
        attributes?: Record<string, unknown>;
      };
      customerProfile?: {
        integrationId?: string;
        attributes?: Record<string, unknown>;
      };
      effects?: Array<{
        campaignId?: number;
        rulesetId?: number;
        ruleIndex?: number;
        ruleName?: string;
        effectType?: string;
        props?: Record<string, unknown>;
      }>;
      ruleFailureReasons?: Array<{
        campaignId?: number;
        campaignName?: string;
        rulesetId?: number;
        totalResultSize?: number;
        ruleIndex?: number;
        ruleName?: string;
        failureCode?: string;
      }>;
      triggeredCampaigns?: Array<{
        id?: number;
        name?: string;
      }>;
    };

    // Format a structured summary for the skill to deconstruct
    const lines: string[] = [];

    const session = result.session;
    if (session) {
      lines.push(`=== Session ===`);
      lines.push(`ID: ${sessionId}`);
      lines.push(`Profile: ${session.profileId ?? profileId}`);
      lines.push(`State: ${session.state ?? state}`);
      if (session.total !== undefined) lines.push(`Cart Total: ${session.total}`);
    }

    const effects = result.effects ?? [];
    lines.push(`\n=== Effects (${effects.length}) ===`);
    if (effects.length === 0) {
      lines.push("No effects applied.");
    } else {
      for (const e of effects) {
        const props = e.props ? ` — ${JSON.stringify(e.props)}` : "";
        lines.push(`[Campaign ${e.campaignId}] ${e.effectType}${props}${e.ruleName ? ` (rule: ${e.ruleName})` : ""}`);
      }
    }

    const failures = result.ruleFailureReasons ?? [];
    lines.push(`\n=== Rule Failure Reasons (${failures.length}) ===`);
    if (failures.length === 0) {
      lines.push("No rule failures recorded.");
    } else {
      for (const f of failures) {
        lines.push(`[Campaign ${f.campaignId}${f.campaignName ? ` "${f.campaignName}"` : ""}] Rule ${f.ruleIndex ?? "?"}${f.ruleName ? ` "${f.ruleName}"` : ""}: ${f.failureCode ?? "unknown failure"}`);
      }
    }

    const triggered = result.triggeredCampaigns ?? [];
    if (triggered.length > 0) {
      lines.push(`\n=== Campaigns That Fired (${triggered.length}) ===`);
      for (const c of triggered) {
        lines.push(`Campaign ${c.id}: ${c.name ?? "(unnamed)"}`);
      }
    }

    lines.push(`\n=== Raw Response ===`);
    lines.push(JSON.stringify(result, null, 2));

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: track_event
// ---------------------------------------------------------------------------

server.tool(
  "track_event",
  "Submit a custom event against a customer session via the Talon.One Integration API. Use this to test event-triggered campaigns.",
  {
    sessionId: z
      .string()
      .describe("The session ID to associate this event with."),
    type: z
      .string()
      .describe("The event type name (must match an event type configured in Talon.One)."),
    attributes: z
      .record(z.unknown())
      .optional()
      .describe("Custom event attributes. Only include attributes returned by list_attributes for the Event entity."),
  },
  async ({ sessionId, type, attributes }) => {
    const config = loadConfig();
    if (!config) {
      return {
        content: [{
          type: "text" as const,
          text: "Talon.One credentials not configured. Run /talonone:configure to set up your API key and base URL.",
        }],
      };
    }

    const body: Record<string, unknown> = { sessionId, type };
    if (attributes && Object.keys(attributes).length > 0) body.attributes = attributes;

    const result = await integrationFetch(config, "POST", `/v2/events`, body) as {
      effects?: Array<{ campaignId?: number; effectType?: string; props?: Record<string, unknown> }>;
      ruleFailureReasons?: Array<{ campaignId?: number; campaignName?: string; failureCode?: string }>;
    };

    const lines: string[] = [`Event "${type}" submitted for session ${sessionId}.`];

    const effects = result.effects ?? [];
    lines.push(`\n=== Effects (${effects.length}) ===`);
    for (const e of effects) {
      const props = e.props ? ` — ${JSON.stringify(e.props)}` : "";
      lines.push(`[Campaign ${e.campaignId}] ${e.effectType}${props}`);
    }

    const failures = result.ruleFailureReasons ?? [];
    lines.push(`\n=== Rule Failure Reasons (${failures.length}) ===`);
    for (const f of failures) {
      lines.push(`[Campaign ${f.campaignId}${f.campaignName ? ` "${f.campaignName}"` : ""}]: ${f.failureCode ?? "unknown"}`);
    }

    lines.push(`\n=== Raw Response ===`);
    lines.push(JSON.stringify(result, null, 2));

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: get_customer_session
// ---------------------------------------------------------------------------

server.tool(
  "get_customer_session",
  "Retrieve the current state of a customer session from the Talon.One Integration API.",
  {
    sessionId: z
      .string()
      .describe("The session ID to retrieve."),
  },
  async ({ sessionId }) => {
    const config = loadConfig();
    if (!config) {
      return {
        content: [{
          type: "text" as const,
          text: "Talon.One credentials not configured. Run /talonone:configure to set up your API key and base URL.",
        }],
      };
    }

    const result = await integrationFetch(config, "GET", `/v2/customer_sessions/${encodeURIComponent(sessionId)}`) as {
      id?: string;
      profileId?: string;
      state?: string;
      cartItems?: unknown[];
      couponCodes?: string[];
      channel?: string;
      total?: number;
      attributes?: Record<string, unknown>;
      created?: string;
      updated?: string;
    };

    const lines: string[] = [
      `Session ID: ${result.id ?? sessionId}`,
      `Profile: ${result.profileId ?? "(none)"}`,
      `State: ${result.state ?? "unknown"}`,
      `Channel: ${result.channel ?? "(none)"}`,
      `Cart Total: ${result.total ?? 0}`,
      `Cart Items: ${result.cartItems?.length ?? 0}`,
      `Coupon Codes: ${result.couponCodes?.join(", ") || "(none)"}`,
    ];

    if (result.attributes && Object.keys(result.attributes).length > 0) {
      lines.push(`Attributes: ${JSON.stringify(result.attributes)}`);
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
