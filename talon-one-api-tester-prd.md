# PRD: AI-First API Testing System for Talon.One
**Status:** Draft v1.0  
**Author:** Prash  
**Type:** Internal Tooling / Platform Feature

---

## 1. Overview

Talon.One's built-in API tester requires users to write raw JSON, which creates a barrier for non-technical users like marketers and campaign managers. This project replaces that UI with an **AI-first API testing experience** powered by MCP (Model Context Protocol) and a skill layer — allowing users to test their Talon.One integrations in natural language, with guided workflows, structured validation, and intelligent response deconstruction.

---

## 2. Problem Statement

- The existing API testing UI requires knowledge of JSON and Talon.One's API schema
- Non-technical users (marketers, campaign owners) cannot independently test or validate their campaigns
- There is no structured guidance on which endpoint to use, how to construct a payload, or why a campaign fired or didn't fire
- There is no memory or history of past test sessions

---

## 3. Goals

- Allow non-technical users to test Talon.One integrations using natural language
- Abstract away JSON construction behind a guided, quiz-driven workflow
- Visualise the constructed payload in human-readable format before execution
- Deconstruct and explain API responses, including why campaigns fired or were excluded
- Support cross-industry usage (retail, B2B, fintech, etc.) with industry-specific workflows
- Provide persistent memory of test sessions for replay, history, and bulk testing

---

## 4. Non-Goals (v1)

- Building a new UI or dashboard
- Full self-service skill authoring by customers
- Hosting external memory infrastructure (deferred to v2)

---

## 5. Target Users

- Marketers and campaign managers at Talon.One customers
- Talon.One CSMs and solutions engineers doing integration demos and validation
- Internal QA and onboarding teams

---

## 6. Architecture Overview

The system is composed of three layers:

```
User (Claude) ──► Skill Layer ──► MCP Server ──► Talon.One APIs
                      │
                  Middleware
               (Skill Management)
                      │
                External Memory
               (Test History Store)
```

### 6.1 MCP Server

The MCP server is the **execution engine**. It:
- Receives structured instructions from the skill layer
- Executes the appropriate Talon.One API calls
- Returns raw API responses back to the skill layer for deconstruction

The MCP server stays stateless and generic. It does not decide *which* API to call — that is the skill's responsibility. It simply executes and returns.

**Primary API target:** Talon.One **Integration API** — specifically the customer session endpoint for basket/cart testing and event submission.

**Secondary API target:** Talon.One **Management API** — for profile lookups, attribute validation, and campaign inspection.

### 6.2 Skill Layer

The skill layer is the **intelligence layer**. It is a set of structured instructions that tells Claude:
- Which endpoint to use for a given scenario
- How to construct the payload from natural language inputs
- What questions to ask the user before proceeding
- What guardrails to enforce (see Section 8)
- How to deconstruct and explain the API response

Skills are **industry-scoped templates** (e.g., retail, B2B SaaS, fintech) that can be customised per customer via the middleware layer.

**Examples of skill routing logic:**
- "Test a basket" → Integration API, `PUT /v2/customer_sessions/{id}`
- "Send a custom event" → Integration API, events endpoint
- "Create a transaction in state open then close it" → Integration API, state machine flow
- "Pull up a customer profile" → Management API, customer endpoint

### 6.3 Middleware (Skill Management Service)

A lightweight service responsible for:
- Storing versioned skills per customer tenant
- Providing a simple interface (form or Claude-powered chat) for CSMs/customers to customise their skill
- Compiling customisations (custom attributes, event types, channel names) into a tenant-specific skill file
- Serving the correct skill version to the MCP server at runtime, keyed by tenant ID

This is deferred to a fuller build in v2 but the interface contracts should be designed upfront.

### 6.4 Memory Layer

**v1:** Claude conversation memory. Users can say "remember this as my usual basket" and Claude stores it in session/personal memory. Within a session, this enables: re-running the same basket 100 times, comparing results across runs, referencing named test contexts without repeating them.

**v2:** Externalised memory store scoped per customer tenant. Enables cross-session history, audit logs, bulk replay, and analytics across test runs. Hosted alongside the MCP server infrastructure.

---

## 7. User Flow

### 7.1 Session Initialisation

1. User starts a test session in Claude
2. Claude loads the customer's skill (industry template + tenant customisations)
3. Skill fetches the customer's existing attributes and profiles from Talon.One Management API
4. Claude enters **Quiz Mode** (see Section 9)

### 7.2 Payload Construction

1. Claude asks guided questions to determine: scenario type, customer profile, basket/event contents, channel, relevant attributes
2. Claude constructs the payload from answers
3. Claude presents the payload as a **human-readable markdown table** for review before execution
4. User confirms or adjusts

### 7.3 API Execution

1. MCP server executes the appropriate Integration API call
2. Raw response returned to skill layer

### 7.4 Response Deconstruction

Claude explains the response in plain language:
- Which campaigns evaluated against this session
- Which campaigns fired and why (matching conditions)
- Which campaigns did not fire and why (failed conditions, eligibility rules, budget limits, etc.)
- What effects were applied (discounts, loyalty points, coupons, etc.)
- Any errors or unexpected states

---

## 8. Guardrails (Hardcoded in Skill)

