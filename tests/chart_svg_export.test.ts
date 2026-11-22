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

/**
 * WCAG 1.4.3 arithmetic, re-implemented here on purpose: if the exporter and the test shared one
 * contrast function, a wrong implementation would pass its own test.
 */
const srgbChannel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16) / 255;
const toLinear = (channel: number) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
const relativeLuminance = (hex: string) =>
  0.2126 * toLinear(srgbChannel(hex, 1)) + 0.7152 * toLinear(srgbChannel(hex, 3)) + 0.0722 * toLinear(srgbChannel(hex, 5));
const contrast = (foreground: string, background: string) => {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
const composite = (foreground: string, background: string, alpha: number) =>
  `#${[1, 3, 5]
    .map((at) =>
      Math.round(alpha * parseInt(foreground.slice(at, at + 2), 16) + (1 - alpha) * parseInt(background.slice(at, at + 2), 16))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;

/**
 * The ramps DataChart actually hands to the exporter, read out of the component so this suite can
 * never drift from the colours that ship.
 */
function livePalettes(): { light: string[]; dark: string[] } {
  const source = readFileSync('src/components/DataChart.tsx', 'utf-8');
  const grab = (name: string): string[] => {
    const block = source.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`, 's'));
    assert.ok(block, `${name} is no longer a literal array in DataChart.tsx`);
    const colors = [...block[1].matchAll(/'(#[0-9A-Fa-f]{6})'/g)].map((m) => m[1]);
    assert.strictEqual(colors.length, 8, `${name}: expected 8 categorical colors`);
    return colors;
  };
  return { light: grab('LIGHT_PALETTE'), dark: grab('DARK_PALETTE') };
}

/** Pairs each translucent value bar with the 13px/600 label the export draws on top of it. */
function insideBarLabels(svg: string): { barColor: string; alpha: number; fill: string; text: string }[] {
  const found: { barColor: string; alpha: number; fill: string; text: string }[] = [];
  for (const group of svg.split('<g>').slice(1)) {
    const bar = group.match(/<rect x="112" y="[\d.]+" width="([\d.]+)" height="[\d.]+" rx="[\d.]+" fill="(#[0-9A-Fa-f]{6})" fill-opacity="([\d.]+)" \/>/);
    const label = group.match(/font-size="13" font-weight="600" fill="(#[0-9A-Fa-f]{6})">([^<]*)<\/text>/);
    if (bar && label && Number(bar[1]) > 120) {
      found.push({ barColor: bar[2], alpha: Number(bar[3]), fill: label[1], text: label[2] });
    }
  }
  return found;
}

