export type PublicRoute = 'landing' | 'workspace' | 'privacy' | 'contact' | 'not-found';

// The editor's workspace lives at /app so the public site can own /. Cloudflare Pages answers
// any unknown path with index.html, which is what makes these routes work without a router.
export const WORKSPACE_PATH = '/app';

export function resolvePublicRoute(pathname: string): PublicRoute {
  switch (pathname.replace(/\/+$/, '')) {
    case '':
    case '/':
      return 'landing';
    case WORKSPACE_PATH:
      return 'workspace';
    case '/privacy':
      return 'privacy';
    case '/contact':
      return 'contact';
    default:
      return 'not-found';
  }
}
