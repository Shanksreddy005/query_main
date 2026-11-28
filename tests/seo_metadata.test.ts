import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import {
  CONTACT_META,
  LANDING_META,
  NOT_FOUND_META,
  PRIVACY_META,
  PUBLIC_PAGE_META,
  SITE_ORIGIN,
  SOCIAL_IMAGE_HEIGHT,
  SOCIAL_IMAGE_PATH,
  SOCIAL_IMAGE_URL,
  SOCIAL_IMAGE_WIDTH,
  WORKSPACE_META,
  WORKSPACE_TITLE,
  canonicalUrl,
  renderSeoBlock,
} from '../src/services/siteMeta';

// The public head is indexable content now, so it is pinned like the page copy: one metadata
// source, canonical URLs that match the sitemap, a committed social card, and a pre-render step
// that gives crawlers the real page instead of an empty React root.

const read = (path: string) => fs.readFileSync(path, 'utf-8');
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

const html = read('index.html');
const robots = read('public/robots.txt');
const sitemap = read('public/sitemap.xml');
const pkg = JSON.parse(read('package.json'));
const prerender = read('scripts/prerender.tsx');
const hook = read('src/hooks/usePageMeta.ts');
const main = read('src/main.tsx');

const seoBlock = html.match(/<!-- seo:start -->[\s\S]*?<!-- seo:end -->/)?.[0] ?? '';
const image = fs.readFileSync(`public${SOCIAL_IMAGE_PATH}`);

const publicMeta = [LANDING_META, PRIVACY_META, CONTACT_META];

