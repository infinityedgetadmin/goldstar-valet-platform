import type { DamageReport } from '@goldstar/platform';

type PanelKey = DamageReport['diagramMarks'][number]['panel'];
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Ported from goldstar-transportation's `src/features/tickets/damage-diagram.tsx` (its own header
 * comment: "a labeled-box schematic, not a pixel-matched trace... no asset for that was available").
 * Kept byte-for-byte identical layout/color data so a claim's evidence-bundle diagram matches what
 * an admin already sees on the ticket detail page — but this is a cross-repo PORT, not a shared
 * import (this repo's Cloud Functions can't import a `'use client'` React component from a sibling
 * Next.js repo, and there's no shared package between them for this). Disclosed: if the dashboard's
 * layout/colors ever change, this copy will silently drift — flagged for the controller as a
 * candidate for promoting into a shared, non-React data module (e.g. `@goldstar/platform/tokens`)
 * in a future task, rather than duplicated by hand indefinitely.
 */
const PANEL_LAYOUT: Record<PanelKey, Rect> = {
  front_bumper: { x: 60, y: 5, w: 80, h: 15 },
  hood: { x: 55, y: 22, w: 90, h: 35 },
  windshield: { x: 55, y: 59, w: 90, h: 25 },
  roof: { x: 55, y: 86, w: 90, h: 70 },
  rear_window: { x: 55, y: 158, w: 90, h: 25 },
  trunk: { x: 55, y: 185, w: 90, h: 35 },
  rear_bumper: { x: 60, y: 222, w: 80, h: 15 },
  front_left_fender: { x: 15, y: 22, w: 38, h: 35 },
  front_left_door: { x: 15, y: 59, w: 38, h: 55 },
  rear_left_door: { x: 15, y: 116, w: 38, h: 55 },
  rear_left_quarter: { x: 15, y: 173, w: 38, h: 47 },
  front_right_fender: { x: 147, y: 22, w: 38, h: 35 },
  front_right_door: { x: 147, y: 59, w: 38, h: 55 },
  rear_right_door: { x: 147, y: 116, w: 38, h: 55 },
  rear_right_quarter: { x: 147, y: 173, w: 38, h: 47 },
  wheels: { x: 70, y: 242, w: 60, h: 20 },
  interior: { x: 5, y: 242, w: 60, h: 20 },
  other: { x: 135, y: 242, w: 60, h: 20 },
};

const KIND_COLOR: Record<DamageReport['diagramMarks'][number]['kind'], string> = {
  scratch: '#f59e0b',
  dent: '#ef4444',
  chip: '#eab308',
  crack: '#dc2626',
  scuff: '#fb923c',
  missing: '#7c3aed',
  stain: '#0891b2',
  other: '#6b7280',
};

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Renders one damage report's `diagramMarks` as a standalone SVG document string (viewBox `0 0 200
 * 270`, matching the dashboard component's own viewBox exactly) — passed to `@resvg/resvg-js`'s
 * `Resvg` for rasterization to PNG before embedding in the PDF (pdfkit has no native SVG support).
 * `label` (e.g. "Check-in") is rendered as a title above the diagram.
 */
export function buildDamageDiagramSvg(report: Pick<DamageReport, 'diagramMarks'>, label: string): string {
  const panelRects = (Object.entries(PANEL_LAYOUT) as [PanelKey, Rect][])
    .map(([, r]) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="3" fill="#f4f2f1" stroke="#d8d3d0" stroke-width="1"/>`)
    .join('');
  const marks = report.diagramMarks
    .map((mark) => {
      const r = PANEL_LAYOUT[mark.panel];
      const cx = r.x + mark.x * r.w;
      const cy = r.y + mark.y * r.h;
      const color = KIND_COLOR[mark.kind];
      const radius = mark.preExisting ? 3.5 : 4.5;
      const opacity = mark.preExisting ? 0.5 : 0.9;
      const stroke = mark.preExisting ? color : '#ffffff';
      return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${color}" fill-opacity="${opacity}" stroke="${stroke}" stroke-width="1"/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 292" width="200" height="292">
    <text x="100" y="14" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="14" fill="#0a0807">${escapeXml(label)}</text>
    <g transform="translate(0, 20)">${panelRects}${marks}</g>
  </svg>`;
}
