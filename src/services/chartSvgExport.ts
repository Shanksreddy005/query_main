export type ExportChartType = 'horizontal_bar' | 'bar' | 'donut' | 'line' | 'area';

export interface ChartExportDatum {
  label: string;
  value: number;
}

/**
 * Explicit color tokens for exported documents. On-screen charts inherit these from CSS
 * custom properties and Tailwind utilities, which do not exist inside a standalone .svg file,
 * so the export must resolve them to literal hex values (see src/index.css light/dark blocks).
 */
export interface ChartExportTheme {
  surface: string;
  surfaceSecondary: string;
  borderStrong: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
}

export const LIGHT_CHART_EXPORT_THEME: ChartExportTheme = {
  surface: '#FDFCFB',
  surfaceSecondary: '#EDE9E2',
  borderStrong: '#C9C2B6',
  textPrimary: '#1C1917',
  textSecondary: '#44403C',
  textMuted: '#78716C',
  accent: '#D97706',
};

export const DARK_CHART_EXPORT_THEME: ChartExportTheme = {
  surface: '#161412',
  surfaceSecondary: '#1E1B18',
  borderStrong: '#3D3830',
  textPrimary: '#FAF9F7',
  textSecondary: '#D6D0C8',
  textMuted: '#9C948A',
  accent: '#F59E0B',
};

export interface ChartExportRequest {
  type: ExportChartType;
  data: ChartExportDatum[];
  palette: string[];
  theme: ChartExportTheme;
  title: string;
  xLabel: string;
  yLabel: string;
  aggregated?: boolean;
  aggregationMethod?: 'sum' | 'avg' | 'count';
}

const WIDTH = 880;
const HEIGHT = 520;
const MARGIN = { top: 104, right: 44, bottom: 92, left: 112 };
const PLOT_W = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_H = HEIGHT - MARGIN.top - MARGIN.bottom;

const FONT_STACK = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const MONO_STACK = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

