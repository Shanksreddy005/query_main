import { useEffect } from 'react';
import { canonicalUrl, type PageMeta } from '../services/siteMeta';

function setMeta(selector: string, content: string): void {
  const tag = document.querySelector(selector);
  if (tag) tag.setAttribute('content', content);
}

function setCanonical(href: string): void {
  const link = document.querySelector('link[rel="canonical"]');
  if (link) link.setAttribute('href', href);
}

/**
 * Public pages share one metadata module, so each route corrects the title, description, robots
 * directive, canonical URL and Open Graph URL after mount. The prerendered documents already
 * carry the same values in their own HTML. Only the public site calls this; the workspace keeps
 * its own static head and sets its noindex in main.tsx.
 */
export function usePageMeta(meta: PageMeta): void {
  useEffect(() => {
    document.title = meta.title;
    setMeta('meta[name="description"]', meta.description);
    setMeta('meta[name="robots"]', meta.robots);
    setMeta('meta[property="og:title"]', meta.title);
    setMeta('meta[property="og:description"]', meta.description);
    setMeta('meta[name="twitter:title"]', meta.title);
    setMeta('meta[name="twitter:description"]', meta.description);
    if (meta.canonicalPath !== null) {
      const href = canonicalUrl(meta.canonicalPath);
      setMeta('meta[property="og:url"]', href);
      setCanonical(href);
    }
  }, [meta]);
}
