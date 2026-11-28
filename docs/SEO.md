# QueryMind — SEO and Crawler Rendering

This document describes what the public site now ships for search engines, social previews and
crawlers. The route documents have been live since the 2026-11-25 release, and the Phase 1 security
headers were deployed on 2026-11-27; the measured behaviour on the live origin is recorded below.
SEO Release 1 (homepage H1, homepage JSON-LD, sitemap dates, documentation) is implemented locally
and is not deployed yet.

## Metadata

One module, `src/services/siteMeta.ts`, owns the route metadata. `index.html` commits the landing
block between `<!-- seo:start -->` and `<!-- seo:end -->`; the build step swaps that block for the
route's block when it emits the other four documents. `usePageMeta` applies the same values when
the client changes route, so a client-rendered visit and a crawled document agree.

| Route | Title | Description | Canonical | Robots |
|---|---|---|---|---|
| `/` | QueryMind \| Browser-Based Natural Language to SQL | Ask questions about your data in plain English. QueryMind turns natural language into SQL and runs the analysis locally in your browser with DuckDB-WASM. | `https://querymind.in/` | `index,follow` |
| `/privacy` | Privacy Policy — QueryMind | How QueryMind handles datasets, AI-provider requests, API keys, browser storage, exports and hosting infrastructure. | `https://querymind.in/privacy` | `index,follow` |
| `/contact` | Contact — QueryMind | Verified public channels for QueryMind questions, bug reports and private security reports. | `https://querymind.in/contact` | `index,follow` |
| `/app` | Workspace — QueryMind | QueryMind's browser-based analysis workspace. This page is excluded from search indexing. | none | `noindex,nofollow` (static in `app.html`) |
| unknown | Page Not Found — QueryMind | The requested page does not exist. Return to the QueryMind landing page or open the workspace. | none | `noindex,nofollow` (static in `404.html`, HTTP 404) |

The two non-indexable documents carry only the title, description and robots directives. They do
not inherit the homepage canonical, `og:url`, social card or Twitter image.

The description avoids an unqualified "your data stays local" claim: SQL execution and dataset
processing are local, but a configured provider receives the question and schema metadata. The
description therefore says the analysis runs locally in the browser, which is what the application
does.

### Social metadata

All three indexable routes carry `og:type`, `og:site_name`, `og:title`, `og:description`, `og:url`,
`og:image`, `og:image:width`, `og:image:height`, `og:image:alt`, `twitter:card`
(`summary_large_image`), `twitter:title`, `twitter:description` and `twitter:image`. Every URL is
absolute HTTPS on the apex domain; `og:url` equals the route's canonical.

The social card is [`public/og/querymind-social-preview.png`](../public/og/querymind-social-preview.png):
1200 × 630 PNG, 64,834 bytes, built from the committed design source
[`docs/og-card.html`](og-card.html) with the repository's own Inter and JetBrains Mono files. It is
byte-reproducible:

```bash
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu \
  --hide-scrollbars --force-device-scale-factor=1 --window-size=1200,630 \
  --virtual-time-budget=4000 \
  --screenshot=public/og/querymind-social-preview.png docs/og-card.html
```

The card shows the product identity, the descriptor "Browser-Based Natural Language to SQL", and a
question → validated SQL → local result schematic. It contains no usage statistics, testimonials,
customer logos or performance claims.

### Structured data

The homepage carries exactly one JSON-LD block, rendered by `renderSeoBlock()` from
`LANDING_STRUCTURED_DATA` in `src/services/siteMeta.ts`. It is a single `@graph` with two entities:
`WebSite` (`https://querymind.in/#website`) and `SoftwareApplication`
(`https://querymind.in/#software`), both with `url` equal to the homepage canonical, and
`publisher` pointing at the `WebSite` node.

The `SoftwareApplication` node states the name, a factual description, `applicationCategory`
`BusinessApplication`, `operatingSystem` `Web browser`, and five `featureList` entries that all ship
in the application. It deliberately carries **no** `offers`, price, `isAccessibleForFree`,
`aggregateRating`, `review`, `ratingValue`, version, license or download figures. Valid structured
data does not guarantee a rich result; without ratings or reviews this markup is an entity
description only.

`/privacy`, `/contact`, `/app` and `404.html` carry no JSON-LD, so no duplicate entities compete
with the homepage graph. Tests parse the block with `JSON.parse`, assert one block and two node
types, assert canonical consistency, assert the absence of offer/rating properties, and assert the
block is absent from every other document.

## Rendering architecture

The application is still a Vite + React client-side app, but every route now has its own document
produced at build time:

| Route | Document served | Initial HTML |
|---|---|---|
| `/` | `dist/index.html` | Full landing page: header, navigation, H1, sections, FAQ, CTA, footer |
| `/privacy` | `dist/privacy.html` | Full privacy policy (14 sections) |
| `/contact` | `dist/contact.html` | Full contact page |
| `/app` | `dist/app.html` | Workspace title and noindex only; empty React root, client mounts the environment |
| unknown | `dist/404.html` | Full not-found page, served by Pages with HTTP 404 |

`scripts/prerender.tsx` runs after `vite build`. It renders `<PublicSite route=… />` with
`react-dom/server`, swaps the head block for the route's metadata, and writes the five documents.
`app.html` gets an empty root because the workspace needs browser APIs; no workspace module, worker
or dataset is touched during pre-rendering. No framework, router or runtime dependency was added;
`react-dom/server` is part of the existing `react-dom` package.

