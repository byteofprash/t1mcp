---
name: talonone
description: This skill should be used when the user asks to "create a campaign", "build a promotion", "set up a campaign", "manage Talon.One", "use a campaign template", "create a discount campaign", or discusses Talon.One applications, deployments, campaigns, or campaign templates.
version: 0.1.0
---

# Talon.One Campaign Management

## Talon.One Hierarchy

**Account → Applications → Campaigns**

- **Application** (also called a "deployment"): A distinct environment in Talon.One (e.g., "US Web Store", "EU Mobile App"). Every campaign lives inside an application.
- **Campaign**: A promotion that is evaluated against customer sessions. Campaigns are always created from a template — you cannot create one from scratch.
- **Template**: A blueprint that defines the campaign's base rules and exposes `template_params` — named placeholder variables the user must fill in.

## Campaign Templates

Templates are the entry point for all campaign creation. Each template has:

- `id`, `name`, `description`, `instructions` — identity and guidance
- `state` — only `"available"` templates can be used
- `applications_ids` — the list of application IDs this template is available for
- `template_params` — the **placeholder schema**: an array of parameters that must be filled when creating a campaign from this template

### Template parameter structure

```
template_params: [
  {
    name: string,        // identifier — used as key in template_param_values
    type: "string" | "number" | "boolean" | "percent" | "time" | "(list string)",
    description: string  // human explanation of what this value controls
  }
]
```

## Campaign States

- `draft` — not yet evaluated by the rule engine; safe to inspect
- `scheduled` — has start/end times set; not yet active
- `running` — actively evaluated on every customer session
- `disabled` — paused

## Workflow: Creating a Campaign

Follow these steps in order:

### Step 1 — Find the application
Call `list_applications` to get the application ID if the user hasn't provided one.

### Step 2 — List available templates
Call `list_campaign_templates` with the `applicationId`. Present the options to the user. Only `"available"` state templates will be returned.

### Step 3 — Fetch the template details
Once the user picks a template, call `get_campaign_template` to read the full `template_params` list. This tells you exactly what placeholder values you need to collect.

### Step 4 — Resolve placeholder values
This is the most important step. Approach it like a smart form-filler:

1. **Infer silently** — go through each `template_params` entry and check if the user's message already contains a matching value. Use the param's `description` and `type` to match. For example, if the user said "10% off" and a param is `discountPercentage (percent): The discount percentage to apply`, you can infer the value is `10` without asking.

2. **Ask one at a time** — for any param you can't confidently infer, ask the user a single focused question. Include:
   - The param's `description` so the user understands what it controls
   - The expected `type` so they know what format to use

3. **Do not batch all questions at once** — ask one, wait for the answer, then ask the next.

4. **Confirm before creating** — once all params are resolved, briefly summarise the values you're about to use and ask the user to confirm before calling `create_campaign_from_template`.

### Step 5 — Create the campaign
Call `create_campaign_from_template` with:
- `applicationId`
- `templateId`
- `name` (the campaign name — ask if not provided)
- `templateParamValues` — array of `{ name, expression }` bindings

## MCP Tools Reference

| Tool | When to use |
|------|------------|
| `list_applications` | Get available application IDs when the user hasn't specified one |
| `list_campaign_templates` | Show the user which templates are available for their application |
| `get_campaign_template` | Read the full template including `template_params` after the user picks a template |
| `create_campaign_from_template` | Create the campaign once all placeholder values are confirmed |
