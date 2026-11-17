# R2 WASM Remediation — Verification Report

**Date:** 2026-11-17
**Scope:** Cloudflare Pages 25 MiB per-file limit vs DuckDB-WASM binaries
**Status:** Local remediation verified end-to-end; live R2 setup and live-domain test pending operator action

## 1. Root cause

Cloudflare Pages rejects deployment uploads with any individual file larger than 25 MiB. The verified production bundle contains two such files:

| File | Bytes | Size |
|---|---|---|
| `duckdb/duckdb-mvp.wasm` | 41,325,187 | 39.4 MiB |
| `duckdb/duckdb-eh.wasm` | 35,913,747 | 34.3 MiB |

Cloudflare cloned production commit `daffa85` successfully but the deployment failed on these two objects. No other file in the bundle exceeds the limit (the two worker scripts are 839,642 B and 773,223 B; everything else is smaller).

No smaller supported variant exists: `@duckdb/duckdb-wasm@1.33.1-dev57.0` ships only `mvp` (39.4 MiB), `eh` (34.3 MiB) and the larger `coi` multi-threaded set. Binary modification (stripping/optimizing) was ruled out — it would invalidate the verified release provenance and was not validated against the browser loading mechanism.

## 2. Loading path traced (not assumed)

`src/services/sqlEngine.ts` → `duckdb.selectBundle(DUCKDB_BUNDLES)` → blob-worker `importScripts("<same-origin>/duckdb/duckdb-browser-*.worker.js")` → `db.instantiate(bundle.mainModule)` → the worker glue issues `new Request(this.mainModuleURL)` + `fetch` → `WebAssembly.instantiateStreaming`. The worker's `locateFile()` override returns the app-provided `mainModuleURL` for every `.wasm` request, so the embedded relative fallback (`./duckdb-eh.wasm`) is dead code. Consequences:

- Changing only the `mainModule` URL in the application is sufficient; workers stay same-origin and unmodified.
- The cross-origin fetch is a plain `GET` (no preflight) and requires CORS on the asset origin.
- `WebAssembly.instantiateStreaming` requires `Content-Type: application/wasm`.
- Load-progress code reads `Content-Length` (a CORS-safelisted response header — no extra config needed).

## 3. Architecture change

Production split — **Cloudflare Pages for everything ≤ 25 MiB, Cloudflare R2 for the two oversized `.wasm` binaries**:

| Asset | Host | URL |
|---|---|---|
| `duckdb/duckdb-eh.wasm` | R2 `querymind-static` | `https://assets.querymind.in/duckdb/1.33.1-dev57.0/duckdb-eh.wasm` |
| `duckdb/duckdb-mvp.wasm` | R2 `querymind-static` | `https://assets.querymind.in/duckdb/1.33.1-dev57.0/duckdb-mvp.wasm` |
| `index.html`, `assets/*`, `duckdb/*.worker.js`, `fonts/*` | Cloudflare Pages | repo root of `query_prod` |

The R2 object key embeds the DuckDB-WASM version (`1.33.1-dev57.0`), which makes immutable caching (`public, max-age=31536000, immutable`) safe: a future package bump gets a new key and URL by design.

Code change (`src/services/sqlEngine.ts` only): `DUCKDB_WASM_VERSION` constant; `mainModule` URLs resolve to `https://assets.querymind.in/duckdb/${DUCKDB_WASM_VERSION}` in production builds while development (`import.meta.env.DEV`) keeps loading same-origin from `public/duckdb/`; optional build-time override `VITE_DUCKDB_WASM_BASE_URL` (documented in `.env.example`) for testing against an alternate asset host. Worker URLs unchanged.

## 4. Verification evidence

### 4.1 Static checks

| Check | Result |
|---|---|
| `npm ci` | OK |
| `npx tsc --noEmit` | silent (OK) |
| `npm test` | 301 tests / 83 suites / 301 pass / 0 fail |
| `npm run build` | OK — deterministic; repeated builds produce identical hashes |
| Bundle contains R2 URLs | `https://assets.querymind.in/duckdb/${version}/duckdb-eh.wasm` and `-mvp.wasm` present in the emitted bundle |
| No third-party CDN URLs | no `cdn.jsdelivr.net` request URLs in the bundle (one `jsdelivr` string is inert library package metadata) |
| `VITE_DUCKDB_WASM_BASE_URL` not leaked | env var name absent from the production bundle; undefined at build time → default R2 base used |

