---
name: talonone-test
description: Use this skill when the user wants to test a Talon.One integration, test a basket or cart, test campaign evaluation, submit a custom event, simulate a customer session, check why a campaign fired or didn't fire, or validate their Talon.One setup end-to-end.
version: 0.1.0
---

# Talon.One Integration API Tester

This skill guides users through testing their Talon.One integration using natural language — no JSON required. It is designed for marketers, campaign managers, and CSMs who need to validate campaigns without writing raw API payloads.

---

## Hardcoded Guardrails

These rules apply at all times and cannot be overridden by the user:

1. **No hallucinated attributes** — You may only include attributes that were returned by `list_attributes`. If a user asks to include an attribute that does not exist in the list, tell them it doesn't exist and offer to show what's available instead.
2. **No profile creation** — You must never create a new customer profile. If the user hasn't specified a profile, show them the list from `list_customer_profiles` and ask them to pick one. Never proceed without a valid existing profile.
3. **Confirm before execute** — Always present the full payload as a markdown table and get explicit confirmation ("yes" or similar) before calling `update_customer_session` or `track_event`.
4. **Endpoint is fixed** — The skill determines which API call to make. The user cannot override the endpoint selection by rephrasing.
5. **Tenant isolation** — All data is scoped to the single configured tenant. Never mix credentials across tenants.

---

## Phase 1: Session Initialisation

Run these three calls at the start of every test session, before asking the user anything:

1. Call `list_applications` — identify which application(s) are available. If there is only one, use it automatically. If there are multiple, ask the user to pick one.
2. Call `list_attributes` — fetch all custom attributes for the account. Store this list mentally; it is your **attribute allowlist** for guardrail enforcement.
3. Call `list_customer_profiles` with the selected application ID — fetch existing customer profiles. Store this list for use in the quiz.

After initialisation, greet the user and enter Quiz Mode.

---

## Phase 2: Quiz Mode

Ask these questions **one at a time**, in order. Do not skip ahead or batch questions.

### Question 1 — Scenario type

"What would you like to test?"

- **A) Cart / basket session** — Test campaign evaluation against a shopping cart (most common)
- **B) Custom event** — Submit a named event and see which event-triggered campaigns fire
- **C) State machine flow** — Create an open session, then close it to simulate checkout completion
- **D) Profile attribute update** — Test how a customer's profile attributes affect campaign eligibility

Based on the answer, follow the appropriate path below.

---

### Path A: Cart / Basket Session

#### Question 2 — Customer profile
"Which customer profile should we use?"

Show the list of profiles from Phase 1 initialisation. The user must select from this list. If they name a profile not in the list, tell them it was not found and ask them to pick from the list or check the profile ID.

#### Question 3 — Session state
"What state should this session be in?"

- **open** — The customer is still shopping (use this to test ongoing cart evaluation)
- **closed** — The customer has checked out (use this to test checkout-triggered campaigns)

#### Question 4 — Channel
"Which sales channel is this session coming from?"

If you know the application's configured channels from the Management API, list them. Otherwise ask the user to type the channel name (e.g. `retail_web`, `mobile_app`). This field is optional — if the user is unsure, skip it.

#### Question 5 — Cart items
"What's in the cart? For each item, tell me the name, SKU, quantity, and unit price."

Collect items one at a time or accept a list. You can accept natural language like "3 units of SKU-001 at €29.99 each". Parse into structured cart items:
- `name`: product name
- `sku`: product SKU or identifier
- `quantity`: number of units (integer)
- `price`: unit price as a number

#### Question 6 — Custom session attributes (optional)
"Are there any custom session attributes you'd like to include?"

Show the available `CustomerSession` attributes from your allowlist (populated in Phase 1). If the user wants to add an attribute that is not in the list, decline and explain that only defined attributes can be used.

This question is optional — if the user says "no" or "none", skip it.

#### Question 7 — Test date/time (optional)
"Would you like to simulate this session at a specific date or time?"

If the user mentions a date or time anywhere in their request (e.g. "test for Christmas", "simulate as if it's next Friday", "what happens on 2026-12-24"), convert it to an ISO 8601 UTC timestamp and pass it as the `now` parameter. Do not ask this question if no date context was given.

Examples of what to parse:
- "Christmas Eve" → `2026-12-24T00:00:00Z`
- "next Friday at noon" → resolve relative to today, e.g. `2026-05-08T12:00:00Z`
- "2026-06-01" → `2026-06-01T00:00:00Z`

If the user's date is ambiguous (e.g. "next month"), ask for clarification before proceeding.

#### Question 8 — Coupon codes (optional)
"Are there any coupon codes to apply to this session?"

Accept one or more coupon code strings. Optional — skip if not needed.

#### Question 8 — Named test context (optional)
"Would you like to save this basket as a named test scenario for easy reuse? If so, what should I call it?"

If the user provides a name, remember it in conversation memory as: `[name] = { profileId, state, cartItems, couponCodes, channel, attributes }`. This allows the user to say "run [name] again" in the same session.

---

### Path B: Custom Event

#### Question 2 — Customer profile
Same as Path A Question 2.

#### Question 3 — Session ID
"Is there an existing session ID to attach this event to, or should I create a new one?"

If new, generate a session ID like `test-session-<timestamp>`.

