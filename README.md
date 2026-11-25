# QueryMind

Browser-native natural-language analytics: upload a CSV, ask a question in plain English, and get validated SQL, a locally executed DuckDB-WASM result, a chart and an evidence-grounded summary — bring-your-own-key, with no backend of QueryMind's own.

**Release status:** v1.2 — the public-site release (source `2b3f4fb`) was deployed to `https://querymind.in` via `query_prod` commit `aa0a7e6` on 2026-11-25 and live-verified: asset hashes, all public routes, robots/sitemap and the workspace smoke tests passed. The current working tree replaces the public header's three-state theme cycle with two explicit light/dark buttons, and adds the SEO release candidate: route metadata with canonical URLs, a committed 1200 × 630 social card, and a pre-rendered document for every route (`/`, `/privacy`, `/contact`, `/app` and a static `404.html`) at build time. It runs 481 tests / 122 suites with a byte-for-byte reproducible build; none of these changes is deployed yet. Real-provider verification on Google Gemini and Groq was completed in the earlier release passes, and the live browser verification of the deployed bundle, the R2 engine binaries, keyless demo behaviour and the ranked-summary fix is recorded in [docs/verification/v1.2-live-production-verification.md](docs/verification/v1.2-live-production-verification.md).

## How it works

The LLM is a semantic planner only. Every plan must pass a deterministic validation contract, executes locally in DuckDB-WASM, and every summary sentence is computed from the executed result set — never from provider prose. Unsupported metrics are refused before any provider call. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

```bash
npm ci            # clean install
npm run dev       # dev server on http://localhost:3000
npm test          # 481 tests / 122 suites
npm run build     # production build → dist/ (pre-renders every route, including app.html and 404.html)
npm run preview   # serve dist/ at http://127.0.0.1:4173
```

Public routes: `/` landing page, `/privacy` policy, `/contact`; the analytics workspace is at `/app`.

**Provider key (BYOK):** open Settings (gear icon) → pick Gemini / Groq / OpenAI → paste your key → **Test Key** → **Save Configuration**. Keys live in tab memory unless you opt in to "Remember API key". `.env.example` contains placeholder-only variables; never commit real keys. Bundled verified sample queries work without a key — on the deployed v1.2 build they are answered locally, with no provider request made.

## Repository layout

```
├── src/            Application code (components, services, config, public pages)
├── public/         First-party assets: DuckDB-WASM worker scripts and engine binaries, fonts,
│                   robots.txt, sitemap.xml and the 1200 × 630 social card in og/
│                   (in production the two oversized .wasm binaries are served from the
│                   operator's R2 domain rather than uploaded to Pages)
├── scripts/        prerender.tsx — renders every route document into dist/ after vite build
├── tests/          21 test files — the deterministic contract, provider transport,
│                   memory cleanup, summary correctness, security regressions, public-site
│                   routing, disclosure and SEO metadata contracts
├── docs/           Engineering documentation
│   ├── ARCHITECTURE.md     Pipeline and module map
│   ├── SECURITY.md         Security architecture and SQL sandboxing
│   ├── PRIVACY.md          Outbound data policy and credential threat model
│   ├── SEO.md              Metadata, social card, pre-rendering and Search Console checklist
│   ├── TESTING.md          Test suite and regression policy
│   ├── DEPLOYMENT.md       Build reproducibility, hosting, checklists
│   └── verification/       Release verification evidence and sign-off
├── index.html
├── package.json / package-lock.json
├── tsconfig.json / vite.config.ts
├── .env.example    Placeholder-only environment variable reference
├── .gitignore      Excludes env files, keys, node_modules, build output, local datasets
├── .gitattributes  Pins LF so clean clones build byte-identically
└── QueryMind UI & Analytics Review.md
                    Historical pre-release review — kept at the root because it is a
                    scanned Tailwind build input (removing it changes build output;
                    see docs/DEPLOYMENT.md)
```

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Plan → validate → execute → summarize pipeline, module map. |
| [docs/SECURITY.md](docs/SECURITY.md) | Security posture, client-side execution boundary, SQL sandboxing. |
| [docs/PRIVACY.md](docs/PRIVACY.md) | What is (and is never) transmitted to providers; BYOK threat model. |
| [docs/SEO.md](docs/SEO.md) | Route metadata, canonical URLs, social card, pre-rendering, Search Console checklist. |
| [docs/TESTING.md](docs/TESTING.md) | Test inventory and regression policy. |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Reproducible builds, hosting options, deployment checklists. |
| [docs/verification/README.md](docs/verification/README.md) | Audit → verification → production approval → smoke test → R2 remediation → production-quality remediation → v1.2 release candidate → v1.2 live verification → sign-off. |

## Contributing

- Every bug fix lands with a regression test in `tests/`; run `npx tsc --noEmit && npm test && npm run build` before proposing changes.
- Do not weaken the validation contract, the SQL sandbox, or the egress policy; the LLM is a planner, never the source of truth.
- Build outputs are content-addressed: a rebuild of unchanged source must reproduce identical hashes — investigate any mismatch instead of shipping it.

## Security

Report security issues privately to the repository owner. Key hygiene rules that always apply: never commit, paste, or log API keys; rotate any key that was ever shared in plain text; `.gitignore` excludes `.env*`, keys, certificates and local datasets by design.