describe('Document head — one metadata source', () => {
  it('serves the landing block the metadata module renders', () => {
    assert.ok(seoBlock, 'index.html must carry the seo marker block');
    assert.strictEqual(flat(seoBlock), flat(renderSeoBlock(LANDING_META)));
  });

  it('describes each route with a unique title and a bounded description', () => {
    const titles = new Set(publicMeta.map((meta) => meta.title));
    const descriptions = new Set(publicMeta.map((meta) => meta.description));
    assert.strictEqual(titles.size, publicMeta.length);
    assert.strictEqual(descriptions.size, publicMeta.length);
    publicMeta.forEach((meta) => {
      assert.ok(meta.description.length <= 160, `${meta.title}: ${meta.description.length} chars`);
    });
    assert.deepStrictEqual(Object.keys(PUBLIC_PAGE_META), ['landing', 'privacy', 'contact']);
  });

  it('keeps every URL absolute, HTTPS and on the apex domain', () => {
    publicMeta.forEach((meta) => {
      assert.ok(meta.canonicalPath !== null);
      const url = canonicalUrl(meta.canonicalPath);
      assert.ok(url.startsWith(`${SITE_ORIGIN}/`), url);
      assert.ok(!url.includes('www.'), url);
      if (meta.canonicalPath !== '/') assert.ok(!url.endsWith('/'), url);
    });
    assert.strictEqual(SOCIAL_IMAGE_URL, `${SITE_ORIGIN}${SOCIAL_IMAGE_PATH}`);
    assert.ok(!/http:\/\//.test(seoBlock), 'no insecure URL in the document head');
    const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    locations.forEach((loc) => assert.ok(loc.startsWith('https://querymind.in/'), loc));
    assert.ok(!/www\./.test(seoBlock + JSON.stringify(publicMeta)));
  });

  it('makes the Open Graph URL and canonical agree for every route', () => {
    publicMeta.forEach((meta) => {
      const block = renderSeoBlock(meta);
      const canonical = canonicalUrl(meta.canonicalPath!);
      assert.ok(block.includes(`<link rel="canonical" href="${canonical}" />`), meta.title);
      assert.ok(block.includes(`<meta property="og:url" content="${canonical}" />`), meta.title);
      assert.ok(block.includes(`<meta property="og:image" content="${SOCIAL_IMAGE_URL}" />`));
      assert.ok(block.includes(`<meta name="twitter:image" content="${SOCIAL_IMAGE_URL}" />`));
    });
  });

  it('updates canonical, robots and Open Graph on client-side navigation', () => {
    assert.match(hook, /document\.title = meta\.title/);
    assert.match(hook, /setMeta\('meta\[name="robots"\]', meta\.robots\)/);
    assert.match(hook, /setMeta\('meta\[property="og:url"\]', href\)/);
    assert.match(hook, /setCanonical\(href\)/);
    assert.match(hook, /link\[rel="canonical"\]/);
  });

  it('makes no claim the application cannot support', () => {
    const text = flat(renderSeoBlock(LANDING_META) + renderSeoBlock(PRIVACY_META) + renderSeoBlock(CONTACT_META));
    const forbidden = [
      /100% private/i,
      /zero data transmission/i,
      /data never leaves your device/i,
      /fully offline/i,
      /\bthe (only|fastest|best)\b/i,
      /\bguarantee/i,
    ];
    forbidden.forEach((pattern) => assert.ok(!pattern.test(text), `forbidden claim: ${pattern}`));
  });
});

describe('Social preview asset', () => {
  it('is a real 1200 × 630 PNG committed to the source tree', () => {
    assert.strictEqual(image.slice(1, 4).toString('ascii'), 'PNG');
    assert.strictEqual(image.readUInt32BE(16), SOCIAL_IMAGE_WIDTH);
    assert.strictEqual(image.readUInt32BE(20), SOCIAL_IMAGE_HEIGHT);
    assert.strictEqual(SOCIAL_IMAGE_WIDTH, 1200);
    assert.strictEqual(SOCIAL_IMAGE_HEIGHT, 630);
    assert.ok(image.length > 20_000, 'the card must not be a placeholder');
    assert.ok(image.length < 500_000);
  });

  it('is referenced with absolute dimensions and alt text', () => {
    const block = renderSeoBlock(LANDING_META);
    assert.ok(block.includes(`<meta property="og:image:width" content="1200" />`));
    assert.ok(block.includes(`<meta property="og:image:height" content="630" />`));
    assert.ok(block.includes(`<meta property="og:image:alt" content="QueryMind — Browser-Based Natural Language to SQL" />`));
    assert.ok(block.includes('<meta name="twitter:card" content="summary_large_image" />'));
  });
});

describe('Indexing boundaries', () => {
  it('keeps /app disallowed and the sitemap reachable', () => {
    assert.match(robots, /User-agent: \*/);
    assert.match(robots, /Allow: \//);
    assert.match(robots, /Disallow: \/app/);
    assert.match(robots, /Sitemap: https:\/\/querymind\.in\/sitemap\.xml/);
    assert.ok(!/Disallow: \/\s*$/m.test(robots), 'no accidental global disallow');
  });

  it('lists exactly the canonical public URLs and no unrelated route', () => {
    const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    assert.deepStrictEqual(locations, publicMeta.map((meta) => canonicalUrl(meta.canonicalPath!)));
    assert.ok(!sitemap.includes('/app'));
    assert.match(sitemap, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  });

  it('dates each sitemap URL with its last meaningful content change', () => {
    const dates = [...sitemap.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((match) => match[1]);
    assert.deepStrictEqual(dates, ['2026-11-28', '2026-11-25', '2026-11-25']);
    dates.forEach((date) => {
      assert.match(date, /^\d{4}-\d{2}-\d{2}$/, date);
      assert.ok(new Date(`${date}T00:00:00Z`) <= new Date(), `${date} is not in the future`);
    });
    assert.strictEqual((sitemap.match(/<lastmod>/g) ?? []).length, 3, 'every URL carries a date');
  });

  it('omits optional hints Google ignores and keeps one well-formed urlset', () => {
    assert.ok(!/changefreq|priority/.test(sitemap), 'no placeholder hints');
    assert.strictEqual((sitemap.match(/<urlset/g) ?? []).length, 1);
    assert.strictEqual((sitemap.match(/<\/urlset>/g) ?? []).length, 1);
    assert.strictEqual((sitemap.match(/<url>/g) ?? []).length, (sitemap.match(/<\/url>/g) ?? []).length);
    assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  });

  it('sets noindex for the workspace and unknown routes at mount', () => {
    assert.match(main, /route === 'workspace' \|\| route === 'not-found'/);
    assert.match(main, /setAttribute\('content', 'noindex,nofollow'\)/);
    assert.match(main, /document\.title = WORKSPACE_TITLE/);
    assert.strictEqual(WORKSPACE_TITLE, 'Workspace — QueryMind');
    assert.strictEqual(NOT_FOUND_META.robots, 'noindex,nofollow');
    assert.strictEqual(NOT_FOUND_META.canonicalPath, null);
    publicMeta.forEach((meta) => assert.strictEqual(meta.robots, 'index,follow'));
  });

  it('gives the workspace and not-found documents their own static noindex heads', () => {
    assert.strictEqual(WORKSPACE_META.title, WORKSPACE_TITLE);
    assert.strictEqual(WORKSPACE_META.canonicalPath, null);
    [WORKSPACE_META, NOT_FOUND_META].forEach((meta) => {
      const block = renderSeoBlock(meta);
      assert.ok(block.includes(`<title>${meta.title}</title>`), meta.title);
      assert.ok(block.includes('<meta name="robots" content="noindex,nofollow" />'), meta.title);
      assert.ok(!/rel="canonical"/.test(block), `${meta.title} must not carry a canonical`);
      assert.ok(!/og:url|og:image|twitter:image/.test(block), `${meta.title} must not inherit the homepage social card`);
    });
  });
});

describe('Pre-render step', () => {
  it('emits every route document, with an empty root for the client-only workspace', () => {
    assert.match(pkg.scripts.build, /vite build && tsx scripts\/prerender\.tsx/);
    for (const file of ['index.html', 'privacy.html', 'contact.html', 'app.html', '404.html']) {
      assert.ok(prerender.includes(`file: '${file}'`), `${file} is emitted`);
    }
    assert.match(prerender, /file: 'app\.html', route: null, meta: WORKSPACE_META/);
    assert.match(prerender, /file: '404\.html', route: 'not-found', meta: NOT_FOUND_META/);
    assert.match(prerender, /renderToString\(<PublicSite route=\{route\} \/>\)/);
    assert.match(prerender, /renderSeoBlock\(meta\)/);
    assert.match(prerender, /HEAD_PATTERN/);
    assert.match(prerender, /ROOT_MARKER/);
  });

  it('keeps the client mount as createRoot, so pre-rendered markup cannot mismatch', () => {
    assert.match(main, /import \{ createRoot \} from 'react-dom\/client'/);
    assert.ok(!/hydrateRoot/.test(main));
  });
});

describe('Structured data — homepage only', () => {
  const scriptPattern = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/;

  function landingGraph(): any {
    const match = renderSeoBlock(LANDING_META).match(scriptPattern);
    assert.ok(match, 'the landing block must carry the JSON-LD');
    return JSON.parse(match ? match[1] : '');
  }

  it('is one parseable graph declaring WebSite and SoftwareApplication', () => {
    const block = renderSeoBlock(LANDING_META);
    assert.strictEqual((block.match(/application\/ld\+json/g) ?? []).length, 1);
    const data = landingGraph();
    assert.strictEqual(data['@context'], 'https://schema.org');
    assert.deepStrictEqual(
      data['@graph'].map((node: any) => node['@type']),
      ['WebSite', 'SoftwareApplication']
    );
  });

  it('keeps both entity URLs equal to the homepage canonical', () => {
    const data = landingGraph();
    const canonical = canonicalUrl('/');
    data['@graph'].forEach((node: any) => assert.strictEqual(node.url, canonical, node['@type']));
    const [website, software] = data['@graph'];
    assert.strictEqual(website['@id'], 'https://querymind.in/#website');
    assert.strictEqual(software['@id'], 'https://querymind.in/#software');
    assert.strictEqual(software.publisher, undefined, 'no publisher points at the WebSite entity');
  });

  it('describes only shipped capabilities', () => {
    const software = landingGraph()['@graph'][1];
    assert.strictEqual(software.name, 'QueryMind');
    assert.strictEqual(software.applicationCategory, 'BusinessApplication');
    assert.strictEqual(software.operatingSystem, 'Web browser');
    assert.ok(software.featureList.length >= 5);
    software.featureList.forEach((feature: unknown) => assert.strictEqual(typeof feature, 'string'));
  });

  it('makes no offer, price, rating or review claim', () => {
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value && typeof value === 'object') {
        Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
          keys.add(key);
          walk(child);
        });
      }
    };
    walk(landingGraph());
    ['offers', 'price', 'priceCurrency', 'isAccessibleForFree', 'aggregateRating', 'review', 'ratingValue'].forEach(
      (key) => assert.ok(!keys.has(key), `structured data must not carry ${key}`)
    );
  });

  it('is absent from every non-homepage document', () => {
    [PRIVACY_META, CONTACT_META, WORKSPACE_META, NOT_FOUND_META].forEach((meta) => {
      assert.ok(!renderSeoBlock(meta).includes('ld+json'), `${meta.title} must not carry JSON-LD`);
      assert.strictEqual(meta.structuredData, undefined, meta.title);
    });
  });

  it('stays synchronized with the committed index.html head', () => {
    assert.strictEqual((html.match(/application\/ld\+json/g) ?? []).length, 1);
    assert.strictEqual(flat(seoBlock), flat(renderSeoBlock(LANDING_META)));
  });
});
