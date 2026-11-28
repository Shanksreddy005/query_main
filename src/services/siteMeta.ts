export type PublicMetaRoute = 'landing' | 'privacy' | 'contact';

export type MetaRobots = 'index,follow' | 'noindex,nofollow';

type JsonLdValue = string | number | boolean | JsonLdValue[] | { [key: string]: JsonLdValue };

export interface PageMeta {
  title: string;
  description: string;
  /** Absolute path appended to SITE_ORIGIN for the canonical URL; null asserts none. */
  canonicalPath: '/' | '/privacy' | '/contact' | null;
  robots: MetaRobots;
  /** Structured data rendered into the document head; only the landing page carries one. */
  structuredData?: JsonLdValue;
}

export const SITE_ORIGIN = 'https://querymind.in';

// The social card is a committed build asset (public/og). Both the dimensions and the URL are
// pinned here so the document head, the preview image and the tests cannot drift apart.
export const SOCIAL_IMAGE_PATH = '/og/querymind-social-preview.png';
export const SOCIAL_IMAGE_URL = `${SITE_ORIGIN}${SOCIAL_IMAGE_PATH}`;
export const SOCIAL_IMAGE_WIDTH = 1200;
export const SOCIAL_IMAGE_HEIGHT = 630;
export const SOCIAL_IMAGE_ALT = 'QueryMind — Browser-Based Natural Language to SQL';

// Facts only: every feature below ships in the application, and there is deliberately no offer,
// price, rating or review property, so the markup stays an entity description rather than a claim.
export const LANDING_STRUCTURED_DATA: JsonLdValue = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': 'https://querymind.in/#website',
      url: 'https://querymind.in/',
      name: 'QueryMind',
    },
    {
      '@type': 'SoftwareApplication',
      '@id': 'https://querymind.in/#software',
      name: 'QueryMind',
      url: 'https://querymind.in/',
      description:
        'Browser-based natural-language analytics: ask questions about a dataset in plain English, get validated SQL, and execute it locally with DuckDB-WASM.',
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web browser',
      featureList: [
        'Natural-language questions to validated SQL',
        'Local SQL execution with DuckDB-WASM',
        'CSV upload and in-browser parsing',
        'Interactive charts and evidence-grounded summaries',
        'Bring-your-own-key configuration for Gemini, Groq and OpenAI',
      ],
    },
  ],
};

export const LANDING_META: PageMeta = {
  title: 'QueryMind | Browser-Based Natural Language to SQL',
  description:
    'Ask questions about your data in plain English. QueryMind turns natural language into SQL and runs the analysis locally in your browser with DuckDB-WASM.',
  canonicalPath: '/',
  robots: 'index,follow',
  structuredData: LANDING_STRUCTURED_DATA,
};

export const PRIVACY_META: PageMeta = {
  title: 'Privacy Policy — QueryMind',
  description:
    'How QueryMind handles datasets, AI-provider requests, API keys, browser storage, exports and hosting infrastructure.',
  canonicalPath: '/privacy',
  robots: 'index,follow',
};

export const CONTACT_META: PageMeta = {
  title: 'Contact — QueryMind',
  description:
    'Verified public channels for QueryMind questions, bug reports and private security reports.',
  canonicalPath: '/contact',
  robots: 'index,follow',
};

export const NOT_FOUND_META: PageMeta = {
  title: 'Page Not Found — QueryMind',
  description:
    'The requested page does not exist. Return to the QueryMind landing page or open the workspace.',
  canonicalPath: null,
  robots: 'noindex,nofollow',
};

export const WORKSPACE_TITLE = 'Workspace — QueryMind';

export const WORKSPACE_META: PageMeta = {
  title: WORKSPACE_TITLE,
  description:
    "QueryMind's browser-based analysis workspace. This page is excluded from search indexing.",
  canonicalPath: null,
  robots: 'noindex,nofollow',
};

export const PUBLIC_PAGE_META: Record<PublicMetaRoute, PageMeta> = {
  landing: LANDING_META,
  privacy: PRIVACY_META,
  contact: CONTACT_META,
};

export function canonicalUrl(path: NonNullable<PageMeta['canonicalPath']>): string {
  return `${SITE_ORIGIN}${path}`;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function tag(name: string, content: string, attribute = 'name'): string {
  return `  <meta ${attribute}="${name}" content="${escapeAttribute(content)}" />`;
}

/**
 * The single source of every document head. index.html commits the landing block between the
 * seo markers; scripts/prerender.tsx swaps it for the route's block when it emits the other
 * documents. A null canonical marks a non-indexable document: it gets only the directives a
 * crawler needs, and never inherits the homepage canonical or the shareable social card.
 */
export function renderSeoBlock(meta: PageMeta): string {
  const canonical = meta.canonicalPath === null ? null : canonicalUrl(meta.canonicalPath);
  const lines = [
    '  <!-- seo:start -->',
    `  <title>${escapeAttribute(meta.title)}</title>`,
    tag('description', meta.description),
    tag('robots', meta.robots),
  ];
  if (!canonical) {
    lines.push('  <!-- seo:end -->');
    return lines.join('\n');
  }
  lines.push(`  <link rel="canonical" href="${escapeAttribute(canonical)}" />`);
  lines.push(
    '  <meta property="og:type" content="website" />',
    '  <meta property="og:site_name" content="QueryMind" />',
    tag('og:title', meta.title, 'property'),
    tag('og:description', meta.description, 'property')
  );
  if (canonical) lines.push(`  <meta property="og:url" content="${escapeAttribute(canonical)}" />`);
  lines.push(
    tag('og:image', SOCIAL_IMAGE_URL, 'property'),
    `  <meta property="og:image:width" content="${SOCIAL_IMAGE_WIDTH}" />`,
    `  <meta property="og:image:height" content="${SOCIAL_IMAGE_HEIGHT}" />`,
    tag('og:image:alt', SOCIAL_IMAGE_ALT, 'property'),
    '  <meta name="twitter:card" content="summary_large_image" />',
    tag('twitter:title', meta.title),
    tag('twitter:description', meta.description),
    tag('twitter:image', SOCIAL_IMAGE_URL)
  );
  if (meta.structuredData) {
    // `<` is escaped so the payload can never close the script element early.
    const json = JSON.stringify(meta.structuredData, null, 2).replace(/</g, '\\u003c');
    lines.push('  <script type="application/ld+json">', json, '  </script>');
  }
  lines.push('  <!-- seo:end -->');
  return lines.join('\n');
}
