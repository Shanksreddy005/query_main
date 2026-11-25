import { useEffect } from 'react';

function setMeta(selector: string, content: string): void {
  const tag = document.querySelector(selector);
  if (tag) tag.setAttribute('content', content);
}

/**
 * Public pages share one static document head, so each route corrects the title and description
 * after mount. Only the public site calls this; the workspace keeps the document defaults.
 */
export function usePageMeta(title: string, description: string): void {
  useEffect(() => {
    document.title = title;
    setMeta('meta[name="description"]', description);
    setMeta('meta[property="og:title"]', title);
    setMeta('meta[property="og:description"]', description);
  }, [title, description]);
}
