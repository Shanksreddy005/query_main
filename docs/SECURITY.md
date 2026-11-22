# Security Architecture

**QueryMind Analytic Platform** — *Technical Specification & Data Sovereignty Model*

This document defines QueryMind's security architecture, technical verification boundaries, and SQL sandboxing threat model. It distinguishes between **verified technical guarantees**, **architectural designs**, and **user/environment responsibilities**.

Outbound data policy, prompt privacy and credential storage are covered in the companion document [PRIVACY.md](PRIVACY.md).

---

## 1. Architectural Posture & Verification Status

| Dimension | Architectural Implementation | Verification Status |
| :--- | :--- | :--- |
| **Data Locality** | In-memory vectorized analytics executed via `DuckDB-WASM` inside client browser Web Worker. | **Verified in Code, Automated Tests, and Live Browser Execution** |
| **Third-Party Network Posture** | No application-operated analytics, error-reporting or logging service, and no third-party asset host in any QueryMind artifact. Static assets come from the Pages origin; the two oversized engine binaries come from the operator-owned R2 custom domain. The Cloudflare edge can inject its own analytics beacon into the served HTML, which is a hosting setting outside repository control. | **Verified in artifacts; measured on the deployed v1.2 build (2026-11-19). Beacon state measured inconsistently across captures and Cloudflare dashboard settings were not inspected** |
| **Outbound Data Policy** | The live planner excludes raw rows, result records, and categorical samples by design. A bounded scan checks selected string values from at most 100 dataset rows; it does not prove absence of numeric values, complete-result egress, or provider retention. | **Sample scan implemented; full egress verification pending** |
| **SQL Sandboxing** | AST structural parsing, comment stripping, parenthesis balancing, single-statement read-only enforcement, table isolation, and DuckDB external filesystem operation blocking. | **Verified via Adversarial Unit & Integration Tests** |
| **Credential Management** | Client-side Bring-Your-Own-Key (BYOK); direct provider REST dispatch without intermediary server proxies. | **Verified in Architecture** |
| **Persistence Boundary** | Local sandboxed query blueprints saved to browser `localStorage`; sanitized JSON schema import/export. | **Verified in Test Suite** |
| **Compliance Posture** | Technical controls align with data minimization (GDPR Art. 25/32 principles), but QueryMind is a client-side tool and is **not** an externally certified SOC 2 or HIPAA cloud service. | **Accurately Scoped — No Unverified Certification Claims** |

---

## 2. Client-Side Execution Boundary

QueryMind executes analytical queries without intermediate database servers, caching relays, or cloud compute.

```
┌───────────────────────────────────── Client Browser Sandbox ──────────────────────────────────────┐
│                                                                                                    │
│  [ Uploaded CSV ] ──► (PapaParse Engine) ──► [ DuckDB-WASM Worker ] ──► Verified Data Table        │
│                                                           │                                        │
│                                                           ▼                                        │
│                                              (Client Schema Profiler)                              │
│                                                           │                                        │
│                         (Structural Metadata & Masked Categories ONLY)                             │
└───────────────────────────────────────────────────────────┼────────────────────────────────────────┘
                                                            │
                                                            ▼
                                              [ User's Configured LLM ]
                                             (Gemini, Groq, or OpenAI)
```

