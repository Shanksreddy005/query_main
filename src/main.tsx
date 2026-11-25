import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { PublicSite } from './components/public/PublicSite';
import { resolvePublicRoute } from './services/publicRoutes';
import './index.css';

// The workspace keeps the behaviour it has always had; the public site is a separate mount so the
// landing page cannot start onboarding, dataset registration, the DuckDB worker or a provider call.
const route = resolvePublicRoute(window.location.pathname);

// The workspace is useful only with local data and configuration, and a missing page should not be
// indexed; the static document cannot vary its own head, so the signal is set at mount time.
if (route === 'workspace' || route === 'not-found') {
  document.querySelector('meta[name="robots"]')?.setAttribute('content', 'noindex,nofollow');
}

createRoot(document.getElementById('root')!).render(
  route === 'workspace' ? <App /> : <PublicSite route={route} />
);