function escapeXml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Kept identical to the on-screen formatter so exported labels match the rendered chart. */
export function formatChartValue(val: number): string {
  if (val === undefined || val === null || Number.isNaN(val)) return '-';
  if (Math.abs(val) >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
  if (Math.abs(val) >= 1_000) return `${(val / 1_000).toFixed(1)}K`;
  if (Number.isInteger(val)) return val.toLocaleString();
  return val.toFixed(1);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function header(req: ChartExportRequest, subtitle: string): string {
  const badge =
    req.aggregated && req.aggregationMethod
      ? `\n  <text x="${MARGIN.left}" y="88" font-family="${MONO_STACK}" font-size="13" font-weight="500" fill="${req.theme.textMuted}">Aggregated (${escapeXml(
          req.aggregationMethod.toUpperCase()
        )})</text>`
      : '';
  return [
    `<text x="${MARGIN.left}" y="40" font-family="${FONT_STACK}" font-size="22" font-weight="600" fill="${req.theme.textPrimary}">${escapeXml(
      req.title
    )}</text>`,
    `<text x="${MARGIN.left}" y="66" font-family="${FONT_STACK}" font-size="14" fill="${req.theme.textMuted}">${escapeXml(
      subtitle
    )}</text>${badge}`,
  ].join('\n  ');
}

function axisTitles(req: ChartExportRequest): string {
  return [
    `<text x="${MARGIN.left + PLOT_W / 2}" y="${HEIGHT - 26}" text-anchor="middle" font-family="${FONT_STACK}" font-size="13" font-weight="600" fill="${req.theme.textMuted}">${escapeXml(
      req.type === 'horizontal_bar' ? req.yLabel : req.xLabel
    )}</text>`,
    `<text x="30" y="${MARGIN.top + PLOT_H / 2}" transform="rotate(-90 30 ${MARGIN.top + PLOT_H / 2})" text-anchor="middle" font-family="${FONT_STACK}" font-size="13" font-weight="600" fill="${req.theme.textMuted}">${escapeXml(
      req.type === 'horizontal_bar' ? req.xLabel : req.yLabel
    )}</text>`,
  ].join('\n  ');
}

function gridLines(theme: ChartExportTheme): string {
  const lines: string[] = [];
  for (let i = 0; i <= 4; i += 1) {
    const y = MARGIN.top + (PLOT_H * i) / 4;
    lines.push(
      `<line x1="${MARGIN.left}" y1="${y.toFixed(1)}" x2="${MARGIN.left + PLOT_W}" y2="${y.toFixed(1)}" stroke="${theme.borderStrong}" stroke-width="1" stroke-dasharray="4 4" stroke-opacity="0.55" />`
    );
  }
  return lines.join('\n  ');
}

/** Value-axis tick labels for the two bar families, which are div-rendered on screen. */
function valueTicks(req: ChartExportRequest, maxValue: number): string {
  const ticks: string[] = [];
  for (let i = 0; i <= 4; i += 1) {
    const y = MARGIN.top + PLOT_H - (PLOT_H * i) / 4;
    ticks.push(
      `<text x="${MARGIN.left - 12}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-family="${MONO_STACK}" font-size="12" fill="${req.theme.textMuted}">${escapeXml(
        formatChartValue((maxValue * i) / 4)
      )}</text>`
    );
  }
  return ticks.join('\n  ');
}

function horizontalBars(req: ChartExportRequest, maxValue: number, totalValue: number): string {
  const n = req.data.length;
  const rowH = PLOT_H / n;
  const barH = Math.min(30, rowH * 0.5);
  const parts: string[] = [gridLines(req.theme), valueTicks(req, maxValue)];

  req.data.forEach((d, i) => {
    // Same clamp the on-screen track uses, so bar lengths stay comparable to the live chart.
    const widthPct = Math.max(3, Math.min(100, (d.value / maxValue) * 100));
    const barW = (PLOT_W * widthPct) / 100;
    const y = MARGIN.top + rowH * i + (rowH - barH) / 2;
    const pctOfShown = totalValue > 0 ? ((d.value / totalValue) * 100).toFixed(1) : '0';
    const color = req.palette[i % req.palette.length];
    const label = truncate(d.label, 22);
    const inside = barW > 120;
    parts.push(
      [
        `<g>`,
        `<title>${escapeXml(`${d.label}: ${formatChartValue(d.value)} (${pctOfShown}% of shown)`)}</title>`,
        `<text x="${MARGIN.left - 14}" y="${(y + barH / 2 + 4).toFixed(1)}" text-anchor="end" font-family="${FONT_STACK}" font-size="13" fill="${req.theme.textPrimary}">${escapeXml(label)}</text>`,
        `<rect x="${MARGIN.left}" y="${y.toFixed(1)}" width="${PLOT_W}" height="${barH.toFixed(1)}" rx="${(barH / 2).toFixed(1)}" fill="${req.theme.surfaceSecondary}" />`,
        `<rect x="${MARGIN.left}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="${(barH / 2).toFixed(1)}" fill="${color}" fill-opacity="0.85" />`,
        `<text x="${(MARGIN.left + barW + (inside ? -12 : 12)).toFixed(1)}" y="${(y + barH / 2 + 4).toFixed(1)}" text-anchor="${inside ? 'end' : 'start'}" font-family="${MONO_STACK}" font-size="13" font-weight="600" fill="${inside ? req.theme.surface : req.theme.textSecondary}">${escapeXml(formatChartValue(d.value))}</text>`,
        `</g>`,
      ].join('\n    ')
    );
  });

  parts.push(
    `<line x1="${MARGIN.left}" y1="${MARGIN.top + PLOT_H}" x2="${MARGIN.left + PLOT_W}" y2="${MARGIN.top + PLOT_H}" stroke="${req.theme.borderStrong}" stroke-width="1" />`
  );
  return parts.join('\n  ');
}

function columns(req: ChartExportRequest, maxValue: number): string {
  const n = req.data.length;
  const slot = PLOT_W / n;
  const barW = Math.min(64, slot * 0.62);
  const parts: string[] = [gridLines(req.theme), valueTicks(req, maxValue)];

  req.data.forEach((d, i) => {
    const heightPct = Math.max(6, Math.min(100, (d.value / maxValue) * 100));
    const barH = (PLOT_H * heightPct) / 100;
    const x = MARGIN.left + slot * i + (slot - barW) / 2;
    const yTop = MARGIN.top + PLOT_H - barH;
    const radius = Math.min(8, barW / 2);
    const color = req.palette[i % req.palette.length];
    parts.push(
      [
        `<g>`,
        `<title>${escapeXml(`${d.label}: ${formatChartValue(d.value)}`)}</title>`,
        `<path d="M ${x.toFixed(1)} ${(yTop + radius).toFixed(1)} a ${radius.toFixed(1)} ${radius.toFixed(1)} 0 0 1 ${radius.toFixed(1)} -${radius.toFixed(1)} h ${(barW - radius * 2).toFixed(1)} a ${radius.toFixed(1)} ${radius.toFixed(1)} 0 0 1 ${radius.toFixed(1)} ${radius.toFixed(1)} v ${(barH - radius).toFixed(1)} h -${barW.toFixed(1)} z" fill="${color}" fill-opacity="0.85" />`,
        `<text x="${(x + barW / 2).toFixed(1)}" y="${(yTop - 8).toFixed(1)}" text-anchor="middle" font-family="${MONO_STACK}" font-size="12" font-weight="600" fill="${req.theme.textSecondary}">${escapeXml(formatChartValue(d.value))}</text>`,
        `<text x="${(x + barW / 2).toFixed(1)}" y="${MARGIN.top + PLOT_H + 22}" text-anchor="middle" font-family="${FONT_STACK}" font-size="${n > 6 ? 11 : 13}" fill="${req.theme.textPrimary}">${escapeXml(truncate(d.label, n > 6 ? 12 : 18))}</text>`,
        `</g>`,
      ].join('\n    ')
    );
  });

  parts.push(
    `<line x1="${MARGIN.left}" y1="${MARGIN.top + PLOT_H}" x2="${MARGIN.left + PLOT_W}" y2="${MARGIN.top + PLOT_H}" stroke="${req.theme.borderStrong}" stroke-width="1" />`
  );
  return parts.join('\n  ');
}

function donut(req: ChartExportRequest, totalValue: number): string {
  const cx = 290;
  const cy = MARGIN.top + PLOT_H / 2;
  const radius = 150;
  const arcWidth = 34;
  const circumference = 2 * Math.PI * radius;
  const parts: string[] = [];
  let accumulated = 0;

  parts.push(
    `<circle cx="${cx}" cy="${cy.toFixed(1)}" r="${radius}" fill="none" stroke="${req.theme.surfaceSecondary}" stroke-width="${arcWidth}" />`
  );

  req.data.forEach((d, i) => {
    const percent = totalValue > 0 ? Math.max(0, d.value) / totalValue : 0;
    const color = req.palette[i % req.palette.length];
    parts.push(
      [
        `<g>`,
        `<title>${escapeXml(`${d.label}: ${formatChartValue(d.value)} (${(percent * 100).toFixed(1)}%)`)}</title>`,
        `<circle cx="${cx}" cy="${cy.toFixed(1)}" r="${radius}" fill="transparent" stroke="${color}" stroke-width="${arcWidth}" stroke-dasharray="${(percent * circumference).toFixed(2)} ${circumference.toFixed(2)}" stroke-dashoffset="${(-accumulated * circumference).toFixed(2)}" transform="rotate(-90 ${cx} ${cy.toFixed(1)})" />`,
        `</g>`,
      ].join('\n    ')
    );
    accumulated += percent;
  });

  parts.push(
    `<text x="${cx}" y="${(cy - 6).toFixed(1)}" text-anchor="middle" font-family="${FONT_STACK}" font-size="15" fill="${req.theme.textSecondary}">Total</text>`,
    `<text x="${cx}" y="${(cy + 22).toFixed(1)}" text-anchor="middle" font-family="${MONO_STACK}" font-size="26" font-weight="700" fill="${req.theme.textPrimary}">${escapeXml(formatChartValue(totalValue))}</text>`
  );

  // Legend replaces the on-screen HTML legend list.
  const legendX = 520;
  const rowH = Math.min(34, PLOT_H / Math.max(1, req.data.length));
  req.data.forEach((d, i) => {
    const y = MARGIN.top + rowH * i + rowH / 2;
    const percent = totalValue > 0 ? ((Math.max(0, d.value) / totalValue) * 100).toFixed(1) : '0';
    parts.push(
      `<circle cx="${legendX}" cy="${(y - 4).toFixed(1)}" r="6" fill="${req.palette[i % req.palette.length]}" />`,
      `<text x="${legendX + 18}" y="${y.toFixed(1)}" font-family="${FONT_STACK}" font-size="13" fill="${req.theme.textPrimary}">${escapeXml(truncate(d.label, 20))}</text>`,
      `<text x="${WIDTH - MARGIN.right}" y="${y.toFixed(1)}" text-anchor="end" font-family="${MONO_STACK}" font-size="13" font-weight="600" fill="${req.theme.textSecondary}">${escapeXml(`${formatChartValue(d.value)} · ${percent}%`)}</text>`
    );
  });

  return parts.join('\n  ');
}

function trend(req: ChartExportRequest, maxValue: number, filled: boolean): string {
  const n = req.data.length;
  const grid: string[] = [];
  for (let i = 0; i <= 2; i += 1) {
    const y = MARGIN.top + (PLOT_H * i) / 3;
    grid.push(
      `<line x1="${MARGIN.left}" y1="${y.toFixed(1)}" x2="${MARGIN.left + PLOT_W}" y2="${y.toFixed(1)}" stroke="${req.theme.borderStrong}" stroke-width="1" stroke-dasharray="4 4" stroke-opacity="0.45" />`
    );
  }

  const points = req.data.map((d, i) => ({
    ...d,
    x: n > 1 ? MARGIN.left + (i / (n - 1)) * PLOT_W : MARGIN.left + PLOT_W / 2,
    y: MARGIN.top + PLOT_H - (Math.max(0, d.value) / maxValue) * (PLOT_H * 0.8) - PLOT_H * 0.08,
  }));

  const pathD = points.reduce((acc, p, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`, '');
  const areaD = `${pathD} L ${points[points.length - 1].x.toFixed(1)} ${(MARGIN.top + PLOT_H).toFixed(1)} L ${points[0].x.toFixed(1)} ${(MARGIN.top + PLOT_H).toFixed(1)} Z`;

  const parts = [...grid];
  if (filled) {
    parts.push(`<path d="${areaD}" fill="${req.theme.accent}" fill-opacity="0.2" stroke="none" />`);
  }
  parts.push(
    `<path d="${pathD}" fill="none" stroke="${req.theme.accent}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" />`
  );

  points.forEach((p, i) => {
    parts.push(
      [
        `<g>`,
        `<title>${escapeXml(`${p.label}: ${formatChartValue(p.value)}`)}</title>`,
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" fill="${req.theme.surface}" stroke="${req.theme.accent}" stroke-width="2.5" />`,
        `<text x="${p.x.toFixed(1)}" y="${(p.y - 14).toFixed(1)}" text-anchor="middle" font-family="${MONO_STACK}" font-size="12" font-weight="600" fill="${req.theme.accent}">${escapeXml(formatChartValue(p.value))}</text>`,
        `<text x="${p.x.toFixed(1)}" y="${MARGIN.top + PLOT_H + 24}" text-anchor="middle" font-family="${FONT_STACK}" font-size="${n > 8 ? 10 : 12}" fill="${req.theme.textPrimary}">${escapeXml(truncate(p.label, n > 8 ? 8 : 16))}</text>`,
        `</g>`,
      ].join('\n    ')
    );
  });

  parts.push(
    `<line x1="${MARGIN.left}" y1="${MARGIN.top + PLOT_H}" x2="${MARGIN.left + PLOT_W}" y2="${MARGIN.top + PLOT_H}" stroke="${req.theme.borderStrong}" stroke-width="1" />`
  );
  return parts.join('\n  ');
}

