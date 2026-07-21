---
name: talonone-delete-campaign
description: Use this skill when the user asks to "delete a campaign", "remove a campaign", "clean up campaigns", or "deactivate and delete a campaign" in Talon.One.
version: 0.1.0
---
# Talon.One Campaign Deletion

## Overview

Deleting a campaign is **irreversible**. This workflow forces an explicit selection step so the user always reviews what they are about to delete before any destructive action is taken.

## Workflow: Deleting a Campaign

Follow these steps **in order**. Do not skip any step.

### Step 1 — Find the application

If the user hasn't specified an application, call `list_applications` and present the options. Ask the user to confirm which application they want to work in before continuing.

### Step 2 — List all campaigns ⚠️ MANDATORY

Call `list_campaigns` with the confirmed `applicationId`. You **must** call this tool even if the user has already named a campaign — the ID is required and must match what is live in the system.

### Step 3 — Present campaigns as a selection list

Display the campaigns as a numbered checkbox list so the user can clearly pick which one(s) to delete. Format the list like this:

```
Here are the campaigns in [Application Name]:

[ ] 1. Summer Sale 2024 (ID: 112) — State: running
[ ] 2. Black Friday Flat 20% (ID: 98) — State: disabled
[ ] 3. New User Welcome Coupon (ID: 74) — State: draft

Which campaign(s) would you like to delete? Reply with the number(s), e.g. "1" or "1, 3".
```

**Rules for the selection list:**
- Show ALL campaigns returned, not just a subset.
- Always show the campaign ID in parentheses — you will need it for the API call.
- Show the current state so the user knows if the campaign is live/running before they delete it.
- If a campaign is in `running` state, add a warning label: ⚠️ LIVE.

### Step 4 — Warn about running campaigns

If the user selects any campaign currently in `running` state, surface an explicit warning before proceeding:

```
⚠️  Warning: "[Campaign Name]" is currently LIVE (state: running). Deleting it will immediately stop it from being evaluated on new customer sessions. This cannot be undone.

Are you sure you want to delete it?
```

Wait for an explicit "yes" / "confirm" from the user before continuing.

### Step 5 — Final confirmation

Before calling `delete_campaign`, always present a summary and ask for one last confirmation:

```
You are about to permanently delete the following campaign(s):

- [Campaign Name] (ID: 112) from application [App Name] (ID: 3)

This action is irreversible. Type "confirm" to proceed or "cancel" to abort.
```

Only call `delete_campaign` after the user types an explicit confirmation word such as "confirm", "yes", "delete", or "proceed". If the user says "cancel", "no", or "stop" — abort immediately and do not call the tool.

### Step 6 — Execute and report

Call `delete_campaign` for each confirmed campaign ID sequentially. After each call, report the result:

```
✓ Campaign "[Name]" (ID: 112) deleted successfully.
```

If there are multiple campaigns to delete, complete all of them and then give a final summary:

```
Deletion complete. 2 campaign(s) removed:
- Summer Sale 2024 (ID: 112)
- New User Welcome Coupon (ID: 74)
```

## MCP Tools Reference

| Tool | When to use |
|------|------------|
| `list_applications` | Get the application ID when the user hasn't specified one |
| `list_campaigns` | Fetch all campaigns for the application so the user can select |
| `delete_campaign` | Permanently delete a specific campaign by ID — only call after explicit confirmation |

## Hard Guardrails

- **Never call `delete_campaign` without an explicit user confirmation** in the current message turn.
- **Never infer the campaign ID** from the name alone — always derive it from the `list_campaigns` response.
- **Never batch the confirmation and the deletion into the same turn** — always wait for the user's reply.
- If the user seems uncertain or asks a question before confirming, treat it as "not confirmed" and wait.