### 4.2 Cross-origin loading simulation (real browser, production mechanics)

A scratch build with `VITE_DUCKDB_WASM_BASE_URL=http://localhost:8787/duckdb/1.33.1-dev57.0` was served at `http://localhost:4173` (vite preview of the production bundle) while a static server replicated the exact R2 behavior for the WASM objects: HTTP 200, `Content-Type: application/wasm`, `Content-Length`, `Access-Control-Allow-Origin: http://localhost:4173`, `Cache-Control: public, max-age=31536000, immutable`.

Results:

1. Asset server log shows the worker's fetch: `HIT /duckdb/1.33.1-dev57.0/duckdb-eh.wasm` — a cross-origin request from page origin `localhost:4173`, served 200 `application/wasm`.
2. DuckDB-WASM initialized through the cross-origin path (worker created, WASM streamed and instantiated).
3. End-to-end query executed in the app: "QUERY MATCHES REQUEST (7 CHECKS PASSED)", results table (3 rows), chart visualization, executive analysis summary, generated SQL shown ("In-Memory DuckDB").
4. Browser console clean — no CORS errors, no WASM errors.
5. A second session fetched the binary from the browser's immutable cache (no server hit) and executed identically.

The production bundle differs from this scratch build only by the asset base URL constant; the loading mechanics exercised are identical to what R2 will serve.

### 4.3 Artifact integrity

Rebuilt release bundle: only two artifacts changed versus the previous verified release — both because of the URL constant:

| Artifact | Old (8e6483f release) | New | Change |
|---|---|---|---|
| `assets/index-sn9S7bCm.js` → `assets/index-aKeiN4x3.js` | `8c03ef43…` | `7e94d706…` | WASM URL constant |
| `index.html` | `e1f2af14…` | `e4cd0a0f…` | references the new JS hash |
| `assets/index-B5urW9Yt.css` | `0578ef8e…` | `0578ef8e…` | byte-identical |
| `duckdb/*.worker.js` | `fa889e60…` / `964f678d…` | `fa889e60…` / `964f678d…` | byte-identical |
| `.wasm` binaries | `3abdec74…` / `ee556014…` | `3abdec74…` / `ee556014…` | byte-identical (untouched) |
| fonts, image | unchanged | unchanged | byte-identical |

## 5. Security and privacy impact

- **No dataset egress:** R2 receives only the two static `.wasm` binaries uploaded once by the operator. CSV parsing, SQL execution and results remain entirely in browser memory; nothing in the R2 path handles user data.
- **No credentials in the client:** the app references only the public URL; no R2 API tokens exist in the bundle, the repository, or `.env.example` (the optional `VITE_DUCKDB_WASM_BASE_URL` override is a URL, never a secret).
- **First-party boundary preserved:** `assets.querymind.in` is operator-owned (no third-party CDN); the R2 bucket serves only these static objects and keeps CORS restricted to the approved origins with `GET`, no credentials.
- **Integrity pinning:** both binaries are pinned by SHA-256 in the release inventory; operators should verify the uploaded object checksums after upload.
- **SQL validation, DuckDB execution semantics, provider integrations, and key storage are untouched** — the diff is confined to the asset-base URL resolution.

## 6. Repository changes

- `query_main`: `src/services/sqlEngine.ts` (asset-base resolution), `.env.example` (optional override placeholder), `docs/DEPLOYMENT.md` (R2 architecture + hosting table + checklist), `docs/SECURITY.md` (network boundary note), this report.
- `query_prod`: the two `.wasm` files removed from the deployment repository (they cannot be uploaded to Pages), the two updated artifacts (`index.html`, new JS hash), and an updated deployment README documenting the split hosting and the new inventory.

## 7. Outstanding (operator actions)

1. Create the R2 bucket `querymind-static`, upload the two binaries at the versioned keys with `application/wasm` + immutable cache metadata, and verify SHA-256 against the inventory.
2. Attach the custom domain `assets.querymind.in` and configure CORS for the approved origins.
3. Deploy the updated `query_prod` to Cloudflare Pages and run the live post-deployment checks (R2 200/content-type/CORS, query end-to-end, console clean).
4. Until step 3 is complete, the live-domain behavior of the new bundle is **unverified**; the previous deployed bundle remains the last live-verified release.
