# QueryMind — Deployment Guide

QueryMind is a pure static application after build: no server, no database, no cookies, no client-side routing (so no rewrite rules are needed).

## Production build

```bash
npm ci
npx tsc --noEmit   # must be silent
npm test           # 301 tests must pass
npm run build      # emits dist/
npm run preview    # serves dist/ at http://127.0.0.1:4173 for local checks
```

## Rebuild reproducibility

A faithful rebuild of the same source tree is **byte-identical** (verified from a clean clone: `git clone` → `npm ci` → build, all output files matching SHA-256). Two notes:

1. `.gitattributes` pins LF so every platform checks out identical bytes.
2. **`QueryMind UI & Analytics Review.md` at the repository root is a build input.** Tailwind CSS v4 scans root files for utility-class candidates; that historical review document is among the scanned files and removing/renaming it changes the emitted CSS by a few equivalent bytes (different asset hash/filename). Keep it in place. Documentation under `docs/` is deliberately written without literal utility-class names for the same reason.

## DuckDB-WASM asset hosting (Cloudflare Pages + R2)

Both DuckDB-WASM binaries exceed Cloudflare Pages' 25 MiB per-file limit (`duckdb-eh.wasm` 34.3 MiB, `duckdb-mvp.wasm` 39.4 MiB), so the production build fetches the `.wasm` modules from the first-party Cloudflare R2 bucket `querymind-static` via the custom domain `assets.querymind.in`. The worker scripts (773 KB / 820 KB) and all other assets stay on Pages.

| Asset | Served from | R2 object key |
|---|---|---|
| `duckdb/duckdb-eh.wasm` | `https://assets.querymind.in/duckdb/1.33.1-dev57.0/duckdb-eh.wasm` | `duckdb/1.33.1-dev57.0/duckdb-eh.wasm` |
| `duckdb/duckdb-mvp.wasm` | `https://assets.querymind.in/duckdb/1.33.1-dev57.0/duckdb-mvp.wasm` | `duckdb/1.33.1-dev57.0/duckdb-mvp.wasm` |
| everything else (`index.html`, `assets/`, `duckdb/*.worker.js`, `fonts/`) | Pages (repo root) | — |

R2 object requirements:

- **Content-Type:** `application/wasm` (the worker uses `WebAssembly.instantiateStreaming`, which rejects other MIME types).
- **CORS:** allowed origins `https://querymind.ai`, `https://www.querymind.ai`, and the Cloudflare Pages production/preview origins; methods `GET`; no credentials. The worker issues a plain cross-origin `GET` (no preflight).
- **Cache-Control:** `public, max-age=31536000, immutable` — safe because the object key embeds the DuckDB-WASM version.
- The bucket must stay private except for these public static objects; no credentials are needed by the app (public read via the custom domain only).

Code behavior (`src/services/sqlEngine.ts`):

- Development (`npm run dev`) loads the modules same-origin from `public/duckdb/` — unchanged.
- Production build points `mainModule` at the versioned R2 URL above; worker URLs remain same-origin.
- Build-time override: `VITE_DUCKDB_WASM_BASE_URL` (see `.env.example`) — only needed for testing against an alternate asset host.
- **Bumping `@duckdb/duckdb-wasm` requires updating the `DUCKDB_WASM_VERSION` constant in `src/services/sqlEngine.ts` and uploading the new binaries under the new versioned key** (old objects can remain for cache safety). Worker JS and WASM binaries must always be the same package version.

## Deploying

Upload the **contents** of `dist/` minus the two oversized `.wasm` files (i.e. `index.html`, `assets/`, `duckdb/` worker scripts, `fonts/`) to the static host; the `.wasm` modules go to R2 as tabled above:

| Host | Notes |
|---|---|
| Cloudflare Pages | Serve the trimmed `dist/` contents (all files ≤ 25 MiB); WASM binaries from R2 (`assets.querymind.in`). |
| Netlify | Full `dist/` works as-is (no per-file size problem), or use the same Pages+R2 split. |
| Vercel | Deploy as "Other" with output directory `dist` (full `dist/` works). |
| GitHub Pages | Per-file limit 100 MB — the largest file (`duckdb/duckdb-mvp.wasm`, 39.4 MB) fits but uploads slowly; prefer root or custom domain (root-relative asset paths). |
| nginx / object storage | Serve `.wasm` as `application/wasm`; `index.html` → `no-cache`; hashed `assets/*` → immutable long cache. |

DuckDB-WASM ships both variants (`duckdb-mvp`, `duckdb-eh`); the single-threaded variant needs no special headers, while the multi-threaded one requires cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`). The WASM module may load cross-origin from the first-party R2 domain — it contains no code that depends on the COOP/COEP setup of the embedding page.

## Production deployment repository

The production deployment is published as a separate repository containing **only** the contents of the verified `dist/` plus a deployment README (source commit SHA, build date, build command, checksums). It must always be regenerated from a verified source commit — never hand-edited.

## Deployment checklist

- [ ] `npx tsc --noEmit` silent, `npm test` 301/301, build succeeds.
- [ ] Uploaded file hashes match the build (record them in the deployment README).
- [ ] No `.env`, datasets, keys or `node_modules` uploaded.
- [ ] HTTPS forced; `.wasm` served as `application/wasm`.
- [ ] Cloudflare+R2 split: R2 objects return HTTP 200 with `application/wasm`, correct `Content-Length`, and CORS headers for the deployed origin; a bundled sample query executes end-to-end on the deployed site.
- [ ] Post-deploy: app loads with no console errors; fetched resources are first-party only (Pages origin + `assets.querymind.in` + one provider endpoint when a query runs); a bundled sample query returns "QUERY MATCHES REQUEST (n CHECKS PASSED)"; an invalid key shows a clear provider error; Telemetry Auditor shows schema-metadata-only request bodies.