The client still mounts with `createRoot` (not `hydrateRoot`). React replaces the pre-rendered
markup on mount; the result is the same public page, and no hydration mismatch is possible. The
theme buttons, route metadata updates and the workspace mount all run exactly as before.

### Static-host mapping

Cloudflare Pages serves the HTML file that matches the request path and redirects the file URL to
its extension-less form: `/privacy.html` → `/privacy`, `/contact.html` → `/contact`,
`/app.html` → `/app`. Measured on the live origin on 2026-11-25, `/index.html` answered `308` to
`/`; re-measured on 2026-11-28, `/privacy.html`, `/privacy/`, `/app/` and `/index.html` all answer
`308` to their canonical extension-less form.

A top-level `404.html` is the switch that matters. Per Cloudflare's serving documentation, Pages
assumes a single-page application and falls back to the root document for unmatched paths only
when no top-level `404.html` exists. The custom 404 page therefore turns that catch-all off, which
is exactly what this build relies on: each route is a real document, and `app.html` exists so that
`/app` is one of them. The site has exactly one client route, so no other deep link depended on
the fallback. `robots.txt` still allows crawling and disallows only `/app`; unknown paths answer
with the not-found document and HTTP 404, which is the correct signal for search engines.

There is no `_redirects` or `_routes.json` file in either repository, so nothing overrides this
mapping. A top-level `_headers` file exists for response headers only (Phase 1) and does not
participate in routing. Do not add a catch-all rewrite to `index.html`: it would serve the landing
document for `/privacy` and `/app` as well.

The mapping is no longer simulated: on 2026-11-28 the live origin returned `200` for `/`,
`/privacy`, `/contact` and `/app`, `404` for an unknown path, and the redirects listed above.

## Discovery files

- `robots.txt` allows crawling, disallows `/app`, and declares
  `Sitemap: https://querymind.in/sitemap.xml`.
- `sitemap.xml` lists exactly `/`, `/privacy` and `/contact` as absolute HTTPS URLs, with a
  `lastmod` set to each page's last meaningful content change (2026-11-28 for `/`, 2026-11-25 for
  `/privacy` and `/contact`), no `changefreq` or `priority` hints, and no `/app` entry. The
  canonical URLs and the sitemap entries come from the same metadata module and are asserted equal
  by `tests/seo_metadata.test.ts`; deployment timestamps are never used as content dates.

### robots.txt versus noindex

They do different jobs. `robots.txt` controls **crawling**: a disallowed URL is not fetched, so a
`noindex` directive inside that page can never be seen. `noindex` controls **indexing** of a page
the crawler is allowed to fetch. That is why `/app` uses both: `robots.txt` keeps crawlers out, and
the static `noindex,nofollow` in `app.html` covers clients that already have the document open or
fetch it regardless. Unknown paths are not disallowed, so a crawler can fetch the not-found
document; the HTTP 404 status and its static `noindex,nofollow` keep it out of the index, and the
document carries no canonical that could compete with a real page.

## Search Console readiness

Search Console ownership verification, sitemap submission and indexing requests were reported by
the project owner in the project context. They have not been independently re-verified from this
repository: no Search Console account access was used for this document.

Status as reported by the owner: domain ownership verified, sitemap submitted, homepage indexed,
and indexing requested for the privacy and contact pages. The current live HTML and Googlebot's
retrievable HTML both carry the reviewed metadata (verified 2026-11-28), so no source-side conflict
remains. Google's index can lag a metadata release, and Google may rewrite a search-result title or
snippet; a refresh of the search appearance is not guaranteed and must be confirmed in Search
Console before it is described as complete.

The URL to inspect is `https://querymind.in/` (then `/privacy` and `/contact`). Use "Test live URL"
before "Request indexing" so the test reflects the deployed document rather than a cached one.

## What is not verified here

- Search Console ownership, sitemap submission, Google-selected canonicals, indexed HTML and
  indexing outcomes — user-reported, not independently re-verified here.
- Google's or LinkedIn's rendered previews of the social card — their caches are external.
- The effect of SEO Release 1 (H1, JSON-LD, sitemap dates) on Google's index or search appearance —
  the release is implemented locally and not deployed.
- The existing `www.querymind.in` DNS behaviour — out of scope for this release.
- Core Web Vitals field data — not measured here.

## Maintenance

- Change public metadata in `src/services/siteMeta.ts`. The block in `index.html` must match
  `renderSeoBlock(LANDING_META)`; the SEO test fails if they diverge. The workspace and not-found
  heads come from `WORKSPACE_META` and `NOT_FOUND_META` in the same module.
- Edit `LANDING_STRUCTURED_DATA` in the same module for structured-data changes, and re-run the
  build so `index.html` regenerates. Do not add offers, prices, ratings or reviews without a
  separately reviewed, factual basis.
- Regenerate the social card from `docs/og-card.html` after changing the design, and keep the
  dimensions at 1200 × 630. Publish a new filename and update `SOCIAL_IMAGE_PATH` if the card
  changes, because the current URL is cached by intermediaries.
- Update `robots.txt` or `sitemap.xml` whenever the public route set changes, and keep the sitemap
  in sync with `PUBLIC_PAGE_META`. Set `lastmod` only to the page's last meaningful content date,
  never to a deployment timestamp; the SEO test pins the current dates. Keep `app.html` in the
  build: with `404.html` present, Pages no longer falls back to `index.html` for `/app`.
- `public/_headers` is the Phase 1 response-header policy and is mirrored byte-for-byte into the
  production repository. Do not edit it as part of SEO work.
- Re-run `npx tsc --noEmit && npm test && npm run build`; the build now fails if the head markers or
  the empty root are missing from the Vite template.
