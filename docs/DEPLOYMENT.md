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

## Deploying

Upload the **contents** of `dist/` (i.e. `index.html`, `assets/`, `duckdb/`, `fonts/`) to any static host:

| Host | Notes |
|---|---|
| Netlify | Drag-and-drop or `npx netlify-cli deploy --dir dist`; serves `.wasm` correctly. |
| Vercel | Deploy as "Other" with output directory `dist`. |
| GitHub Pages | Per-file limit 100 MB — the largest file (`duckdb/duckdb-mvp.wasm`, 39.4 MB) fits but uploads slowly; prefer root or custom domain (root-relative asset paths). |
| Cloudflare Pages | **25 MiB per-file upload limit rejects the DuckDB-WASM binaries** — not suitable without an alternative asset path. |
| nginx / object storage | Serve `.wasm` as `application/wasm`; `index.html` → `no-cache`; hashed `assets/*` → immutable long cache. |

DuckDB-WASM ships both variants (`duckdb-mvp`, `duckdb-eh`); the single-threaded variant needs no special headers, while the multi-threaded one requires cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`) — safe to enable since every asset is same-origin.

## Production deployment repository

The production deployment is published as a separate repository containing **only** the contents of the verified `dist/` plus a deployment README (source commit SHA, build date, build command, checksums). It must always be regenerated from a verified source commit — never hand-edited.

## Deployment checklist

- [ ] `npx tsc --noEmit` silent, `npm test` 301/301, build succeeds.
- [ ] Uploaded file hashes match the build (record them in the deployment README).
- [ ] No `.env`, datasets, keys or `node_modules` uploaded.
- [ ] HTTPS forced; `.wasm` served as `application/wasm`.
- [ ] Post-deploy: app loads with no console errors; all fetched resources same-origin; a bundled sample query returns "QUERY MATCHES REQUEST (n CHECKS PASSED)"; an invalid key shows a clear provider error; Telemetry Auditor shows schema-metadata-only request bodies.
