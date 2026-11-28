import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { resolvePublicRoute } from '../src/services/publicRoutes';

// The public site is additive: it must explain the product and its privacy posture before the
// workspace can ask for anything, and it must never mount the workspace to do it. These checks pin
// the route table, the published copy, the privacy page's factual claims and the isolation from the
// analytics engine. The existing workspace contracts live in their own test files.

const read = (path: string) => fs.readFileSync(path, 'utf-8');
const flat = (text: string) => text.replace(/\s+/g, ' ');

const landing = read('src/pages/LandingPage.tsx');
const privacy = read('src/pages/PrivacyPage.tsx');
const contact = read('src/pages/ContactPage.tsx');
const notFound = read('src/pages/NotFoundPage.tsx');
const site = read('src/components/public/PublicSite.tsx');
const nav = read('src/components/public/PublicNav.tsx');
const footer = read('src/components/public/PublicFooter.tsx');
const main = read('src/main.tsx');
const header = read('src/components/Header.tsx');
const app = read('src/App.tsx');
const html = read('index.html');
const robots = read('public/robots.txt');
const sitemap = read('public/sitemap.xml');
const pkg = JSON.parse(read('package.json'));
const publicSources = [landing, privacy, contact, notFound, site, nav, footer].join('\n');

const REPOSITORY = 'https://github.com/Shanksreddy005/query_main';
const EMAIL = 'shanksreddy005@gmail.com';
const LINKEDIN = 'https://www.linkedin.com/in/shashank-reddy-147227260';