1. **Local WebAssembly Worker**: Datasets are loaded into a sandboxed `DuckDB-WASM` worker thread. The engine runs compiled C++ binaries inside WebAssembly, operating directly on client memory.
2. **Zero application-operated analytics or telemetry**: QueryMind operates no analytics relay, error telemetry service, tracking beacon, or backend logging database, and no file in the repository or in the built bundle contains an analytics identifier (`cloudflareinsights`, `beacon.min.js`, `__cfBeacon`, `cdn-cgi/rum`, `gtag`, `googletagmanager`, `fathom`, `plausible`). What the *hosting layer* adds is a separate question and was measured inconsistently: in one browser capture of the deployed site on 2026-11-19 the served HTML carried a third-party script from `static.cloudflareinsights.com`, `window.__cfBeacon` was defined, and the page sent a same-origin `POST /cdn-cgi/rum`; in the cache-bypassing captures that followed, the served document was byte-identical to the repository artifact, the DOM held exactly one script element (the app bundle), and no beacon marker or request appeared. That difference is an edge behaviour this project cannot see into — no Cloudflare dashboard was inspected and no setting was changed — so this document states the artifact fact as verified and the deployment beacon state as **not measured conclusively**. The same pass found a `window.RumSDK` global in the test browser's page context that is absent from every QueryMind artifact and from the page's own scripts; it could not be attributed to QueryMind, and no cause is claimed. Full wording and limits: [verification/v1.2-live-production-verification.md](verification/v1.2-live-production-verification.md), sections 2 and 3. Two further edge-emitted signals belong in an honest account: Cloudflare answers with `Nel` / `Report-To` headers pointing at `a.nel.cloudflare.com` with `success_fraction: 0.0`, so a browser may report failed connections on this host to Cloudflare, and `http://` requests are answered with a `301` to `https://`. The Pages responses measured here carry no `Strict-Transport-Security`, no Content-Security-Policy (neither header nor `meta`), and no frame-ancestors or `Permissions-Policy` header; those are hosting-layer hardening items, not application code.
3. **Network Boundary Isolation**: Network traffic is strictly limited to:
   - Initial static asset delivery (HTML/JS/CSS bundles), including **self-hosted fonts** (`public/fonts/`) and **self-hosted DuckDB-WASM worker scripts** (`public/duckdb/`). Google Fonts and DuckDB CDN references have been removed from the loading path. In production builds the two oversized DuckDB-WASM `.wasm` binaries (34.3 MiB / 39.4 MiB — over Cloudflare Pages' 25 MiB per-file limit) are fetched from the operator-owned first-party domain `assets.querymind.in` (Cloudflare R2, static objects only, CORS-restricted); the binary bytes are pinned by SHA-256 in the release inventory. Live measurement of the deployed v1.2 build confirms this posture for the application's own requests: the page frame's cold load requested nothing beyond the Pages origin, and a plain in-browser `GET` of both R2 objects returned 200 with `Content-Type: application/wasm`, the pinned byte counts, and an immutable cache directive. The engine binaries are fetched by the DuckDB worker rather than by the page, so their R2 request appears in the worker context, not in the page's request list. The Pages origin cannot serve those paths as binaries — it answers them with the single-page HTML fallback — so the engine's own worker fetches them from R2. One CORS detail is recorded for operators: the R2 objects do serve byte ranges (`Accept-Ranges: bytes`, `206` with the right `Content-Range`), but a preflight that declares the `Range` request header is answered `403` with no `Access-Control-*` headers, where a preflight for a plain `GET` is answered `204` with `Access-Control-Allow-Methods: GET`; so a cross-origin range request from a browser would fail, and the application never issues one. An `Origin` the rules do not list receives no `Access-Control-Allow-Origin` at all, and listing the bucket root returns `404`. Each release repeats this browser verification.
   - Direct HTTPS calls from the browser to the user's selected LLM provider endpoint (`generativelanguage.googleapis.com`, `api.groq.com`, or `api.openai.com`). These requests carry the user's natural-language question and structural schema metadata only — never dataset rows or query results. The user's IP address and browser referrer are visible to the chosen provider as with any direct API call; this is provider metadata exposure, not dataset leakage.

---

## 3. SQL Security & Sandbox Defense in Depth

To prevent malicious prompts or misaligned models from escaping the analytical boundary:

1. **AST Tokenizer & Lexical Parsing**:
   - Queries must strictly begin with `SELECT` or `WITH ... SELECT`.
   - Multi-statement SQL (separated by semicolons) is rejected.
   - Parentheses balance is verified to catch truncated or malformed AST expressions.
2. **Comment Stripping & Inspection**:
   - Both single-line (`--`) and multi-line (`/* */`) comments are stripped and analyzed to prevent hidden payload concealment or bypass attempts.
3. **Forbidden Operations Allowlist**:
   - Blocks all DDL/DML (`DROP`, `DELETE`, `UPDATE`, `INSERT`, `ALTER`, `CREATE`, `TRUNCATE`).
   - Blocks DuckDB extension and filesystem commands: `READ_CSV`, `READ_PARQUET`, `READ_JSON`, `SCAN_CSV`, `HTTPFS`, `COPY`, `INSTALL`, `LOAD`, `ATTACH`, `DETACH`, `PRAGMA`, `SYSTEM`.
4. **Table & Relation Isolation**:
   - Every `FROM` and `JOIN` clause is checked against the active dataset table and declared CTE aliases. Querying arbitrary or system tables is blocked.
5. **Execution Timeout & Resource Protection**:
   - DuckDB queries are bounded by a 15-second execution timeout to prevent runaway Cartesian joins from freezing browser threads.
   - Result row materialization is capped at 5,000 rows with explicit truncation indicators.