describe('Chart SVG export — inside-bar value labels are legible on the painted fill', () => {
  const PALETTES = livePalettes();
  // equal values => every bar spans the plot => every label takes the inside branch
  const eight = PALETTES.light.map((_, i) => ({ label: `Segment ${i + 1}`, value: 1000 }));

  function exportDoc(theme: typeof LIGHT_CHART_EXPORT_THEME, palette: string[]) {
    return build({ type: 'horizontal_bar', theme, palette, data: eight });
  }

  it('measures AA against the composited bar, not the palette stop', () => {
    for (const [name, theme, palette] of [
      ['light', LIGHT_CHART_EXPORT_THEME, PALETTES.light],
      ['dark', DARK_CHART_EXPORT_THEME, PALETTES.dark],
    ] as const) {
      const labels = insideBarLabels(exportDoc(theme, palette));
      assert.strictEqual(labels.length, 8, `${name}: every categorical stop exercised through the inside branch`);
      for (const label of labels) {
        const painted = composite(label.barColor, theme.surfaceSecondary, label.alpha);
        assert.strictEqual(label.alpha, 0.85, `${name}: the bar is still painted at 0.85`);
        assert.ok(
          contrast(label.fill, painted) >= 4.5,
          `${name}: label ${label.fill} on ${label.barColor}@${label.alpha} over ${theme.surfaceSecondary} (painted ${painted}) is ${contrast(label.fill, painted).toFixed(2)}:1, below 4.5:1`
        );
      }
    }
  });

  it('keeps the light ramp on the theme text colours wherever one of them is already compliant', () => {
    const labels = insideBarLabels(exportDoc(LIGHT_CHART_EXPORT_THEME, PALETTES.light));
    const theme = LIGHT_CHART_EXPORT_THEME;
    labels.forEach((label, i) => {
      const painted = composite(label.barColor, theme.surfaceSecondary, label.alpha);
      const themeBest = Math.max(contrast(theme.textPrimary, painted), contrast(theme.surface, painted));
      const expected = themeBest >= 4.5 ? (contrast(theme.textPrimary, painted) >= contrast(theme.surface, painted) ? theme.textPrimary : theme.surface) : '#000000';
      assert.strictEqual(label.fill, expected, `light stop ${PALETTES.light[i]}: black is only used when no theme colour clears AA`);
    });
    assert.ok(labels.some((l) => l.fill === '#000000'), 'at least one mid-tone hue needs the black fallback');
    assert.ok(labels.filter((l) => l.fill === '#000000').length <= 2, 'the fallback stays an exception, not the rule');
  });

  it('leaves dark-theme documents byte-identical in label paint', () => {
    const labels = insideBarLabels(exportDoc(DARK_CHART_EXPORT_THEME, PALETTES.dark));
    assert.strictEqual(labels.length, 8);
    for (const label of labels) {
      assert.strictEqual(label.fill, DARK_CHART_EXPORT_THEME.surface, 'dark inside labels stay on the near-black surface ink');
    }
  });

  it('keeps the short-bar branch legible against the track it sits on', () => {
    for (const theme of [LIGHT_CHART_EXPORT_THEME, DARK_CHART_EXPORT_THEME]) {
      const svg = build({
        type: 'horizontal_bar',
        theme,
        palette: PALETTES.light,
        data: [{ label: 'Big', value: 1000 }, { label: 'Tiny', value: 8 }],
      });
      const outside = [...svg.matchAll(/text-anchor="start" font-family="'JetBrains Mono'[^"]*" font-size="13" font-weight="600" fill="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]);
      assert.strictEqual(outside.length, 1, 'the short bar labels outside the fill');
      for (const fill of outside) {
        assert.ok(
          contrast(fill, theme.surfaceSecondary) >= 4.5,
          `outside label ${fill} on the ${theme.surfaceSecondary} track is ${contrast(fill, theme.surfaceSecondary).toFixed(2)}:1`
        );
      }
    }
  });

  it('introduces no paint value outside the export theme, the palette and the black fallback', () => {
    for (const [name, theme, palette] of [
      ['light', LIGHT_CHART_EXPORT_THEME, PALETTES.light],
      ['dark', DARK_CHART_EXPORT_THEME, PALETTES.dark],
    ] as const) {
      const svg = exportDoc(theme, palette);
      const allowed = new Set([...Object.values(theme), ...palette, '#000000']);
      const used = [...new Set([...svg.matchAll(/(?:fill|stroke)="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]))];
      const unexpected = used.filter((c) => !allowed.has(c));
      assert.deepStrictEqual(unexpected, [], `${name}: unexpected colors ${unexpected.join(', ')}`);
      for (const color of palette) {
        assert.ok(svg.includes(`fill="${color}" fill-opacity="0.85"`), `${name}: ${color} still painted as the categorical bar, unaltered`);
      }
      assert.ok(svg.includes('viewBox="0 0 880 520"'), `${name}: dimensions preserved`);
      assert.ok(svg.includes('font-size="13"'), `${name}: label typography preserved`);
    }
  });

  it('does not touch the four chart types that never place a label inside a bar', () => {
    for (const type of ['bar', 'donut', 'line', 'area'] as const) {
      const svg = build({ type, theme: LIGHT_CHART_EXPORT_THEME, palette: PALETTES.light, data: eight });
      assert.strictEqual(insideBarLabels(svg).length, 0, `${type}: no inside-bar label exists`);
    }
    const columns = build({ type: 'bar', theme: LIGHT_CHART_EXPORT_THEME, palette: PALETTES.light, data: eight });
    assert.strictEqual(
      count(`font-size="12" font-weight="600" fill="${LIGHT_CHART_EXPORT_THEME.textSecondary}"`, columns),
      8,
      'column value labels stay above the bar in textSecondary'
    );
    assert.ok(
      contrast(LIGHT_CHART_EXPORT_THEME.textSecondary, LIGHT_CHART_EXPORT_THEME.surface) >= 4.5,
      'and that pairing is compliant over the plot background'
    );
  });

  it('keeps the R1 muted-text correction compliant on both export surfaces', () => {
    const pairs = [
      ['light', LIGHT_CHART_EXPORT_THEME, '#6E6760'],
      ['dark', DARK_CHART_EXPORT_THEME, '#9C948A'],
    ] as const;
    for (const [name, theme, expected] of pairs) {
      assert.strictEqual(theme.textMuted, expected, `${name}: muted label token`);
      for (const surface of [theme.surface, theme.surfaceSecondary]) {
        assert.ok(
          contrast(theme.textMuted, surface) >= 4.5,
          `${name}: ${theme.textMuted} on ${surface} is ${contrast(theme.textMuted, surface).toFixed(2)}:1`
        );
      }
    }
  });
});

/**
 * Pairs each trend marker with the 12px/600 value label drawn 14px above it. The label sits on the
 * bare document surface: in `area` documents the translucent fill is bounded above by the line
 * itself, so nothing is painted behind a label positioned above its point.
 */
function trendPointLabels(svg: string): {
  cx: number; cy: number; dotFill: string; dotStroke: string;
  labelX: number; labelY: number; fill: string; text: string;
  categorySize: number; categoryFill: string;
}[] {
  const found: ReturnType<typeof trendPointLabels> = [];
  for (const group of svg.split('<g>').slice(1)) {
    const circle = group.match(/<circle cx="([\d.]+)" cy="([\d.]+)" r="4.5" fill="(#[0-9A-Fa-f]{6})" stroke="(#[0-9A-Fa-f]{6})" stroke-width="2.5" \/>/);
    const value = group.match(/<text x="([\d.]+)" y="([\d.]+)" text-anchor="middle" font-family="'JetBrains Mono'[^"]*" font-size="12" font-weight="600" fill="(#[0-9A-Fa-f]{6})">([^<]*)<\/text>/);
    const category = group.match(/<text x="[\d.]+" y="[\d.]+" text-anchor="middle" font-family="'Inter'[^"]*" font-size="(\d+)" fill="(#[0-9A-Fa-f]{6})">([^<]*)<\/text>/);
    if (!circle || !value || !category) continue;
    found.push({
      cx: Number(circle[1]),
      cy: Number(circle[2]),
      dotFill: circle[3],
      dotStroke: circle[4],
      labelX: Number(value[1]),
      labelY: Number(value[2]),
      fill: value[3],
      text: value[4],
      categorySize: Number(category[1]),
      categoryFill: category[2],
    });
  }
  return found;
}

describe('Chart SVG export — trend point labels are legible on the plot surface', () => {
  const PALETTES = livePalettes();
  const TREND_DATA = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'].map((label, i) => ({
    label,
    value: [120, 260, 90, 340, 210, 150][i],
  }));

  function exportTrend(theme: typeof LIGHT_CHART_EXPORT_THEME, type: 'line' | 'area', palette = PALETTES.light) {
    return build({ type, theme, palette, data: TREND_DATA });
  }

  it('clears AA for every line and area point label in both themes, measured from the emitted SVG', () => {
    for (const [name, theme] of [
      ['light', LIGHT_CHART_EXPORT_THEME],
      ['dark', DARK_CHART_EXPORT_THEME],
    ] as const) {
      for (const type of ['line', 'area'] as const) {
        const labels = trendPointLabels(exportTrend(theme, type));
        assert.strictEqual(labels.length, TREND_DATA.length, `${name} ${type}: every point carries a value label`);
        assert.deepStrictEqual(
          labels.map((l) => l.text),
          TREND_DATA.map((d) => formatChartValue(d.value)),
          `${name} ${type}: labels still show the formatted values`
        );
        for (const label of labels) {
          const ratio = contrast(label.fill, theme.surface);
          assert.ok(
            ratio >= 4.5,
            `${name} ${type}: point label ${label.fill} on ${theme.surface} is ${ratio.toFixed(2)}:1, below 4.5:1`
          );
        }
      }
    }
  });

  it('replaces the light accent ink that fails AA and keeps the replacement inside the theme', () => {
    const theme = LIGHT_CHART_EXPORT_THEME;
    assert.ok(
      contrast(theme.accent, theme.surface) < 4.5,
      `light accent ${theme.accent} on ${theme.surface} is ${contrast(theme.accent, theme.surface).toFixed(2)}:1, the paint this fix removes`
    );
    for (const type of ['line', 'area'] as const) {
      for (const label of trendPointLabels(exportTrend(theme, type))) {
        assert.strictEqual(label.fill, theme.textPrimary, `light ${type}: label paint is the theme ink`);
        assert.notStrictEqual(label.fill, theme.accent, `light ${type}: the failing accent is not re-emitted`);
      }
    }
  });

  it('leaves the dark accent labels in place because they already clear AA', () => {
    const theme = DARK_CHART_EXPORT_THEME;
    for (const type of ['line', 'area'] as const) {
      const labels = trendPointLabels(exportTrend(theme, type, PALETTES.dark));
      assert.strictEqual(labels.length, TREND_DATA.length);
      for (const label of labels) {
        assert.strictEqual(label.fill, theme.accent, `dark ${type}: existing accent paint preserved`);
        assert.ok(
          contrast(label.fill, theme.surface) >= 4.5,
          `dark ${type}: preserved accent measures ${contrast(label.fill, theme.surface).toFixed(2)}:1`
        );
      }
    }
  });

  it('leaves geometry, marker colour, label placement and typography unchanged', () => {
    for (const type of ['line', 'area'] as const) {
      const light = trendPointLabels(exportTrend(LIGHT_CHART_EXPORT_THEME, type));
      const dark = trendPointLabels(exportTrend(DARK_CHART_EXPORT_THEME, type, PALETTES.dark));
      assert.deepStrictEqual(
        light.map((l) => [l.cx, l.cy, l.labelX, l.labelY]),
        dark.map((l) => [l.cx, l.cy, l.labelX, l.labelY]),
        `${type}: geometry and label positions are independent of the ink change`
      );
      for (const theme of [LIGHT_CHART_EXPORT_THEME, DARK_CHART_EXPORT_THEME]) {
        const labels = trendPointLabels(exportTrend(theme, type, theme === LIGHT_CHART_EXPORT_THEME ? PALETTES.light : PALETTES.dark));
        for (const label of labels) {
          assert.strictEqual(label.dotStroke, theme.accent, `${type}: series marker stroke unchanged`);
          assert.strictEqual(label.dotFill, theme.surface, `${type}: marker interior unchanged`);
          assert.ok(Math.abs(label.labelY - (label.cy - 14)) <= 0.05, `${type}: label still 14px above the point`);
          assert.strictEqual(label.labelX, label.cx, `${type}: label still centred on the point`);
          assert.strictEqual(label.categorySize, 12, `${type}: category label size unchanged`);
          assert.strictEqual(label.categoryFill, theme.textPrimary, `${type}: category label paint unchanged`);
        }
        const svg = exportTrend(theme, type, theme === LIGHT_CHART_EXPORT_THEME ? PALETTES.light : PALETTES.dark);
        assert.ok(svg.includes(`stroke="${theme.accent}" stroke-width="3"`), `${type}: line stroke unchanged`);
        assert.strictEqual(svg.includes(`fill="${theme.accent}" fill-opacity="0.2"`), type === 'area', `${type}: area fill only in area documents`);
        assert.ok(svg.includes('viewBox="0 0 880 520"'), `${type}: dimensions preserved`);
        assert.ok(svg.includes(`<rect x="0" y="0" width="880" height="520" fill="${theme.surface}" />`), `${type}: document background unchanged`);
      }
    }
  });
});
