# Privacy & Data Policy

**QueryMind Analytic Platform** — *Outbound Data Policy, Prompt Privacy & Credential Threat Model*

This document defines what QueryMind transmits to third-party LLM providers, what it never transmits, and how user-supplied credentials are stored. Security architecture and SQL sandboxing are covered in the companion document [SECURITY.md](SECURITY.md).

---

## 1. Outbound Data Policy & Prompt Privacy

QueryMind enforces strict data boundary controls when interacting with third-party LLM providers:

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

Independent audits of live provider traffic (see [verification/final-production-approval-report.md](verification/final-production-approval-report.md) and [verification/post-rotation-smoke-test-report.md](verification/post-rotation-smoke-test-report.md)) recorded every outbound request body during real Gemini and Groq runs: zero dataset row signatures and zero result-row pairings were found in any request; prompts carried schema metadata only (~10 KB per question); keys never appeared in URLs, bodies, browser storage or logs. The app ships a built-in Telemetry Auditor that records every outbound request for live user-side inspection.
