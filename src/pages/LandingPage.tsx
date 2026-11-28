import React from 'react';
import {
  ArrowRight,
  ChevronDown,
  Database,
  KeyRound,
  ListChecks,
  ShieldCheck,
} from 'lucide-react';
import { usePageMeta } from '../hooks/usePageMeta';
import { LANDING_META } from '../services/siteMeta';

const PIPELINE = [
  ['01', 'Question', 'Your question, in plain English'],
  ['02', 'Plan', 'Provider semantic plan, when one is configured'],
  ['03', 'Validate', 'Deterministic SQL contract and sandbox checks'],
  ['04', 'Execute', 'DuckDB-WASM worker in this browser'],
  ['05', 'Result', 'Table, chart and summary computed from rows'],
] as const;

const BENEFITS = [
  {
    icon: ShieldCheck,
    title: 'Grounded in the executed result',
    body: 'Summary sentences are computed from the rows DuckDB returned. Provider prose is never treated as the answer.',
  },
  {
    icon: ListChecks,
    title: 'A validation contract before execution',
    body: 'Plans must pass structural SQL checks, a read-only allowlist and table isolation. Unsupported metrics are refused before a provider call.',
  },
  {
    icon: Database,
    title: 'Local execution by default',
    body: 'Queries run in a DuckDB-WASM worker inside your browser, bounded by a 15-second timeout and a 5,000-row result cap.',
  },
  {
    icon: KeyRound,
    title: 'Your key, your provider',
    body: 'Requests go directly from your browser to Gemini, Groq or OpenAI. There is no QueryMind server in the path, and a key stays in tab memory unless you opt in.',
  },
] as const;

const STEPS = [
  {
    number: 'STEP 01',
    title: 'Load a dataset',
    body: 'Choose a bundled sample or upload a CSV. Parsing happens in your browser and the data is loaded into an in-memory DuckDB-WASM database.',
  },
  {
    number: 'STEP 02',
    title: 'Ask an analytical question',
    body: 'With a provider configured, your question and structural column metadata are sent to that provider. Without a key, verified sample questions still run through the curated local path.',
  },
  {
    number: 'STEP 03',
    title: 'Inspect and export the results',
    body: 'Review the validated SQL, integrity checks, chart, table and evidence-based summary, then export the result table as CSV or JSON — generated locally in the browser.',
  },
] as const;

const FAQS = [
  {
    question: 'Do I need an account?',
    answer:
      'No. QueryMind has no sign-up, login or user accounts. The workspace opens directly in your browser.',
  },
  {
    question: 'Do I need an API key?',
    answer:
      'A key is required for arbitrary questions about your own dataset. The bundled sample datasets include verified sample questions that are answered by a curated local path without contacting a provider.',
  },
  {
    question: 'What happens to my CSV?',
    answer:
      'It is parsed in your browser and loaded into an in-memory DuckDB-WASM database. QueryMind operates no backend that could receive it, and dataset rows are not included in provider prompts.',
  },
  {
    question: 'What is sent to the AI provider?',
    answer:
      'Your question and structural schema metadata: column names, types, inferred roles, distinct counts, masked category labels and, for tables of at least ten rows, numeric ranges. Raw rows and result rows are not sent. Columns identified as PII have their values replaced with synthetic masks.',
  },
  {
    question: 'Which providers can I use?',
    answer:
      'Google Gemini, Groq and OpenAI. You choose one in Settings, paste your own key and test the connection before saving it.',
  },
  {
    question: 'Where does the SQL actually run?',
    answer:
      'In a DuckDB-WASM worker inside your browser. The provider proposes a query plan; QueryMind validates it and executes it locally, with a 15-second timeout and a 5,000-row cap.',
  },
  {
    question: 'Is my API key stored?',
    answer:
      'By default the key is kept in memory for the tab session and discarded when the tab closes. It is written to browser local storage only if you enable “Remember API key”.',
  },
  {
    question: 'Can I see what was sent to a provider?',
    answer:
      'Yes. The Telemetry Auditor records each provider dispatch the application makes in this session. It is an application-level record of those dispatches, not a full network monitor.',
  },
  {
    question: 'Does QueryMind work offline?',
    answer:
      'SQL execution and dataset parsing are local, but the application, its worker scripts and the DuckDB-WASM binaries are delivered over the network, and arbitrary questions need a provider connection. Local execution does not make the application offline-capable.',
  },
  {
    question: 'Where can I read more about privacy?',
    answer:
      'The privacy policy covers dataset handling, provider requests, browser storage and hosting infrastructure. The contact page lists the project’s verified public channels.',
  },
] as const;

