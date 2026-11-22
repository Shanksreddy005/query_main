import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { resolveBriefingSummary } from '../src/components/ExecutiveBriefing';

// Phase 5 put the results screen in order: the finding first, the evidence next, the technical
// detail on demand. Two things had to survive that: one owner for every repeated string, and a
// presentation layer that only ever shows what the verified result actually contains. These tests
// hold both shut — the ordering and disclosure contracts in the source, and the real behaviour of
// the summary resolver that the answer band and the briefing share.

const view = fs.readFileSync('src/components/ResultsView.tsx', 'utf-8');
const briefing = fs.readFileSync('src/components/ExecutiveBriefing.tsx', 'utf-8');
const header = fs.readFileSync('src/components/Header.tsx', 'utf-8');
const logo = fs.readFileSync('src/components/QueryMindLogo.tsx', 'utf-8');
const app = fs.readFileSync('src/App.tsx', 'utf-8');

describe('Results hierarchy — one answer, then evidence, then technical detail', () => {
  it('orders the panels answer, chart, table, briefing, SQL, trace', () => {
    const order = [
      'Answer Band',
      'Interactive Data Visualization',
      'Query Results Data Table',
      'Executive Analytical Briefing',
      'Generated SQL Panel',
      'Execution & Validation Details',
    ].map((marker) => [marker, view.indexOf(marker)] as const);

    order.forEach(([marker, idx]) => assert.ok(idx > -1, `missing ${marker}`));
    for (let i = 1; i < order.length; i += 1) {
      assert.ok(order[i - 1][1] < order[i][1], `${order[i - 1][0]} must precede ${order[i][0]}`);
    }
  });

  it('keeps the technical panels behind an accessible disclosure', () => {
    assert.match(view, /const \[isSqlExpanded, setIsSqlExpanded\] = useState<boolean>\(false\)/);
    assert.match(view, /aria-expanded=\{isSqlExpanded\}/);
    assert.match(view, /\{isSqlExpanded && \(/, 'the code surface must only mount when opened');
    assert.match(view, /aria-expanded=\{isTraceExpanded\}/);
  });

  it('renders the verified scalar values in the answer band for a single aggregate row', () => {
    assert.match(view, /const singleMetricRow = React\.useMemo\(/);
    assert.match(view, /if \(\(result\.rows\?\.length \?\? 0\) !== 1\) return null;/);
    assert.match(view, /cols\.length > 4\) return null;/, 'wide single rows stay a table, not a metric strip');
    assert.match(view, /singleMetricRow \? \(/);
  });

  it('does not chart a single data point', () => {
    assert.match(view, /const chartableRows = hasRows && \(result\.rows\?\.length \?\? 0\) > 1;/);
    assert.match(view, /isChartOpen && activeChartSuggestion && chartableRows/);
    assert.match(view, /Boolean\(result\.chartSuggestion\) && \(result\.rows\?\.length \?\? 0\) > 1/);
  });

  it('suppresses the table controls that cannot act on one row', () => {
    const density = view.indexOf("onClick={() => setTableDensity(");
    assert.ok(density > -1);
    assert.match(view.slice(density - 220, density), /result\.rows\.length > 1 && \(/);
    assert.match(view, /result\.rows\.length > 1 && \(\s*<div className="relative min-w-0 w-full sm:w-48">/);
  });
});

describe('Results hierarchy — repeated strings have one owner', () => {
  it('shares the summary sentence between the answer band and the briefing', () => {
    assert.match(briefing, /export function resolveBriefingSummary/);
    assert.match(view, /import \{ ExecutiveBriefing, resolveBriefingSummary \} from '.\/ExecutiveBriefing';/);
    assert.match(view, /if \(result\.insight\) return resolveBriefingSummary\(result\.insight\);/);
    assert.match(view, /hideSummary=\{Boolean\(answerSummary\) && !singleMetricRow\}/);
    assert.match(briefing, /\{!hideSummary && \(/);
  });

  it('states the check count once, in the facts row rather than the status badge', () => {
    assert.ok(!/Query Matches Request/.test(view), 'the badge must not carry the count');
    assert.match(view, /\{result\.passedChecks\.length\} integrity checks/);
    assert.ok(!/\{result\.passedChecks\.length\} checks/.test(view), 'the trace header must not repeat it');
  });

  it('keeps exactly one save control per result', () => {
    const uses = view.split('onClick={handleToggleSave}').length - 1;
    assert.strictEqual(uses, 1, 'save is offered once, in the answer band');
    assert.ok(!/Save Blueprint/.test(view));
  });

  it('reports the row count once per context', () => {
    assert.match(
      view,
      /Showing \{paginatedRows\.length\} of \{result\.rowCount\.toLocaleString\(\)\} row\{result\.rowCount === 1 \? '' : 's'\}/
    );
    const factsRow = view.slice(
      view.indexOf('!isDiagnosticStatus && result.sql &&'),
      view.indexOf("renderFeedback('answer'")
    );
    assert.ok(!/rowCount/.test(factsRow), 'the facts row must not duplicate the table count');
  });

  it('names the SQL provenance once', () => {
    assert.strictEqual(view.split('no provider reply passed validation').length - 1, 1);
    assert.match(view, /usedBlueprintFallback && \(/);
  });
});

describe('Results hierarchy — the summary resolver never invents a finding', () => {
  it('prefers overview, then executive summary, then the legacy summary field', () => {
    assert.strictEqual(resolveBriefingSummary({ overview: 'A', executive_summary: 'B', summary: 'C' }), 'A');
    assert.strictEqual(resolveBriefingSummary({ executive_summary: 'B', summary: 'C' }), 'B');
    assert.strictEqual(resolveBriefingSummary({ summary: 'C' }), 'C');
  });

  it('falls back to a neutral line for empty or boilerplate text', () => {
    const fallback = resolveBriefingSummary({});
    assert.strictEqual(fallback, 'Analytical query execution verified against local dataset.');
    assert.strictEqual(resolveBriefingSummary({ summary: '   ' }), fallback);
    assert.strictEqual(resolveBriefingSummary({ overview: 'Audit downstream data pipelines.' }), fallback);
    assert.strictEqual(
      resolveBriefingSummary({ overview: 'North America holds 41% of MRR.' }),
      'North America holds 41% of MRR.'
    );
  });
});

describe('Responsive workspace contracts', () => {
  it('lets the header clusters shrink instead of widening the page', () => {
    assert.match(header, /className="flex items-center gap-3 sm:gap-4 min-w-0"/);
    assert.match(header, /gap-1\.5 sm:gap-2 min-w-0 flex-shrink-0/);
    assert.match(header, /hidden md:flex items-center gap-1\.5 px-2\.5 py-1 rounded-lg/);
    assert.match(header, /aria-label="Telemetry auditor/);
    assert.match(header, /<span className="hidden lg:inline">DATA LOCAL<\/span>/);
    assert.match(header, /hidden lg:inline text-meta tabular-nums/);
  });

  it('gives the wordmark a way to yield in narrow headers', () => {
    assert.match(logo, /wordmarkClassName\?: string;/);
    assert.match(logo, /text-\[19px\] tracking-tight leading-none \$\{wordmarkClassName\}/);
    assert.match(header, /wordmarkClassName="hidden sm:inline-block"/);
  });

  it('keeps the byok control identified without its label', () => {
    assert.match(header, /aria-label=\{\s*\n\s*hasKey/);
    assert.match(header, /className="font-mono text-meta hidden sm:inline"/);
  });

  it('wraps the table toolbar and widens the workspace only on large screens', () => {
    assert.match(view, /className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between"/);
    assert.match(view, /<div className="flex flex-wrap items-center gap-2 min-w-0 xl:justify-end">/);
    assert.match(app, /max-w-5xl xl:max-w-6xl/);
  });

  it('de-nests the briefing into hairline sections instead of boxed cards', () => {
    assert.match(briefing, /className="p-4 sm:p-5 space-y-4"/);
    assert.match(briefing, /space-y-2 pt-3 border-t border-border-subtle\/60/);
    assert.ok(!/bg-surface\/40 border p-3\.5 rounded-lg/.test(briefing), 'no nested boxes inside the briefing');
  });
});
