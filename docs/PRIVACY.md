# Privacy & Data Policy

**QueryMind Analytic Platform** — *Outbound Data Policy, Prompt Privacy & Credential Threat Model*

This document defines what QueryMind transmits to third-party LLM providers, what it never transmits, and how user-supplied credentials are stored. Security architecture and SQL sandboxing are covered in the companion document [SECURITY.md](SECURITY.md).

---

## 1. Outbound Data Policy & Prompt Privacy

QueryMind enforces strict data boundary controls when interacting with third-party LLM providers:

**Scope of this section.** The controls below describe the provider path: what is assembled when an API key is configured and a question is sent to a planner. They are separate from local execution, which applies on every path — the dataset is parsed and queried in the browser, and results stay in client memory. It is also possible to use the product with no key at all: verified sample questions on the bundled datasets are answered by the deterministic curated-query path, which plans and executes locally and contacts no provider. A live keyless run against the deployed v1.2 build on 2026-11-19 observed no request to any provider endpoint, no dataset or result egress, and an empty Telemetry Auditor record. That same pass did **not** re-test a provider round trip, so the payload statements below are supported by the earlier live provider audits and the automated contract tests, not by that pass. Nothing in this section is a claim about requests the browser makes on its own behalf to the hosting platform; section 3 covers that separately.

### What IS Transmitted to the Model
- The user's natural language question string.
- Column names and data types (e.g. `mrr: number`, `plan_tier: string`).
- Inferred column roles (`MEASURE`, `DIMENSION`, `TEMPORAL`, `IDENTIFIER`).
- Categorical sample values are excluded from the live planning prompt. Values explicitly entered in the user's question are transmitted as part of that question.

### What is NEVER Transmitted to the Model
- **Zero Raw Rows**: User transaction rows, financial values, or table data records are never included in prompts.
- **Zero Result Rows**: Output rows returned by DuckDB execution remain local in client memory.
- **PII Masking**: Columns identified as PII (emails, phone numbers, SSNs, credit cards, user IDs, full names) have their sample values replaced with synthetic masks (e.g. `[Protected PII: Synthetic values only]`).
- **High-Cardinality Identifiers**: Customer IDs, account numbers, and primary keys are scrubbed and replaced with generic metadata tokens.

---

## 2. BYOK Credential Storage & Threat Model

- **Storage**: User API keys are stored in browser `localStorage` or session memory. Keys are never transmitted to QueryMind authors, proxies, or logging services.
- **Direct Dispatch**: Requests use client-side `fetch()` with authorization headers directly targeting official provider APIs.
- **Threat Model & Residual Risks**:
  - *Browser Environment Security*: An analyst using an untrusted browser, malicious extensions, or a compromised machine is vulnerable to client-side extraction.
  - *Third-Party LLM Provider Logging*: While QueryMind transmits zero raw records, the user's natural language question and column schema are subject to the data retention policies of the user's configured provider (Google, Groq, OpenAI). Users in regulated environments should configure enterprise zero-data-retention agreements with their respective providers.

---

## 3. Egress verification summary

Three kinds of evidence exist, and they answer different questions.

**Live provider traffic.** Audits of real Gemini and Groq runs (see [verification/final-production-approval-report.md](verification/final-production-approval-report.md) and [verification/post-rotation-smoke-test-report.md](verification/post-rotation-smoke-test-report.md)) recorded every outbound request body: zero dataset row signatures and zero result-row pairings were found in any request, and prompts carried schema metadata only (about 10 KB per question). Keys never appeared in request URLs or bodies, and none was present in browser storage during those runs; the opt-in "Remember API key" setting, when a user enables it, stores the key in `localStorage` by design, as section 2 states.

**Keyless behaviour on the deployed build.** [verification/v1.2-live-production-verification.md](verification/v1.2-live-production-verification.md), section 4, measured the running site with no key configured: verified sample questions were answered locally, no provider endpoint was contacted, no dataset or result left the browser, and the Telemetry Auditor recorded no outbound traffic. That pass did not exercise a provider round trip.

**What this document does not cover: the hosting layer.** Everything above is about what QueryMind's own code sends. A visitor's browser also talks to the platform the site is hosted on, and those channels are not in the application's source or its audit trail. On 2026-11-19 the deployed responses were measured directly: Cloudflare answers with `Nel` / `Report-To` headers pointing at `a.nel.cloudflare.com` (`success_fraction: 0.0`), which lets a browser report failed connections on this host to Cloudflare, and in one browser capture the served HTML also carried an edge-injected analytics script from `static.cloudflareinsights.com` that posted a same-origin `/cdn-cgi/rum` beacon — a hosting setting, not application code, and the reason this document cannot say that nothing but the provider call ever leaves the browser. Both are described with their limits in [verification/v1.2-live-production-verification.md](verification/v1.2-live-production-verification.md), sections 2 and 3.

**What remains unproven.** Provider-side retention is outside QueryMind's control and is not verified by any of these documents. The bounded scan of selected string values covers at most 100 dataset rows and does not prove the absence of numeric values or of complete-result egress in every future prompt. Nothing here is a legal or certification conclusion.

The app ships a built-in Telemetry Auditor that records every **provider dispatch** the application makes, for live user-side inspection, so a user can verify the provider path themselves at any time with their own key. It is not a network monitor: asset fetches, the engine binaries and anything the hosting layer or the browser injects are outside its scope.
