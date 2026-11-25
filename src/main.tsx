import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { PublicSite } from './components/public/PublicSite';
import { resolvePublicRoute } from './services/publicRoutes';
import { WORKSPACE_TITLE } from './services/siteMeta';
import './index.css';

// The workspace keeps the behaviour it has always had; the public site is a separate mount so the
// landing page cannot start onboarding, dataset registration, the DuckDB worker or a provider call.
const route = resolvePublicRoute(window.location.pathname);

// Production serves /app and unknown paths with documents that already carry noindex; the
// runtime assignment keeps the Vite dev server (which answers every path with index.html) and
// any host fallback consistent with those documents.
if (route === 'workspace' || route === 'not-found') {
  document.querySelector('meta[name="robots"]')?.setAttribute('content', 'noindex,nofollow');
}
if (route === 'workspace') document.title = WORKSPACE_TITLE;

createRoot(document.getElementById('root')!).render(
  route === 'workspace' ? <App /> : <PublicSite route={route} />
);