describe('Public routes', () => {
  it('maps the four public paths and tolerates a trailing slash', () => {
    assert.strictEqual(resolvePublicRoute('/'), 'landing');
    assert.strictEqual(resolvePublicRoute(''), 'landing');
    assert.strictEqual(resolvePublicRoute('/app'), 'workspace');
    assert.strictEqual(resolvePublicRoute('/app/'), 'workspace');
    assert.strictEqual(resolvePublicRoute('/privacy'), 'privacy');
    assert.strictEqual(resolvePublicRoute('/privacy/'), 'privacy');
    assert.strictEqual(resolvePublicRoute('/contact'), 'contact');
    assert.strictEqual(resolvePublicRoute('/contact/'), 'contact');
  });

  it('does not guess: unknown or nested paths are a not-found route', () => {
    assert.strictEqual(resolvePublicRoute('/workspace'), 'not-found');
    assert.strictEqual(resolvePublicRoute('/Privacy'), 'not-found');
    assert.strictEqual(resolvePublicRoute('/app/query'), 'not-found');
    assert.strictEqual(resolvePublicRoute('/privacy/extra'), 'not-found');
  });

  it('mounts the workspace only on /app, so public pages cannot start it', () => {
    assert.match(main, /resolvePublicRoute\(window\.location\.pathname\)/);
    assert.match(main, /route === 'workspace' \? <App \/> : <PublicSite route=\{route\} \/>/);
    assert.ok(!/from '\.\/App\.tsx'/.test(site), 'the public shell must not import the workspace');
    assert.ok(!/aiService|sqlEngine|keyStorage|OnboardingModal/.test(publicSources));
    assert.ok(!/fetch\(/.test(publicSources), 'no public page may issue its own request');
  });
});

describe('Landing page — the required copy survives edits', () => {
  const text = flat(landing);

  it('states the accepted headline, subheadline and supporting line', () => {
    assert.ok(text.includes('Browser-based conversational analytics'));
    assert.ok(text.includes('Turn natural-language questions into SQL in your browser.'));
    assert.ok(
      text.includes(
        'QueryMind turns natural-language questions into analytical queries, interactive charts and structured insights, with SQL execution powered by DuckDB-WASM in your browser.'
      )
    );
    assert.ok(
      text.includes(
        'Bring your dataset. Choose your AI provider. Keep analytical execution in your browser.'
      )
    );
  });

  it('keeps the tagline section static and exact', () => {
    assert.ok(text.includes('Your questions guide the analysis.'));
    assert.ok(text.includes('Your browser executes the query.'));
    assert.ok(!/animate-|useEffect/.test(landing.slice(landing.indexOf('tagline-heading'))));
  });

  it('offers exactly one primary action: open the existing workspace', () => {
    const accentLinks = landing.match(/<a[^>]*btn-accent-gradient[^>]*>/g) ?? [];
    assert.ok(accentLinks.length >= 2, 'hero and closing band both carry the primary action');
    accentLinks.forEach((tag) => assert.match(tag, /href="\/app"/, 'no competing primary destination'));
    assert.strictEqual(landing.split('Open QueryMind workspace').length - 1, 2);
    assert.match(nav, /href="\/app"[\s\S]*?Open workspace/);
  });

  it('ships the promised sections with one h1 each', () => {
    ['id="product"', 'id="how-it-works"', 'id="privacy"', 'id="faq"'].forEach((id) =>
      assert.ok(landing.includes(id), `missing ${id}`)
    );
    assert.strictEqual(landing.split('<h1').length - 1, 1);
    assert.ok(landing.split('<h2').length - 1 >= 5, 'benefits, steps, tagline, privacy, FAQ and CTA are headed');
    assert.match(landing, /id="tagline-heading" className="sr-only"/);
  });

  it('describes the provider role without giving it execution authority', () => {
    assert.ok(text.includes('it acts as a semantic planner and never executes the query itself'));
    assert.ok(text.includes('Raw rows and result rows are not sent.'));
  });

  it('renders a labelled schematic instead of an invented screenshot', () => {
    assert.match(landing, /<figure className="rounded-xl border border-border-subtle bg-surface/);
    assert.ok(text.includes('A schematic of the pipeline, not a screenshot of a result.'));
    assert.ok(!/\.png|\.jpg|\.webp/.test(landing), 'no image asset is claimed to exist');
  });
});

describe('Public navigation and footer', () => {
  it('labels both navigation landmarks and keeps them keyboard reachable', () => {
    assert.match(nav, /<nav aria-label="Primary"/);
    assert.match(nav, /<nav aria-label="Primary \(compact\)"/);
    assert.match(footer, /<nav aria-label="Footer"/);
    assert.match(nav, /focus-ring/);
    assert.match(footer, /focus-ring/);
    assert.match(nav, /min-h-6/, 'compact navigation links meet the 24px target minimum');
  });

  it('links only to real destinations', () => {
    const hrefs = [...publicSources.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    const allowed = new Set([
      '/',
      '/app',
      '/privacy',
      '/contact',
      '#main-content',
      '#product',
      '#how-it-works',
      REPOSITORY,
      LINKEDIN,
      `mailto:${EMAIL}`,
    ]);
    hrefs.forEach((href) => assert.ok(allowed.has(href), `${href} is not a verified destination`));
    assert.ok(!/href="#"/.test(publicSources), 'a dead link is worse than no link');
  });

  it('marks the current page on the privacy and contact links', () => {
    assert.match(nav, /aria-current=\{route === 'privacy' \? 'page' : undefined\}/);
    assert.match(nav, /aria-current=\{route === 'contact' \? 'page' : undefined\}/);
  });

  it('gives the footer a dynamic year and the verified repository', () => {
    assert.match(footer, /new Date\(\)\.getFullYear\(\)/);
    assert.ok(footer.includes(REPOSITORY));
    assert.match(footer, /href="\/privacy"/);
    assert.match(footer, /href="\/contact"/);
    assert.ok(!/Inc\.|LLC|Ltd\.|registered office/i.test(footer), 'no invented legal entity');
  });

  it('offers exactly two theme buttons and keeps one theme owner', () => {
    assert.match(site, /useTheme\(\)/);
    assert.ok(!/documentElement\.classList/.test(publicSources), 'only the theme service writes the class');
    assert.match(nav, /aria-label="Light theme"/);
    assert.match(nav, /aria-label="Dark theme"/);
    assert.match(nav, /aria-pressed=\{!isDarkMode\}/);
    assert.match(nav, /aria-pressed=\{isDarkMode\}/);
    assert.ok(!/Monitor|System default/.test(nav), 'the three-state system control is gone');
    assert.ok(!/\bdark:[a-z-]/.test(publicSources), 'no OS-driven dark: variants');
  });
});

describe('Privacy page — factual disclosure, not reassurance', () => {
  const text = flat(privacy);

  it('carries all fourteen required sections', () => {
    [
      '1. Scope of this policy',
      '2. Information QueryMind processes',
      '3. Dataset processing and local execution',
      '4. Requests to AI providers',
      '5. API keys and credential handling',
      '6. Browser storage and preferences',
      '7. Exports and downloads',
      '8. Hosting, CDN and infrastructure',
      '9. Third-party services',
      '10. Retention and deletion',
      '11. Security practices and limitations',
      '12. Children’s privacy',
      '13. Changes to this policy',
      '14. Contact',
    ].forEach((heading) => assert.ok(text.includes(heading), `missing section: ${heading}`));
  });

  it('names the storage keys the source actually uses', () => {
    ['querymind_byok_config', 'query_mind_local_library', 'query_mind_library_seeded', 'query_mind_theme_preference'].forEach(
      (key) => assert.ok(text.includes(key), `policy must name ${key}`)
    );
    assert.ok(text.includes('does not use cookies'));
  });

  it('states what does and does not reach a provider', () => {
    assert.ok(text.includes('Google Gemini, Groq or OpenAI'));
    assert.ok(text.includes('Raw dataset rows and result rows are not included in provider prompts.'));
    assert.ok(text.includes('cannot control or guarantee provider-side retention'));
    assert.ok(text.includes('redacted'));
  });

  it('describes the prompt fields and parsing paths the source actually uses', () => {
    assert.ok(text.includes('synthetic category labels in place of the real categorical values'));
    assert.ok(text.includes('table name (derived from the uploaded file name)'));
    assert.ok(text.includes('total row count'));
    assert.ok(text.includes('JSON files are read with the browser FileReader API'));
    assert.ok(text.includes('in an HTTP header'));
    assert.ok(text.includes('CSV, JSON and SVG chart exports'));
    assert.ok(text.includes('no values or ranges are included, only the distinct count'));
  });

  it('separates the hosting layer from the application', () => {
    assert.ok(text.includes('Cloudflare Pages'));
    assert.ok(text.includes('NEL'));
    assert.ok(text.includes('Report-To'));
    assert.ok(text.includes('edge-injected Cloudflare analytics script'));
    assert.ok(text.includes('no analytics, error-reporting or advertising service'));
  });

  it('describes the security boundary without certification claims', () => {
    assert.ok(text.includes('15-second timeout'));
    assert.ok(text.includes('5,000-row'));
    assert.ok(text.includes('not certified under SOC 2, HIPAA'));
    assert.ok(text.includes('not legal advice'));
  });

  it('records the owner-confirmed operator, jurisdiction and privacy channel', () => {
    assert.ok(text.includes('independently operated by an individual based in India'));
    assert.ok(text.includes('not currently operated by a separately incorporated company'));
    assert.ok(text.includes('monitored for general contact and privacy-related enquiries'));
    assert.ok(text.includes('operating jurisdiction is India'));
    assert.ok(text.includes('No Data Protection Officer has been appointed'));
    assert.ok(text.includes('Privacy and data-processing enquiries'));
    assert.ok(text.includes('is not a Data Protection Officer contact'), 'no DPO channel is implied');
    assert.ok(text.includes('Digital Personal Data Protection framework is being brought into force in stages'));
    assert.ok(text.includes('India-qualified privacy lawyer'), 'the legal-review flag is present');
    assert.ok(!/Pvt\.? Ltd|Private Limited|\bLLC\b|\bInc\./.test(privacy), 'no invented company');
    assert.ok(!/registered office|street address|corporate office/i.test(privacy), 'no invented address');
    assert.ok(!/\bDPO:\s|Data Protection Officer at\b/.test(privacy), 'no DPO appointment is implied');
  });

  it('never states an absolute the implementation cannot prove', () => {
    const forbidden = [
      /100% private/i,
      /zero data transmission/i,
      /data never leaves your device/i,
      /no third-party processing/i,
      /fully offline/i,
    ];
    forbidden.forEach((pattern) => assert.ok(!pattern.test(publicSources), `forbidden claim: ${pattern}`));
  });
});

describe('Contact page — verified public channels', () => {
  const text = flat(contact);

  it('links the verified repository and keeps security reports private', () => {
    assert.ok(contact.includes(REPOSITORY));
    assert.ok(text.includes('Report security issues privately to the repository owner'));
  });

  it('links the owner-supplied email and LinkedIn profile without a form', () => {
    assert.ok(contact.includes(`const EMAIL = '${EMAIL}'`));
    assert.ok(contact.includes('href={`mailto:${EMAIL}`}'));
    assert.ok(contact.includes(`const LINKEDIN = '${LINKEDIN}'`));
    assert.ok(contact.includes('href={LINKEDIN}'));
    assert.match(contact, /target="_blank"[\s\S]{0,120}rel="noreferrer noopener"/);
    assert.ok(!/<form|<input|action=/.test(contact), 'no form is added');
    assert.ok(!text.includes('A monitored contact email has not been published'));
  });

  it('warns against sending credentials or datasets', () => {
    assert.ok(text.includes('Do not send API keys, credentials, customer datasets'));
  });
});

describe('Metadata, indexing and dependencies', () => {
  it('publishes the reviewed title and description', () => {
    assert.ok(html.includes('<title>QueryMind | Browser-Based Natural Language to SQL</title>'));
    assert.ok(
      html.includes(
        'Ask questions about your data in plain English. QueryMind turns natural language into SQL and runs the analysis locally in your browser with DuckDB-WASM.'
      )
    );
    assert.match(html, /<meta name="robots" content="index,follow" \/>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/querymind\.in\/" \/>/);
    assert.match(
      html,
      /<meta property="og:image" content="https:\/\/querymind\.in\/og\/querymind-social-preview\.png" \/>/
    );
    assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
  });

  it('keeps the workspace out of the index and lists only public pages', () => {
    assert.match(robots, /Disallow: \/app/);
    assert.match(robots, /Sitemap: https:\/\/querymind\.in\/sitemap\.xml/);
    assert.match(main, /route === 'workspace' \|\| route === 'not-found'/);
    assert.match(main, /setAttribute\('content', 'noindex,nofollow'\)/);
    const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    assert.deepStrictEqual(locations, [
      'https://querymind.in/',
      'https://querymind.in/privacy',
      'https://querymind.in/contact',
    ]);
    assert.ok(!sitemap.includes('/app'));
  });

  it('introduces no router, analytics or telemetry dependency', () => {
    const deps = Object.keys(pkg.dependencies ?? {});
    ['react-router', 'react-router-dom', 'next', 'gsap', '@gsap/react'].forEach((name) =>
      assert.ok(!deps.includes(name), `${name} is not an approved dependency`)
    );
    assert.ok(!/cloudflareinsights|googletagmanager|gtag\(|plausible|fathom/.test(publicSources + html));
  });

  it('keeps the existing workspace reachable and unchanged at its core', () => {
    assert.match(header, /<a href="\/" aria-label="QueryMind home"/);
    assert.match(app, /aria-busy=\{isRunning\}/);
    assert.match(app, /PREBUILT_DATASETS\.saas\.dataset/);
  });
});

describe('Accessibility contracts on the public site', () => {
  it('provides a skip link and a single main landmark', () => {
    assert.match(site, /href="#main-content"/);
    assert.match(site, /<main id="main-content" tabIndex=\{-1\} className="flex-1">/);
    assert.match(site, /Skip to content/);
  });

  it('uses native disclosure for the FAQ and hides decorative icons', () => {
    assert.match(landing, /<details key=\{question\} className="group py-4">/);
    assert.match(landing, /<summary className="focus-ring/);
    assert.match(landing, /aria-hidden="true"/);
    assert.ok(!/aria-expanded=/.test(landing), 'the native details element owns the state');
  });

  it('keeps each page to one top-level heading', () => {
    [privacy, contact, notFound].forEach((page) => {
      assert.strictEqual(page.split('<h1').length - 1, 1);
    });
  });
});
