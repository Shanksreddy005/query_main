import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildStandaloneChartSvg,
  formatChartValue,
  DARK_CHART_EXPORT_THEME,
  LIGHT_CHART_EXPORT_THEME,
  ChartExportDatum,
  ChartExportRequest,
  ExportChartType,
} from '../src/services/chartSvgExport';

const PALETTE = ['#F59E0B', '#38BDF8', '#34D399', '#A78BFA'];
const DATA: ChartExportDatum[] = [
  { label: 'Enterprise', value: 97100 },
  { label: 'Professional', value: 19150 },
  { label: 'Starter', value: 1770 },
];
const TYPES: ExportChartType[] = ['horizontal_bar', 'bar', 'donut', 'line', 'area'];

function build(overrides: Partial<ChartExportRequest> = {}): string {
  const request: ChartExportRequest = {
    type: 'horizontal_bar',
    data: DATA,
    palette: PALETTE,
    theme: DARK_CHART_EXPORT_THEME,
    title: 'Avg MRR by Plan Tier',
    xLabel: 'Plan Tier',
    yLabel: 'Avg MRR',
    ...overrides,
  };
  return buildStandaloneChartSvg(request);
}

function count(needle: string, haystack: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Structural XML check: every start tag must have a matching end tag (or be self-closing),
 * in the correct nesting order. Proves the document opens standalone in any SVG viewer.
 */
function assertWellFormed(svg: string, label: string): void {
  const body = svg.replace(/^<\?xml[^?]*\?>\s*/, '');
  const tagPattern = /<(\/?)([A-Za-z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>'"])*?)(\/?)>/g;
  const stack: string[] = [];
  let match: RegExpExecArray | null;
  let tags = 0;

  while ((match = tagPattern.exec(body)) !== null) {
    tags += 1;
    const [, closing, name, attributes, selfClosing] = match;
    if (closing) {
      assert.strictEqual(stack.length > 0, true, `${label}: unexpected </${name}>`);
      const open = stack.pop() as string;
      assert.strictEqual(open, name, `${label}: </${name}> closes <${open}>`);
    } else if (!selfClosing) {
      stack.push(name);
    }
    assert.ok(
      !/(?:fill|stroke|width|height|x|y)="[^"]*[<>][^"]*"/.test(attributes),
      `${label}: unescaped angle bracket inside a <${name}> attribute value`
    );
  }

  assert.ok(tags > 5, `${label}: expected a populated document, saw ${tags} tags`);
  assert.strictEqual(stack.length, 0, `${label}: unclosed tags ${stack.join(', ')}`);
  assert.strictEqual(count('</svg>', body), 1, `${label}: exactly one svg root`);
}

describe('Chart SVG export — standalone documents for every chart type', () => {
  it('produces a well-formed standalone document with fixed intrinsic dimensions for all five types', () => {
    for (const type of TYPES) {
      const svg = build({ type });
      assert.ok(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), `${type}: XML declaration`);
      assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'), `${type}: svg namespace required for standalone viewing`);
      assert.ok(svg.includes('width="880" height="520"'), `${type}: intrinsic width/height`);
      assert.ok(svg.includes('viewBox="0 0 880 520"'), `${type}: viewBox`);
      assert.ok(!svg.includes('xlink:href'), `${type}: no external references`);
      assertWellFormed(svg, type);
    }
  });

  it('resolves every paint value to an explicit attribute — no currentColor, classes, CSS variables or style blocks', () => {
    for (const type of TYPES) {
      const svg = build({ type });
      assert.strictEqual(svg.includes('currentColor'), false, `${type}: currentColor resolves to nothing without app CSS`);
      assert.strictEqual(/class="/.test(svg), false, `${type}: Tailwind class names carry no styling into a standalone file`);
      assert.strictEqual(svg.includes('var(--'), false, `${type}: unresolved theme variable`);
      assert.strictEqual(svg.includes('<style'), false, `${type}: no embedded stylesheet required`);
      assert.strictEqual(/="opacity-|="text-|="w-full/.test(svg), false, `${type}: utility-class fragment leaked into attributes`);
    }
  });

  it('never exports a toolbar icon or unrelated interface element (production audit regression)', () => {
    for (const type of TYPES) {
      const svg = build({ type });
      const bytes = Buffer.byteLength(svg, 'utf8');
      assert.ok(bytes > 1000, `${type}: ${bytes} bytes is too small to be a chart (the shipped defect emitted a 316-byte icon)`);
      assert.strictEqual(svg.includes('lucide'), false, `${type}: lucide icon markup present`);
      assert.strictEqual(svg.includes('viewBox="0 0 24 24"'), false, `${type}: 24x24 icon geometry exported instead of the chart`);
    }
  });

  it('horizontal_bar: renders track + value bars, labels, values and share-of-shown annotations', () => {
    const svg = build({ type: 'horizontal_bar' });
    // 1 background + one track and one value rect per datum.
    assert.strictEqual(count('<rect', svg), 1 + DATA.length * 2, 'bar rectangles');
    DATA.forEach((d, i) => {
      assert.ok(svg.includes(d.label), `label ${d.label}`);
      assert.ok(svg.includes(formatChartValue(d.value)), `value ${d.value}`);
      assert.ok(svg.includes(PALETTE[i % PALETTE.length]), `palette color ${i}`);
    });
    assert.ok(svg.includes('82.3% of shown'), 'share of shown for the leading row');
    assert.strictEqual(svg.includes('Aggregated'), false, 'no aggregation badge unless the view aggregated');
    assert.ok(svg.includes('Avg MRR vs Plan Tier'), 'subtitle mirrors the on-screen header');
    assert.ok(svg.includes('>Plan Tier</text>') && svg.includes('>Avg MRR</text>'), 'axis titles');
  });

  it('carries the aggregation badge from the live header into the exported document', () => {
    const svg = build({ type: 'horizontal_bar', aggregated: true, aggregationMethod: 'avg' });
    assert.ok(svg.includes('Aggregated (AVG)'), 'badge text');
    const sum = build({ type: 'horizontal_bar', aggregated: true, aggregationMethod: 'sum' });
    assert.ok(sum.includes('Aggregated (SUM)'), 'sum badge text');
  });

  it('bar (vertical column): renders one column path per datum with value and category labels', () => {
    const svg = build({ type: 'bar' });
    assert.strictEqual(count('<path', svg), DATA.length, 'one column path per datum');
    DATA.forEach((d) => {
      assert.ok(svg.includes(d.label), `label ${d.label}`);
      assert.ok(svg.includes(formatChartValue(d.value)), `value ${d.value}`);
    });
    assert.ok(svg.includes('y1="428"'), 'baseline axis at plot bottom');
    assert.strictEqual(svg.includes('NaN'), false, 'no NaN geometry');
  });

  it('donut: renders arc segments plus a legend with percentages and the total', () => {
    const svg = build({ type: 'donut' });
    // 1 track circle + one segment per datum + one legend swatch per datum.
    assert.strictEqual(count('<circle', svg), 1 + DATA.length * 2, 'arc segments and legend swatches');
    assert.ok(svg.includes('>Total</text>'), 'center total label');
    assert.ok(svg.includes('118.0K'), 'formatted grand total');
    assert.ok(svg.includes('rotate(-90 290'), 'segments start at 12 o\'clock like the live chart');
    DATA.forEach((d, i) => {
      assert.ok(svg.includes(d.label), `legend label ${d.label}`);
      assert.ok(svg.includes(PALETTE[i % PALETTE.length]), `segment color ${i}`);
    });
    const circumference = 2 * Math.PI * 150;
    const arcs = [...svg.matchAll(/stroke-dasharray="([\d.]+) ([\d.]+)"/g)].map((m) => ({
      arc: Number(m[1]),
      full: Number(m[2]),
    }));
    assert.strictEqual(arcs.length, DATA.length, 'one arc per segment');
    arcs.forEach((a) => assert.ok(Math.abs(a.full - circumference) < 0.01, 'dasharray uses the full circumference'));
    const expectedShares = DATA.map((d) => d.value / 118020);
    arcs.forEach((a, i) => {
      const share = a.arc / a.full;
      assert.ok(Math.abs(share - expectedShares[i]) < 0.001, `segment ${i} arc ${share.toFixed(4)} matches ${(expectedShares[i] * 100).toFixed(1)}%`);
    });
    const covered = arcs.reduce((a, b) => a + b.arc, 0);
    assert.ok(Math.abs(covered - circumference) < 1, `segments tile the circle (covered ${covered.toFixed(2)} of ${circumference.toFixed(2)})`);
  });

  it('line and area: render the trend path, points and per-point values; area adds the filled path', () => {
    const line = build({ type: 'line' });
    const area = build({ type: 'area' });
    assert.strictEqual(count('<path', line), 1, 'line has exactly one stroke path');
    assert.strictEqual(count('<path', area), 2, 'area has fill + stroke paths');
    assert.ok(line.includes('fill="none" stroke="#F59E0B"'), 'accent stroke resolved to a literal hex');
    assert.ok(area.includes('fill-opacity="0.2"'), 'area fill matches the on-screen opacity');
    assert.strictEqual(count('<circle', line), DATA.length, 'one point per datum');
    DATA.forEach((d) => {
      assert.ok(line.includes(formatChartValue(d.value)), `point value ${d.value}`);
      assert.ok(line.includes(d.label), `point label ${d.label}`);
    });
  });

  it('escapes XML metacharacters in labels, values and titles', () => {
    const svg = build({
      type: 'horizontal_bar',
      title: 'Sales & "Margins" <Q3>',
      data: [{ label: 'East & "Core" <region>', value: 1234 }],
    });
    assert.ok(svg.includes('Sales &amp; &quot;Margins&quot; &lt;Q3&gt;'), 'title escaped');
    assert.ok(svg.includes('East &amp; &quot;Core&quot; &lt;region&gt;'), 'label escaped');
    assert.strictEqual(svg.includes('<region>'), false, 'raw angle brackets must not survive');
    assertWellFormed(svg, 'escaping');
  });

  it('survives negative, zero and non-finite values without emitting invalid geometry', () => {
    const svg = build({
      type: 'horizontal_bar',
      data: [
        { label: 'Loss', value: -4000 },
        { label: 'Zero', value: 0 },
        { label: 'Bad', value: Number.NaN },
        { label: 'Unbounded', value: Number.POSITIVE_INFINITY },
        { label: 'Good', value: 5000 },
      ],
    });
    assert.strictEqual(svg.includes('NaN'), false, 'no NaN in output');
    assert.strictEqual(svg.includes('Infinity'), false, 'no Infinity in output');
    assert.strictEqual(/width="-[\d.]+"/.test(svg), false, 'no negative rect widths');
    assertWellFormed(svg, 'degenerate values');
  });

  it('renders an empty dataset as a valid document rather than a broken one', () => {
    for (const type of TYPES) {
      const svg = build({ type, data: [] });
      assert.ok(svg.includes('No data points to render'), `${type}: empty state text`);
      assert.strictEqual(svg.includes('NaN'), false, `${type}: no NaN`);
      assertWellFormed(svg, `${type} empty`);
    }
  });

  it('honors the active theme: light and dark documents use the corresponding surface and accent tokens', () => {
    const dark = build({ type: 'line' });
    const light = build({ type: 'line', theme: LIGHT_CHART_EXPORT_THEME });
    assert.ok(dark.includes('#161412'), 'dark surface');
    assert.ok(light.includes('#FDFCFB'), 'light surface');
    assert.ok(dark.includes('stroke="#F59E0B"'), 'dark accent resolved into the trend stroke');
    assert.ok(light.includes('stroke="#D97706"'), 'light accent resolved into the trend stroke');
    assert.strictEqual(LIGHT_CHART_EXPORT_THEME.accent, '#D97706');
    assert.strictEqual(DARK_CHART_EXPORT_THEME.accent, '#F59E0B');
  });

  it('formatChartValue keeps the on-screen compact-number contract', () => {
    assert.strictEqual(formatChartValue(1_250_000), '1.3M');
    assert.strictEqual(formatChartValue(97100), '97.1K');
    assert.strictEqual(formatChartValue(42), '42');
    assert.strictEqual(formatChartValue(2.5), '2.5');
    assert.strictEqual(formatChartValue(-1500), '-1.5K');
  });

  it('writes real downloaded bytes: file on disk parses, matches the document and carries the chart dimensions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'querymind-svg-export-'));
    try {
      for (const type of TYPES) {
        const svg = build({ type });
        const file = join(dir, `querymind_chart_${type}.svg`);
        writeFileSync(file, svg, { encoding: 'utf8' });
        const onDisk = readFileSync(file, { encoding: 'utf8' });
        assert.strictEqual(onDisk, svg, `${type}: bytes written equal the generated document`);
        assert.ok(Buffer.byteLength(onDisk, 'utf8') > 1000, `${type}: file is a chart, not an icon`);
        assert.ok(onDisk.includes('viewBox="0 0 880 520"'), `${type}: dimensions preserved in the saved file`);
        for (const d of DATA) {
          assert.ok(onDisk.includes(d.label), `${type}: label ${d.label} present in saved file`);
        }
        assertWellFormed(onDisk, `${type} saved file`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