These are non-negotiable constraints baked into every skill:

| Rule | Description |
|------|-------------|
| **No hallucinated attributes** | Claude may only reference attributes that exist in the customer's Talon.One instance. Attributes are fetched at session start via Management API. Any attempt to reference or create a new attribute is rejected. |
| **No profile creation** | Claude must never create a new customer profile. If a profile is not specified, Claude must ask for one before proceeding. |
| **Endpoint validation** | The skill determines the correct endpoint. Claude cannot override this based on user phrasing. |
| **Confirm before execute** | Claude must always present the constructed payload for user confirmation before making any API call. |
| **Tenant isolation** | Skills, memory, and attribute sets are always scoped to the specific customer tenant. Cross-tenant data access is not permitted. |

---

## 9. Quiz Mode

Before constructing any payload, Claude enters a structured guided flow. The skill defines a decision tree of mandatory questions. Claude cannot proceed to payload construction until all required questions are answered.

**Example question flow for retail basket testing:**

1. "Which integration pattern are you testing?"
   - [ ] Cart/basket with customer session
   - [ ] Custom event
   - [ ] State machine (open → closed transaction)
   - [ ] Profile attribute update

2. "Which customer profile should we use?" *(shows list of existing profiles)*

3. "Which channel is this session for?" *(shows configured channels)*

4. "How many items in the basket, and what SKUs or product types?"

5. "Are there any custom attributes you want to include?" *(shows available attributes only)*

6. "Should I use an existing named test basket, or create a new one?"

The skill can also offer template selection: "I have four standard test scenarios for retail. Which one matches what you want to test?"

---

## 10. Skill Templates by Industry

| Industry | Primary Endpoints | Key Workflows |
|----------|------------------|---------------|
| Retail | Customer Session (cart), Events | Basket construction, loyalty accrual, coupon redemption |
| B2B / SaaS | Customer Session, Events | Account-level sessions, feature-gated promotions |
| Fintech | Customer Session (transaction), Events | State machine flows (open → pending → closed), spend-based triggers |
| Travel | Customer Session, Events | Booking flows, tier-based loyalty |

Each template ships with: default question trees, standard attribute sets for that industry, common channel configurations, and example payloads.

---

## 11. Payload Visualisation Format

Before execution, Claude presents the payload as a readable markdown table:

**Example:**

| Field | Value |
|-------|-------|
| Endpoint | `PUT /v2/customer_sessions/{session_id}` |
| Customer Profile ID | `customer_abc123` |
| Session State | `open` |
| Channel | `retail_web` |
| Cart Items | 3x SKU-001 (€29.99 each), 1x SKU-042 (€14.99) |
| Total Cart Value | €104.96 |
| Custom Attribute: loyalty_tier | `gold` |
| Custom Attribute: promo_code | `SUMMER20` |

> "Does this look correct? Type **yes** to execute or tell me what to change."

---

## 12. Response Deconstruction Format

After execution, Claude explains the result in plain language:

**Example output:**

> **Session executed successfully.**
>
> **Campaigns evaluated:** 4  
> **Campaigns fired:** 2  
> **Effects applied:** 20% discount on cart total, 50 loyalty points awarded
>
> ✅ **"Summer Sale 20% Off"** — Fired  
> Reason: Cart value exceeded €100 threshold, channel matched `retail_web`, customer attribute `loyalty_tier = gold` satisfied eligibility rule.
>
> ✅ **"Gold Tier Points Booster"** — Fired  
> Reason: Profile is in Gold tier, session state is `closed`.
>
> ❌ **"New Customer Welcome"** — Did not fire  
> Reason: Customer profile already has a prior session. This campaign targets first-time sessions only.
>
> ❌ **"Flash Deal: SKU-099"** — Did not fire  
> Reason: No SKU-099 in cart. Condition requires at least 1 unit of SKU-099.

---

## 13. Version Roadmap

### v1 — MVP (Claude-native, no hosting required)
- MCP server executes Integration API and Management API calls
- Industry skill templates (start with retail + B2B)
- Quiz mode with guardrails
- Payload visualisation and response deconstruction
- Memory via Claude conversation memory (named test contexts, session history)
- Manual skill configuration by Prash / CSM team per customer

### v2 — Scaled (Hosted infrastructure)
- Middleware service for skill management and tenant customisation
- Customer-facing skill configuration interface (form or Claude-powered)
- Externalised memory store per tenant (test history, audit logs, bulk replay)
- Self-service skill updates for non-technical customers
- Bulk test execution ("run this basket 100 times and summarise results")

---

## 14. Open Questions

1. Does Talon.One's existing MCP server expose both Integration API and Management API, or only one?
2. What is the preferred hosting environment for the MCP server — customer-side or centralised?
3. How are customer tenant IDs passed into the MCP session to load the correct skill?
4. What is the rollout plan — internal only first, or directly to select customers?
5. Who owns skill template authoring — Prash, CSM team, or product?

---

## 15. Success Metrics

- Non-technical users can complete an end-to-end test session without writing any JSON
- Time to first successful API test reduced from ~30 mins to <5 mins for new users
- Campaign response deconstruction reduces support queries about "why didn't my campaign fire"
- Skill templates cover >80% of customer use cases without custom modifications
