import React from 'react';
import { ArrowUpRight, KeyRound, Linkedin, Mail, ShieldAlert } from 'lucide-react';
import { usePageMeta } from '../hooks/usePageMeta';

const TITLE = 'Contact — QueryMind';
const DESCRIPTION = 'Verified public channels for QueryMind questions, bug reports and private security reports.';

const REPOSITORY = 'https://github.com/Shanksreddy005/query_main';
const EMAIL = 'shanksreddy005@gmail.com';
const LINKEDIN = 'https://www.linkedin.com/in/shashank-reddy-147227260';

const link = 'focus-ring rounded font-medium text-accent underline underline-offset-4';

export const ContactPage: React.FC = () => {
  usePageMeta(TITLE, DESCRIPTION);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
      <p className="section-label">Contact</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl">
        Contact QueryMind
      </h1>
      <p className="mt-4 text-sm leading-7 text-text-secondary">
        QueryMind is maintained as an open-source project. The repository and contact details below
        are the verified public channels for technical questions, bug reports and feature requests.
      </p>

      <div className="mt-10 grid gap-6 sm:grid-cols-2">
        <section aria-labelledby="repo-heading" className="rounded-xl border border-border-subtle bg-surface p-5">
          <h2 id="repo-heading" className="text-heading font-semibold text-text-primary">
            Project repository
          </h2>
          <p className="mt-2 text-prose text-text-secondary">
            Source, documentation and issue tracking for the application.
          </p>
          <a href={REPOSITORY} className={`${link} mt-3 inline-flex max-w-full items-start gap-1.5 break-all text-sm`} target="_blank" rel="noreferrer noopener">
            github.com/Shanksreddy005/query_main
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </section>

        <section aria-labelledby="security-heading" className="rounded-xl border border-border-subtle bg-surface p-5">
          <h2 id="security-heading" className="flex items-center gap-2 text-heading font-semibold text-text-primary">
            <ShieldAlert className="h-4 w-4 text-accent" aria-hidden="true" />
            Security reports
          </h2>
          <p className="mt-2 text-prose text-text-secondary">
            Report security issues privately to the repository owner. Please do not open a public
            issue that contains exploit details, API keys or dataset contents.
          </p>
        </section>
      </div>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <section aria-labelledby="email-heading" className="rounded-xl border border-border-subtle bg-surface p-5">
          <h2 id="email-heading" className="flex items-center gap-2 text-heading font-semibold text-text-primary">
            <Mail className="h-4 w-4 text-accent" aria-hidden="true" />
            Contact email
          </h2>
          <p className="mt-2 text-prose text-text-secondary">
            For general questions, bug reports and privacy enquiries.
          </p>
          <a href={`mailto:${EMAIL}`} className={`${link} mt-3 inline-block break-all text-sm`}>
            {EMAIL}
          </a>
        </section>

        <section aria-labelledby="linkedin-heading" className="rounded-xl border border-border-subtle bg-surface p-5">
          <h2 id="linkedin-heading" className="flex items-center gap-2 text-heading font-semibold text-text-primary">
            <Linkedin className="h-4 w-4 text-accent" aria-hidden="true" />
            LinkedIn
          </h2>
          <p className="mt-2 text-prose text-text-secondary">
            The maintainer’s professional profile.
          </p>
          <a
            href={LINKEDIN}
            className={`${link} mt-3 inline-flex max-w-full items-start gap-1.5 break-all text-sm`}
            target="_blank"
            rel="noreferrer noopener"
          >
            linkedin.com/in/shashank-reddy-147227260
            <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </section>
      </div>

      <section aria-labelledby="limits-heading" className="mt-10">
        <h2 id="limits-heading" className="flex items-center gap-2 text-heading font-semibold text-text-primary">
          <KeyRound className="h-4 w-4 text-accent" aria-hidden="true" />
          What not to send
        </h2>
        <p className="mt-2 text-sm leading-7 text-text-secondary">
          Do not send API keys, credentials, customer datasets, query results or other confidential
          material through any contact channel. The project has no support backend that accepts
          uploads, and no contact form is provided here.
        </p>
      </section>

      <p className="mt-10 border-t border-border-subtle pt-6 text-prose text-text-secondary">
        How the application handles data is described in the{' '}
        <a href="/privacy" className={link}>
          privacy policy
        </a>
        .
      </p>
    </div>
  );
};
