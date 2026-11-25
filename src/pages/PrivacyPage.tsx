import React from 'react';
import { usePageMeta } from '../hooks/usePageMeta';
import { PRIVACY_META } from '../services/siteMeta';

const body = 'mt-3 text-sm leading-7 text-text-secondary';
const heading = 'mt-10 text-heading font-semibold text-text-primary';
const list = 'mt-3 list-disc space-y-2 pl-5 text-sm leading-7 text-text-secondary';
const code = 'rounded bg-surface-secondary px-1 py-0.5 font-mono text-[0.8em] text-text-primary';

export const PrivacyPage: React.FC = () => {
  usePageMeta(PRIVACY_META);

  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
      <p className="section-label">Privacy</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl">
        Privacy policy
      </h1>
      <p className="mt-3 text-prose text-text-muted">Last updated: 25 November 2026</p>
      <p className="mt-6 text-sm leading-7 text-text-secondary">
        This page describes the technical behaviour implemented in the QueryMind application and its
        documented hosting setup. It is a transparency document, not legal advice, and it is not a
        certification of compliance with any particular regulation.
      </p>

      <h2 className={heading}>1. Scope of this policy</h2>
      <p className={body}>
        This policy covers the public pages at this domain and the QueryMind workspace they open. It
        describes the categories of information the application processes, where that processing
        happens, what can leave the browser, and which parties are involved. Statements about the
        hosting layer reflect what was measured during release verification; hosting configuration
        is controlled by the site operator and the hosting provider, not by application code.
      </p>
      <p className={body}>
        QueryMind is independently operated by an individual based in India. It is not currently
        operated by a separately incorporated company, and no registered business name is claimed.
        The public contact and privacy email is{' '}
        <a href="mailto:shanksreddy005@gmail.com" className="focus-ring rounded font-medium text-accent underline underline-offset-4">
          shanksreddy005@gmail.com
        </a>
        ; it is monitored for general contact and privacy-related enquiries. The operating
        jurisdiction is India. No Data Protection Officer has been appointed, and no such
        appointment is claimed; the email above is the channel for privacy questions and requests.
      </p>
      <p className={body}>
        India’s Digital Personal Data Protection framework is being brought into force in stages.
        This policy describes the technical practices implemented in the application and the
        hosting setup observed during verification; it does not assert that every statutory
        obligation has commenced or that the project meets every provision that may apply. Wording
        that describes statutory obligations has not been reviewed by an India-qualified privacy
        lawyer and should be reviewed before it is relied on.
      </p>

      <h2 className={heading}>2. Information QueryMind processes</h2>
      <ul className={list}>
        <li>
          <strong className="text-text-primary">Dataset content</strong> you choose to load — CSV,
          TSV or JSON text, column names, values and the query results produced from them.
        </li>
        <li>
          <strong className="text-text-primary">Questions you type</strong> in the workspace.
        </li>
        <li>
          <strong className="text-text-primary">Provider configuration</strong> — the provider you
          select, the model name, and the API key you enter.
        </li>
        <li>
          <strong className="text-text-primary">Browser preferences</strong> — your theme choice and
          any saved query blueprints stored in this browser.
        </li>
        <li>
          <strong className="text-text-primary">Technical request data</strong> processed by the
          hosting platform when it serves the site, described in section 8.
        </li>
      </ul>

      <h2 className={heading}>3. Dataset processing and local execution</h2>
      <p className={body}>
        CSV and TSV files are parsed with PapaParse in the page; JSON files are read with the
        browser FileReader API and parsed with JSON.parse. The parsed dataset is registered with a
        DuckDB-WASM database running in a Web Worker in the same browser tab. Queries are validated
        and executed there, and results are held in page memory.
      </p>
      <p className={body}>
        QueryMind does not operate an application backend, database or upload endpoint. Apart from
        requests to the provider you configure (section 4), the application's own network requests
        are limited to loading its static assets (HTML, script, styles and self-hosted fonts), loading
        its worker scripts from the same origin, and fetching the two large DuckDB-WASM binaries from
        the operator-owned asset domain <span className={code}>assets.querymind.in</span>. Dataset
        rows are not uploaded to QueryMind, and no QueryMind server exists that could store them.
      </p>

      <h2 className={heading}>4. Requests to AI providers</h2>
      <p className={body}>
        A provider is contacted only when you have configured a provider key and ask a question that
        requires planning. The request is sent directly from your browser to the provider endpoint you
        selected — Google Gemini, Groq or OpenAI — using your key. The request carries your question
        and structural schema metadata derived from the dataset: the table name (derived from the
        uploaded file name), total row count, column names, data types, inferred column roles,
        distinct-value counts, synthetic category labels in place of the real categorical values,
        and — only for tables of at least ten rows — numeric ranges. For smaller tables those ranges
        are withheld. For columns whose names identify them as PII, no values or ranges are included,
        only the distinct count. Error text is redacted before any diagnostic follow-up is sent:
        quoted cell values are replaced with a placeholder so dataset values do not travel in error
        messages.
      </p>
      <p className={body}>
        Raw dataset rows and result rows are not included in provider prompts. The provider is a
        separate recipient that determines its own retention, logging and training practices under
        its own terms; QueryMind cannot control or guarantee provider-side retention. If no key is
        configured, verified sample questions on the bundled datasets are answered by a curated local
        path and no provider is contacted; arbitrary questions are refused with guidance instead of
        being sent anywhere.
      </p>

      <h2 className={heading}>5. API keys and credential handling</h2>
      <p className={body}>
        Keys are handled in the browser. By default a key is held in memory for the tab session and
        discarded when the tab closes. It is written to browser local storage only when you explicitly
        enable “Remember API key”; disabling that option removes any stored key immediately. Keys are
        sent only to the provider you chose, in an HTTP header on the request your browser makes.
        Because the application has no backend, keys are never transmitted to QueryMind’s authors.
      </p>
      <p className={body}>
        Browser storage is not a secure enclave. Anyone with access to your unlocked browser profile,
        or a malicious browser extension with the relevant permissions, may be able to read a key you
        chose to remember. Use a restricted provider key and avoid remembering keys on shared devices.
      </p>

      <h2 className={heading}>6. Browser storage and preferences</h2>
      <p className={body}>
        The application uses local storage under these keys, and no others, for the purposes shown:
      </p>
      <ul className={list}>
        <li>
          <span className={code}>querymind_byok_config</span> — your provider configuration, written
          only when “Remember API key” is enabled.
        </li>
        <li>
          <span className={code}>query_mind_local_library</span> — saved query blueprints.
        </li>
        <li>
          <span className={code}>query_mind_library_seeded</span> — a marker recording that the
          starter blueprints were seeded.
        </li>
        <li>
          <span className={code}>query_mind_theme_preference</span> — your light, dark or system
          theme choice.
        </li>
      </ul>
      <p className={body}>
        Clearing this site’s data in your browser removes these values. The application does not use
        cookies for accounts or tracking.
      </p>

      <h2 className={heading}>7. Exports and downloads</h2>
      <p className={body}>
        CSV, JSON and SVG chart exports are generated in the browser from the result already in
        memory, using a Blob and a temporary object URL. Each file is handed to your browser’s
        download mechanism. No export is uploaded to QueryMind or to a provider.
      </p>

      <h2 className={heading}>8. Hosting, CDN and infrastructure</h2>
      <p className={body}>
        The site is served through Cloudflare Pages, and the DuckDB-WASM binaries are served from
        Cloudflare R2 at <span className={code}>assets.querymind.in</span>. As with any hosted site,
        the platform processes request metadata — such as IP address, user agent, requested URL and
        timing — in order to deliver the response and operate its network. Cloudflare responses have
        also been observed carrying <span className={code}>NEL</span> and{' '}
        <span className={code}>Report-To</span> headers, which allow a browser to report failed
        connections to Cloudflare.
      </p>
      <p className={body}>
        During release verification, one browser capture of the deployed HTML included an
        edge-injected Cloudflare analytics script, while cache-bypassing captures that followed did
        not. That difference is a hosting-layer behaviour outside the application’s source; the site
        operator controls those settings. QueryMind’s own code includes no analytics, error-reporting
        or advertising service.
      </p>

      <h2 className={heading}>9. Third-party services</h2>
      <p className={body}>
        The third parties involved are the AI provider you choose (only when you configure one), the
        hosting and asset-delivery platform described above, and GitHub if you follow the repository
        link in the footer. Fonts and DuckDB worker scripts are self-hosted, not loaded from a
        third-party CDN. The application contains no third-party analytics, session-recording,
        error-telemetry or advertising integration.
      </p>

      <h2 className={heading}>10. Retention and deletion</h2>
      <ul className={list}>
        <li>
          Dataset content, questions and results live in tab memory and are released when the tab is
          closed or reloaded, except for a question you explicitly save as a blueprint (section 6).
        </li>
        <li>
          Remembered keys and saved blueprints persist in local storage until you clear them in the
          application or clear this site’s browser data.
        </li>
        <li>
          Provider-side retention is governed by the provider’s terms and is outside QueryMind’s
          control.
        </li>
        <li>
          Hosting-layer logs and network metadata are retained according to the hosting provider’s
          policies.
        </li>
        <li>
          QueryMind has no server-side store of user data, so there is no QueryMind-side account or
          dataset record to delete.
        </li>
      </ul>

      <h2 className={heading}>11. Security practices and limitations</h2>
      <p className={body}>
        The site is delivered over HTTPS. SQL is parsed and validated against a read-only allowlist,
        table isolation and single-statement rules before execution, and execution is bounded by a
        15-second timeout and a 5,000-row materialization cap. The DuckDB engine runs inside a
        WebAssembly worker in the browser sandbox.
      </p>
      <p className={body}>
        QueryMind is a client-side tool. It cannot protect data from a compromised device, a
        malicious browser extension or someone using an unlocked browser profile, and it is not
        certified under SOC 2, HIPAA or any comparable scheme. Do not load data you are not permitted
        to process.
      </p>

      <h2 className={heading}>12. Children’s privacy</h2>
      <p className={body}>
        QueryMind is an analytical tool intended for professional use and is not directed at
        children. It has no accounts and knowingly collects no information from children. Datasets
        are supplied by the person using the browser.
      </p>

      <h2 className={heading}>13. Changes to this policy</h2>
      <p className={body}>
        This page is versioned with the application source. Material changes to data handling will be
        reflected here and in the repository history, with the date above updated.
      </p>

      <h2 className={heading}>14. Contact</h2>
      <p className={body}>
        Privacy and data-processing enquiries can be sent to{' '}
        <a
          href="mailto:shanksreddy005@gmail.com"
          className="focus-ring rounded font-medium text-accent underline underline-offset-4"
        >
          shanksreddy005@gmail.com
        </a>
        , the monitored channel also listed on the{' '}
        <a href="/contact" className="focus-ring rounded font-medium text-accent underline underline-offset-4">
          contact page
        </a>
        . General questions and bug reports can use the same address. This is not a Data Protection
        Officer contact, because no DPO has been appointed. Security issues should be reported
        privately to the repository owner rather than in a public issue.
      </p>
    </article>
  );
};