function emptyPlot(theme: ChartExportTheme): string {
  return `<text x="${WIDTH / 2}" y="${HEIGHT / 2}" text-anchor="middle" font-family="${FONT_STACK}" font-size="15" fill="${theme.textMuted}">No data points to render</text>`;
}

/**
 * Builds a complete, standalone SVG document for the currently selected chart.
 * The document carries its own width/height/viewBox, background and resolved paint
 * attributes, so it opens in any viewer without application CSS.
 */
export function buildStandaloneChartSvg(req: ChartExportRequest): string {
  const safePalette = req.palette.length ? req.palette : [req.theme.accent];
  // DuckDB result cells are coerced to finite numbers upstream; this guard keeps a document
  // from ever containing NaN geometry if a caller supplies a non-numeric value.
  const data = (req.data || []).map((d) => ({
    label: String(d.label ?? ''),
    value: Number.isFinite(d.value) ? d.value : 0,
  }));
  const request: ChartExportRequest = { ...req, palette: safePalette, data };
  const maxValue = Math.max(...data.map((d) => d.value), 1);
  const totalValue = data.reduce((acc, d) => acc + Math.max(0, d.value), 0);
  const subtitle = `${data.length} ${data.length === 1 ? 'data point' : 'data points'} · ${request.yLabel} vs ${request.xLabel}`;

  let body: string;
  if (data.length === 0) {
    body = emptyPlot(request.theme);
  } else if (request.type === 'donut') {
    body = donut(request, totalValue);
  } else if (request.type === 'horizontal_bar') {
    body = horizontalBars(request, maxValue, totalValue);
  } else if (request.type === 'bar') {
    body = columns(request, maxValue);
  } else if (request.type === 'area') {
    body = trend(request, maxValue, true);
  } else {
    body = trend(request, maxValue, false);
  }

  const axes = data.length > 0 && request.type !== 'donut' ? axisTitles(request) : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeXml(
    request.title
  )}">
  <title>${escapeXml(request.title)}</title>
  <desc>${escapeXml(subtitle)}</desc>
  <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="${request.theme.surface}" />
  ${header(request, subtitle)}
  ${body}${axes ? `\n  ${axes}` : ''}
</svg>
`;
}
