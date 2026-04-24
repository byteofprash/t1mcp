---
name: configure
description: Configure Talon.One credentials — save the API key and base URL. Use when the user wants to set up Talon.One, passes a Talon.One API key, asks to configure the plugin, or asks "how do I get started".
user-invocable: true
argument-hint: "[--reset]"
allowed-tools:
  - Read
  - Write
  - Bash(curl *)
  - Bash(mkdir *)
---

# /talonone:configure — Talon.One Credential Setup

Saves the Talon.One Management API key and base URL to `~/.claude/channels/talonone/.env`.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args or `--reset` — interactive setup

**Step 1: Check existing config**

Read `~/.claude/channels/talonone/.env` if it exists.

- If the file exists and `$ARGUMENTS` does NOT contain `--reset`:
  Show the current config (mask all but the first 6 chars of `TALON_API_KEY`) and ask the user if they want to update it. Stop if they say no.
- If `--reset` was passed or the file doesn't exist: proceed to Step 2.

**Step 2: Collect credentials**

Ask the user for both values (you can ask together since there are only two):

1. **`TALON_BASE_URL`** — Their Talon.One deployment URL.
   - Format: `https://<subdomain>.talon.one` (no trailing slash, HTTPS required)
   - Example: `https://mycompany.talon.one`

2. **`TALON_API_KEY`** — Their Management API key.
   - Generated in the Talon.One dashboard under **Account → Developer → Management API keys**
   - This key has broad write access — treat it like a password and never share it

**Step 3: Validate**

Test the credentials with a quick API call:

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: ApiKey-v1 <TALON_API_KEY>" \
  "<TALON_BASE_URL>/v1/applications"
```

- `200` → valid, proceed
- `401` → bad API key; ask the user to double-check it
- `000` or connection refused → bad base URL; ask the user to verify the URL
- Other 4xx/5xx → warn but offer to save anyway

**Step 4: Write the config file**

```bash
mkdir -p ~/.claude/channels/talonone
```

Then write `~/.claude/channels/talonone/.env` using the Write tool:
```
TALON_API_KEY=<key>
TALON_BASE_URL=<url>
```

Do not add quotes around values.

**Step 5: Confirm**

Tell the user:
- Config written to `~/.claude/channels/talonone/.env`
- The MCP server reads this at startup — if Claude Code was already running with the plugin loaded, they need to restart it (or run `/mcp` and reconnect the talonone server)
- To verify the connection: type "list my Talon.One applications"

---

## Security note

The `.env` file contains a privileged Talon.One Management API key. It is stored locally on this machine only and is not part of any project repository. Warn the user not to commit it to version control.
