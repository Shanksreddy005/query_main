# QueryMind v1.0 — Release Sign-off

**Sign-off date:** 2026-11-17

## Release identity

| Item | Value |
|---|---|
| Product | QueryMind — browser-native natural-language analytics (BYOK, zero backend) |
| Source commit | `8e6483ff66dc4962dd2748666af6518c3f09bedb` (branch `main`, clean tree) |
| History | `942d6d3` (verified release candidate) → `aaf9a59` (byte-identical line endings) → `8e6483f` (SQL-derived summary wording) |

## Verified build identity (all 10 files in `dist/`)

| File | SHA-256 |
|---|---|
| `assets/index-sn9S7bCm.js` | `8c03ef43ed796a1d09b8dc41f03a957aa81614d195cca5d5fe3d4d69826f41b5` |
| `assets/index-B5urW9Yt.css` | `0578ef8eb7d42c66df4c20e7139d108060ae648a43ca9328a6f5e25ccf28db6f` |
| `index.html` | `e1f2af141631be5be58bfd23bfceee0f863050443664f0dc6a464ec197148ff7` |
| `duckdb/duckdb-eh.wasm` | `3abdec74989dcc54d2f2ea5621f611f3c45db1e7dff2f408476014d82beb2029` |
| `duckdb/duckdb-mvp.wasm` | `ee5560145a3d3e0ffa6dce697be802c08842f139a594698eecc7c754f7ad5f05` |
| `duckdb/duckdb-browser-eh.worker.js` | `fa889e6068c40426dea67c08cf16ce0cad7404eae94f6a2522adcabb5898eb93` |
| `duckdb/duckdb-browser-mvp.worker.js` | `964f678d3bfa5a23deb154e0a7950634a4d1415e571040ab2d47815dc3f13582` |
| `fonts/inter-latin-variable.woff2` | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` |
| `fonts/jetbrains-mono-latin-variable.woff2` | `83c005d49d8a6a50474c73a5a36ac0468076e9c4a29da7bdb14995d80560a5be` |
| `assets/aistudio/image_ff69bad7.png` | `ff69bad7d2d91321292459a2b54392093e123d0575276a5ee8d7f69bc0cac6dc` |

## Test evidence

| Check | Result |
|---|---|
| Type check (`npx tsc --noEmit`) | clean |
| Unit/integration suite (`npm test`) | 301 tests / 83 suites / 301 pass / 0 fail |
| Clean-clone reproducibility (`git clone` → `npm ci` → build) | all 10 dist files byte-identical |
| 30-question benchmark through the app | Pass |
| 24 browser edge cases | Pass |
| Real-provider integration (Gemini 3.6 Flash, 12 questions / all 10 categories; Groq gpt-oss-120b) | Pass — see Part A |
| Post-rotation deployment smoke test | 12/12 PASS |

## Decision chain

1. [full-audit-report.md](full-audit-report.md) — audit findings drove the remediation contract.
2. [final-release-verification-report.md](final-release-verification-report.md) — CONDITIONALLY APPROVED (provider simulated, no VCS).
3. [final-production-approval-report.md](final-production-approval-report.md) — **APPROVED FOR PUBLICATION** (real providers, Git reproducibility proven).
4. [post-rotation-smoke-test-report.md](post-rotation-smoke-test-report.md) — 12/12 PASS with rotated credentials.

## Security & privacy sign-off

- No dataset rows, complete query results, or credentials were transmitted to any provider at any point in verification (audited per request).
- No credential exists in source, storage, logs, `dist/`, or Git history; the keys used during testing were rotated and confirmed absent afterwards.
- Deterministic validation contract enforced on every execution path; fallback results are explicitly labelled and never presented as AI-verified.

**Signed off as:** APPROVED FOR PUBLICATION — deployment-ready with rotated provider credentials.

---

## Dual-repository publication (2026-11-17)

The release is published as two independent repositories generated from this source:

- `query_main` (source repository) — this repository: verified source, tests, engineering documentation and verification evidence.
- `query_prod` (production repository) — only the contents of the verified `dist/` plus a deployment README naming the source commit, build date, build command and file checksums. Its artifacts are byte-identical to the hashes above (the documentation-only commit that added `docs/` does not change the build output; verified by rebuild comparison).
