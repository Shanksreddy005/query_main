# QueryMind — SEO and Crawler Rendering

This document describes what the public site now ships for search engines, social previews and
crawlers, and what still has to be confirmed against the live origin after the next deployment.

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
`/app.html` → `/app`. It also normalises these routes with a permanent redirect; measured on the
live origin on 2026-11-25, both `/index.html` and `/index/` answered `308` to `/`, so `/privacy/`,
`/contact/` and `/app/` are expected to converge on the extension-less routes in the same way.

A top-level `404.html` is the switch that matters. Per Cloudflare's serving documentation, Pages
assumes a single-page application and falls back to the root document for unmatched paths only
when no top-level `404.html` exists. The custom 404 page therefore turns that catch-all off, which
is exactly what this build relies on: each route is a real document, and `app.html` exists so that
`/app` is one of them. The site has exactly one client route, so no other deep link depended on
the fallback. `robots.txt` still allows crawling and disallows only `/app`; unknown paths answer
with the not-found document and HTTP 404, which is the correct signal for search engines.

There is no `_redirects`, `_routes.json` or `_headers` file in either repository, so nothing
overrides this mapping. Do not add a catch-all rewrite to `index.html`: it would serve the landing
document for `/privacy` and `/app` as well.

This mapping is documented and simulated locally, not yet measured on the deployed origin; the
current live release does not contain the documents. After the next authorized release, confirm:

- `/`, `/privacy`, `/contact` return their own documents with the correct head;
- `/privacy.html`, `/contact.html` and `/app.html` redirect to their extension-less forms;
- `/app` returns `app.html` with `noindex,nofollow` and no canonical, and `/app/` normalises to `/app`;
- an unknown path returns `404.html` with HTTP 404, `noindex,nofollow` and no canonical;
- `/robots.txt` and `/sitemap.xml` still return the real files.

## Discovery files

- `robots.txt` allows crawling, disallows `/app`, and declares
  `Sitemap: https://querymind.in/sitemap.xml`.
- `sitemap.xml` lists exactly `/`, `/privacy` and `/contact` as absolute HTTPS URLs, with no
  `lastmod` date and no `/app` entry. The canonical URLs and the sitemap entries are generated from
  the same metadata module and are asserted equal by `tests/seo_metadata.test.ts`.

### robots.txt versus noindex

They do different jobs. `robots.txt` controls **crawling**: a disallowed URL is not fetched, so a
`noindex` directive inside that page can never be seen. `noindex` controls **indexing** of a page
the crawler is allowed to fetch. That is why `/app` uses both: `robots.txt` keeps crawlers out, and
the static `noindex,nofollow` in `app.html` covers clients that already have the document open or
fetch it regardless. Unknown paths are not disallowed, so a crawler can fetch the not-found
document; the HTTP 404 status and its static `noindex,nofollow` keep it out of the index, and the
document carries no canonical that could compete with a real page.

## Search Console readiness

Nothing below has been performed yet. The domain is not claimed to be indexed merely because a URL
returns HTTP 200.

1. Verify ownership of `querymind.in` (DNS TXT record or the HTML file method in the site's static
   assets; no verification token has been added to the source).
2. Submit `https://querymind.in/sitemap.xml`.
3. Inspect `https://querymind.in/` and confirm the Google-selected canonical is the apex URL.
4. Inspect `/privacy` and `/contact`; confirm each renders and reports its own canonical.
5. Review the indexing status of all three routes after the first crawl.
6. Request indexing for the three public URLs after the deployment is live.
7. Recheck the Pages indexing and crawl reports after a few days.
8. Confirm `/app` does not appear in the index and that the sitemap reports no errors.

## What is not verified here

- Search Console ownership, sitemap submission, Google-selected canonicals and indexing — no
  account access was used.
- Google's or LinkedIn's rendered previews of the social card — their caches are external.
- Cloudflare Pages' clean-URL mapping, custom 404 precedence and HTTP status, and trailing-slash
  redirects for the new documents on the live origin — documented and simulated locally, not yet
  measured on Pages.
- The existing `www.querymind.in` DNS behaviour — out of scope for this release.
- The workspace's R2/WASM path from a local origin (CORS correctly allows only `https://querymind.in`);
  it is unchanged and still verified on the deployed origin.

## Maintenance

- Change public metadata in `src/services/siteMeta.ts`. The block in `index.html` must match
  `renderSeoBlock(LANDING_META)`; the SEO test fails if they diverge. The workspace and not-found
  heads come from `WORKSPACE_META` and `NOT_FOUND_META` in the same module.
- Regenerate the social card from `docs/og-card.html` after changing the design, and keep the
  dimensions at 1200 × 630.
- Update `robots.txt` or `sitemap.xml` whenever the public route set changes, and keep the sitemap
  in sync with `PUBLIC_PAGE_META`. Keep `app.html` in the build: with `404.html` present, Pages no
  longer falls back to `index.html` for `/app`.
- Re-run `npx tsc --noEmit && npm test && npm run build`; the build now fails if the head markers or
  the empty root are missing from the Vite template.
