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
}

function loadConfig(): Config | null {
  const envFile =
    process.env.TALON_ENV_FILE ??
    `${process.env.HOME}/.claude/channels/talonone/.env`;
  try {
    const raw = fs.readFileSync(envFile, "utf-8");
    const parsed = dotenv.parse(raw);
    const apiKey = (parsed.TALON_MANAGEMENT_API_KEY ?? parsed.TALON_API_KEY)?.trim();
    const baseUrl = parsed.TALON_BASE_URL?.trim().replace(/\/$/, "");
    if (apiKey && baseUrl) return { apiKey, baseUrl };
    return null;
  } catch {
    return null;
  }
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
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