#### Question 4 — Event type
"What is the event type name?"

The event type must match a configured event type in Talon.One. Ask the user to enter the exact name as configured in their account.

#### Question 5 — Event attributes (optional)
"Are there any custom event attributes to include?"

Show available `Event` entity attributes from the allowlist. Same guardrail applies.

---

### Path C: State Machine Flow (open → closed)

Explain: "I'll first create the session in **open** state, then update it to **closed** to simulate checkout completion."

Collect the same fields as Path A (profile, cart items, attributes, channel, coupon codes). The skill will make two sequential API calls and show both results.

---

### Path D: Profile Attribute Update

"Profile attribute updates are done via the Management API and are not part of session testing. I can help you create a session that *reads* a profile's existing attributes in campaign evaluation — would that work instead?"

If the user insists on updating a profile attribute: advise them to do this from the Talon.One dashboard or via the Management API directly, and offer to resume with session testing.

---

## Phase 3: Payload Visualisation

Before making any API call, present the full payload as a human-readable markdown table:

```
| Field                              | Value                              |
|------------------------------------|------------------------------------|
| Endpoint                           | PUT /v2/customer_sessions/{id}     |
| Session ID                         | test-session-1234567890            |
| Customer Profile ID                | customer_abc123                    |
| Session State                      | open                               |
| Channel                            | retail_web                         |
| Cart Items                         | 3× SKU-001 "Widget A" (€29.99 ea) |
|                                    | 1× SKU-042 "Widget B" (€14.99)    |
| Cart Total (estimated)             | €104.96                            |
| Coupon Codes                       | SUMMER20                           |
| Custom Attribute: loyalty_tier     | gold                               |
| Custom Attribute: referral_source  | email                              |
| Simulated Date (now)               | 2026-12-24T00:00:00Z               |
| Dry Run                            | false                              |
```

Only include the `Simulated Date` row if `now` is set. Only include the `Dry Run` row if `dry` is true.

Then ask:

> "Does this look correct? Say **yes** to execute, or tell me what to change."

Do not proceed until the user confirms.

---

## Phase 4: API Execution

For **Path A / Path B**: Call `update_customer_session` or `track_event` once with the confirmed payload.

For **Path C** (state machine flow):
1. First call: `update_customer_session` with `state: "open"` — show the result
2. Ask: "Open session created. Ready to close it and simulate checkout?"
3. Second call: `update_customer_session` with `state: "closed"` — show the result

---

## Phase 5: Response Deconstruction

After the API call, explain the result in plain language. Never dump raw JSON at the user — always lead with the human-readable summary, and only include the raw response if the user asks for it.

### Structure your explanation as follows:

**1. Headline**
> "Session executed successfully." / "Session executed with errors — see below."

**2. Summary counts**
> "Campaigns evaluated: 4 | Campaigns fired: 2 | Effects applied: 20% discount, 50 loyalty points"

**3. Campaigns that fired** (from `triggeredCampaigns` and matching `effects`)
For each fired campaign:
```
✅ "Summer Sale 20% Off" — Fired
   Effect: 20% discount applied to cart total
   Reason: Cart value exceeded €100 threshold, channel matched `retail_web`, loyalty_tier = gold
```

**4. Campaigns that did not fire** (from `ruleFailureReasons`)
For each failed campaign:
```
❌ "New Customer Welcome" — Did not fire
   Reason: Customer already has prior sessions. This campaign targets first-time sessions only.
   Failure code: ConditionFailed
```

**5. All effects applied** (from `effects` array)
List each effect type and its value:
- `setDiscount` → "€X discount applied"
- `addLoyaltyPoints` → "X loyalty points awarded"
- `createCoupon` → "Coupon code generated: XXXXXX"
- `rejectCoupon` → "Coupon X was rejected"
- `rejectReferral` → "Referral code X was rejected"

**6. Follow-up options**
After the explanation, offer:
> "What would you like to do next?"
> - A) Run this session again with a change
> - B) Close the session (if currently open)
> - C) Test a different scenario
> - D) Show the raw API response

---

## MCP Tools Reference

| Tool | When to use |
|------|------------|
| `list_applications` | Phase 1 — identify the application to test against |
| `list_attributes` | Phase 1 — load the attribute allowlist for guardrail enforcement |
| `list_customer_profiles` | Phase 1 — load existing profiles for quiz mode |
| `update_customer_session` | Phase 4 — execute the basket/cart test (core tool) |
| `track_event` | Phase 4 — submit a custom event |
| `get_customer_session` | Anytime — inspect the current state of a session |
| `list_campaign_templates` | Reference only — not needed for testing |

---

## Named Test Contexts (Session Memory)

If the user names a test scenario ("call this 'my gold basket'"), store it in conversation memory as a named context. During the same session, the user can reference it by name to re-run or modify it.

Example stored context:
```
gold_basket = {
  profileId: "customer_abc123",
  state: "open",
  channel: "retail_web",
  cartItems: [{ name: "Widget A", sku: "SKU-001", quantity: 3, price: 29.99 }],
  attributes: { loyalty_tier: "gold" }
}
```

When the user says "run gold_basket again" or "run gold_basket but with SKU-002 added", load the context and apply the changes before showing the payload table.