const PipelinePanel: React.FC = () => (
  <figure className="rounded-xl border border-border-subtle bg-surface p-5 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle pb-3">
      <span className="section-label">Analysis path</span>
      <span className="inline-flex items-center gap-1.5 rounded-full border border-badge-success-border bg-badge-success-bg px-2.5 py-0.5 text-meta font-semibold text-badge-success-fg">
        <ShieldCheck className="h-3 w-3" aria-hidden="true" />
        Rows processed in the browser
      </span>
    </div>
    <ol className="mt-1 divide-y divide-border-subtle">
      {PIPELINE.map(([number, label, detail]) => (
        <li key={number} className="flex items-baseline gap-4 py-2.5">
          <span className="w-6 flex-shrink-0 font-mono text-meta text-text-muted">{number}</span>
          <span className="w-20 flex-shrink-0 text-xs font-semibold text-text-primary">{label}</span>
          <span className="text-prose text-text-muted">{detail}</span>
        </li>
      ))}
    </ol>
    <figcaption className="mt-4 border-t border-border-subtle pt-3 text-meta text-text-muted">
      A schematic of the pipeline, not a screenshot of a result.
    </figcaption>
  </figure>
);

export const LandingPage: React.FC = () => {
  usePageMeta(LANDING_META);

  return (
    <>
      <section
        aria-labelledby="hero-heading"
        className="mx-auto w-full max-w-6xl px-4 pb-14 pt-14 sm:px-6 sm:pb-20 sm:pt-20"
      >
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:items-center">
          <div>
            <p className="section-label">Browser-based conversational analytics</p>
            <h1
              id="hero-heading"
              className="mt-4 text-4xl font-semibold leading-[1.05] tracking-[-0.025em] text-text-primary sm:text-5xl"
            >
              Turn natural-language questions into SQL in your browser.
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-text-secondary sm:text-lg">
              QueryMind turns natural-language questions into analytical queries, interactive charts
              and structured insights, with SQL execution powered by DuckDB-WASM in your browser.
            </p>
            <div className="mt-8">
              <a
                href="/app"
                className="btn-accent-gradient focus-ring inline-flex items-center justify-center gap-2 px-5 py-3 text-sm"
              >
                Open QueryMind workspace
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </a>
            </div>
            <p className="mt-4 max-w-xl text-prose text-text-muted">
              Bring your dataset. Choose your AI provider. Keep analytical execution in your browser.
            </p>
          </div>
          <PipelinePanel />
        </div>
      </section>

      <section id="product" aria-labelledby="product-heading" className="border-t border-border-subtle">
        <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
          <p className="section-label">What you can rely on</p>
          <h2
            id="product-heading"
            className="mt-3 max-w-2xl text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl"
          >
            Answers you can inspect, on data you can keep in place.
          </h2>
          <p className="mt-3 max-w-2xl text-prose text-text-secondary">
            QueryMind separates the parts that guess from the parts that must be exact. The model
            plans; deterministic validation and a local engine decide what executes.
          </p>
          <div className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2">
            {BENEFITS.map(({ icon: Icon, title, body }) => (
              <div key={title} className="border-t border-border-strong pt-4">
                <Icon className="h-5 w-5 text-accent" aria-hidden="true" />
                <h3 className="mt-3 text-heading font-semibold text-text-primary">{title}</h3>
                <p className="mt-2 text-prose text-text-secondary">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        id="how-it-works"
        aria-labelledby="how-heading"
        className="border-t border-border-subtle bg-surface"
      >
        <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
          <p className="section-label">How it works</p>
          <h2
            id="how-heading"
            className="mt-3 max-w-2xl text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl"
          >
            From a CSV to a verified answer.
          </h2>
          <ol className="mt-10 grid gap-8 md:grid-cols-3">
            {STEPS.map((step) => (
              <li key={step.number} className="border-t border-border-strong pt-5">
                <span className="font-mono text-meta text-accent">{step.number}</span>
                <h3 className="mt-2 text-heading font-semibold text-text-primary">{step.title}</h3>
                <p className="mt-2 text-prose text-text-secondary">{step.body}</p>
              </li>
            ))}
          </ol>
          <p className="mt-10 max-w-3xl border-l-2 border-accent pl-4 text-prose text-text-secondary">
            SQL execution happens in a DuckDB-WASM worker in your browser. When you configure a
            provider, it acts as a semantic planner and never executes the query itself.
          </p>
        </div>
      </section>

      <section aria-labelledby="tagline-heading" className="border-t border-border-subtle">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
          <h2 id="tagline-heading" className="sr-only">
            How QueryMind divides the work
          </h2>
          <p className="mx-auto max-w-3xl text-center text-2xl font-medium leading-snug tracking-tight text-text-primary sm:text-3xl">
            Your questions guide the analysis.{' '}
            <span className="text-text-muted">Your browser executes the query.</span>
          </p>
        </div>
      </section>

      <section id="privacy" aria-labelledby="privacy-heading" className="border-t border-border-subtle bg-surface">
        <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div>
              <p className="section-label">Privacy and trust</p>
              <h2
                id="privacy-heading"
                className="mt-3 text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl"
              >
                Privacy is part of the architecture.
              </h2>
              <a
                href="/privacy"
                className="focus-ring mt-6 inline-flex items-center gap-1.5 rounded text-sm font-semibold text-accent underline underline-offset-4"
              >
                Read our privacy policy
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            </div>
            <ul className="space-y-3 text-prose text-text-secondary">
              {[
                'Dataset rows are parsed and queried in your browser. QueryMind operates no backend of its own.',
                'When a provider is configured, your question and relevant column metadata are sent to that provider — a separate recipient with its own retention terms.',
                'SQL runs locally on DuckDB-WASM. Result rows are not included in provider requests.',
                'Your API key stays in tab memory unless you explicitly enable “Remember API key”.',
                'The hosting platform may process request metadata independently of the application.',
              ].map((point) => (
                <li key={point} className="flex gap-3">
                  <span className="mt-[7px] h-1 w-1 flex-shrink-0 rounded-full bg-text-muted" aria-hidden="true" />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section id="faq" aria-labelledby="faq-heading" className="border-t border-border-subtle">
        <div className="mx-auto w-full max-w-3xl px-4 py-14 sm:px-6 sm:py-20">
          <p className="section-label">FAQ</p>
          <h2
            id="faq-heading"
            className="mt-3 text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl"
          >
            Questions before you begin.
          </h2>
          <div className="mt-8 divide-y divide-border-subtle border-t border-border-subtle">
            {FAQS.map(({ question, answer }) => (
              <details key={question} className="group py-4">
                <summary className="focus-ring flex cursor-pointer list-none items-center justify-between gap-4 rounded text-sm font-medium text-text-primary [&::-webkit-details-marker]:hidden">
                  {question}
                  <ChevronDown
                    className="h-4 w-4 flex-shrink-0 text-text-muted transition-transform duration-fast group-open:rotate-180"
                    aria-hidden="true"
                  />
                </summary>
                <p className="mt-3 text-prose text-text-secondary">{answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section aria-labelledby="cta-heading" className="border-t border-border-subtle">
        <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
          <div className="rounded-xl border border-border-subtle bg-surface p-6 sm:p-10">
            <h2
              id="cta-heading"
              className="text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl"
            >
              Ready to explore your data?
            </h2>
            <p className="mt-3 max-w-xl text-prose text-text-secondary">
              Start with a bundled sample dataset, or upload your own CSV inside the workspace. A
              provider key is only needed for arbitrary questions about your own data.
            </p>
            <a
              href="/app"
              className="btn-accent-gradient focus-ring mt-6 inline-flex items-center gap-2 px-5 py-3 text-sm"
            >
              Open QueryMind workspace
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
            <p className="mt-3 text-meta text-text-muted">No account. No QueryMind server.</p>
          </div>
        </div>
      </section>
    </>
  );
};
