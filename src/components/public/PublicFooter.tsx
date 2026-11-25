import React from 'react';

const footerLink = 'rounded text-prose text-text-secondary transition-colors duration-fast hover:text-text-primary focus-ring';

export const PublicFooter: React.FC = () => (
  <footer className="border-t border-border-subtle bg-background">
    <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-10 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-6">
      <div>
        <p className="text-[19px] leading-none tracking-tight text-text-primary">
          <span className="font-bold">Query</span>
          <span className="font-normal opacity-90">Mind</span>
        </p>
        <p className="mt-3 max-w-md text-prose text-text-secondary">
          Browser-native analytics: ask a question, validate the SQL, and execute it locally with
          DuckDB-WASM. Bring your own dataset and your own provider key.
        </p>
      </div>
      <nav aria-label="Footer">
        <ul className="flex flex-wrap gap-x-5 gap-y-2 sm:flex-col sm:items-end">
          <li>
            <a href="/privacy" className={footerLink}>
              Privacy policy
            </a>
          </li>
          <li>
            <a href="/contact" className={footerLink}>
              Contact
            </a>
          </li>
          <li>
            <a
              href="https://github.com/Shanksreddy005/query_main"
              className={footerLink}
              target="_blank"
              rel="noreferrer noopener"
            >
              GitHub repository
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </li>
        </ul>
      </nav>
    </div>
    <div className="border-t border-border-subtle">
      <div className="mx-auto w-full max-w-6xl px-4 py-4 text-meta text-text-muted sm:px-6">
        © {new Date().getFullYear()} QueryMind · an open-source, browser-native tool
      </div>
    </div>
  </footer>
);
