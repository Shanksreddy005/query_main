import React from 'react';
import { ArrowRight } from 'lucide-react';
import { usePageMeta } from '../hooks/usePageMeta';

export const NotFoundPage: React.FC = () => {
  usePageMeta(
    'Page Not Found — QueryMind',
    'The requested page does not exist. Return to the QueryMind landing page or open the workspace.'
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-20 sm:px-6">
      <p className="section-label">404</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl">
        This page does not exist.
      </h1>
      <p className="mt-3 max-w-xl text-sm leading-7 text-text-secondary">
        The address may be mistyped, or the page may have moved. The landing page explains the
        product; the workspace is where datasets and questions live.
      </p>
      <div className="mt-8 flex flex-wrap items-center gap-5">
        <a href="/" className="focus-ring rounded text-sm font-medium text-text-primary underline underline-offset-4">
          Back to the landing page
        </a>
        <a
          href="/app"
          className="btn-accent-gradient focus-ring inline-flex items-center gap-2 px-4 py-2 text-sm"
        >
          Open QueryMind workspace
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </a>
      </div>
    </div>
  );
};
