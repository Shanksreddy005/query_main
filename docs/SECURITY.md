# Security Architecture

**QueryMind Analytic Platform** — *Technical Specification & Data Sovereignty Model*

This document defines QueryMind's security architecture, technical verification boundaries, and SQL sandboxing threat model. It distinguishes between **verified technical guarantees**, **architectural designs**, and **user/environment responsibilities**.

Outbound data policy, prompt privacy and credential storage are covered in the companion document [PRIVACY.md](PRIVACY.md).

---

## 1. Architectural Posture & Verification Status

| Dimension | Architectural Implementation | Verification Status |
| :--- | :--- | :--- |
| **Data Locality** | In-memory vectorized analytics executed via `DuckDB-WASM` inside client browser Web Worker. | **Verified in Code & Automated Tests** |
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
2. **Zero Analytics/Telemetry Servers**: QueryMind does not operate application analytics relays, error telemetry servers, tracking beacons, or backend logging databases.
3. **Network Boundary Isolation**: Network traffic is strictly limited to:
   - Initial static asset delivery (HTML/JS/CSS bundles), including **self-hosted fonts** (`public/fonts/`) and **self-hosted DuckDB-WASM worker scripts** (`public/duckdb/`). Google Fonts and DuckDB CDN references have been removed from the loading path. In production builds the two oversized DuckDB-WASM `.wasm` binaries (34.3 MiB / 39.4 MiB — over Cloudflare Pages' 25 MiB per-file limit) are fetched from the operator-owned first-party domain `assets.querymind.in` (Cloudflare R2, static objects only, CORS-restricted); the binary bytes are pinned by SHA-256 in the release inventory. Browser network verification is required for each release.
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
