import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { PublicSite } from '../src/components/public/PublicSite';
import {
  CONTACT_META,
  LANDING_META,
  NOT_FOUND_META,
  PRIVACY_META,
  WORKSPACE_META,
  renderSeoBlock,
  type PageMeta,
  type PublicMetaRoute,
} from '../src/services/siteMeta';

type StaticRoute = PublicMetaRoute | 'not-found' | null;

interface PrerenderOutput {
  file: string;
  /** null emits an empty root: the workspace needs the browser, so only its head is static. */
  route: StaticRoute;
  meta: PageMeta;
}

// Cloudflare Pages disables its automatic SPA fallback as soon as a top-level 404.html exists,
// so every route needs its own document: /, /privacy and /contact render their pages, /app gets
// its own head with an empty root for the client mount, and unknown paths get the not-found
// document (Pages serves it with a 404 status). app.html is required precisely because the
// custom 404 page replaces the catch-all fallback.
const OUTPUTS: PrerenderOutput[] = [
  { file: 'index.html', route: 'landing', meta: LANDING_META },
  { file: 'privacy.html', route: 'privacy', meta: PRIVACY_META },
  { file: 'contact.html', route: 'contact', meta: CONTACT_META },
  { file: 'app.html', route: null, meta: WORKSPACE_META },
  { file: '404.html', route: 'not-found', meta: NOT_FOUND_META },
];

const HEAD_PATTERN = / {2}<!-- seo:start -->[\s\S]*?<!-- seo:end -->/;
const ROOT_MARKER = '<div id="root"></div>';

/**
 * Swaps the document head for the route's block and puts the server-rendered public page inside
 * the root. The client keeps using createRoot, so React replaces this markup after mount instead
 * of hydrating it; the visible result is the same and no hydration mismatch is possible.
 */
export function composeDocument(template: string, meta: PageMeta, markup: string): string {
  if (!HEAD_PATTERN.test(template)) throw new Error('dist/index.html is missing the seo marker block');
  if (!template.includes(ROOT_MARKER)) throw new Error('dist/index.html is missing the empty root');
  return template
    .replace(HEAD_PATTERN, renderSeoBlock(meta))
    .replace(ROOT_MARKER, `<div id="root">${markup}</div>`);
}

function main(): void {
  const distDir = path.resolve('dist');
  const template = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');

  for (const { file, route, meta } of OUTPUTS) {
    const markup = route === null ? '' : renderToString(<PublicSite route={route} />);
    fs.writeFileSync(path.join(distDir, file), composeDocument(template, meta, markup));
    const rendered =
      route === null ? 'empty root (client mount)' : `PublicSite(${route}), ${Buffer.byteLength(markup)} bytes of markup`;
    console.log(`prerender: ${file} ← ${rendered}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
