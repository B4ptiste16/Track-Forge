import type { Segment } from '../types';
import type { CenterlineSample, SegmentSpan, ClosureInfo } from './types';
import { CLOSE_GAP_TOL, CLOSE_HEADING_TOL } from './types';

const STRAIGHT_SPACING = 3; // m between samples on straights
const CORNER_STEP_DEG = 2; // degrees between samples on corners
// ALSO cap the arc-length between corner samples: a fixed angular step alone
// leaves big-radius (long, gentle) curves sampled metres apart, so their kerbs
// and edges facet visibly ("round then pointy") while tight corners stay dense.
const CORNER_MAX_ARC = 2.0; // m between samples on corners, whatever the radius

export interface CenterlineResult {
  samples: CenterlineSample[];
  spans: SegmentSpan[];
  totalLength: number;
}

// Walk the segment list, accumulating position P and heading theta.
// Start at P=(0,0,0), theta=0 (+X forward). Z (elevation) is applied later.
export function buildCenterline(segments: Segment[]): CenterlineResult {
  const samples: CenterlineSample[] = [];
  const spans: SegmentSpan[] = [];

  let px = 0;
  let py = 0;
  let theta = 0;
  let dist = 0;
  let cornerOrdinal = 0;

  // Seed with the very first point so consecutive segments can skip their start.
  samples.push({ pos: [0, 0, 0], heading: 0, dist: 0, segIndex: -1 });

  segments.forEach((seg, segIndex) => {
    const startDist = dist;

    if (seg.kind === 'straight') {
      const len = Math.max(0, seg.length);
      const fx = Math.cos(theta);
      const fy = Math.sin(theta);
      const steps = Math.max(1, Math.ceil(len / STRAIGHT_SPACING));
      for (let k = 1; k <= steps; k++) {
        const t = (len * k) / steps;
        samples.push({
          pos: [px + fx * t, py + fy * t, 0],
          heading: theta,
          dist: startDist + t,
          segIndex,
        });
      }
      px += fx * len;
      py += fy * len;
      dist += len;
      spans.push({ segIndex, kind: 'straight', cornerIndex: -1, startDist, endDist: dist });
    } else {
      const radius = Math.max(0.001, seg.radius);
      const sweep = (Math.max(0, seg.angle) * Math.PI) / 180; // radians swept
      const sign = seg.dir === 'left' ? 1 : -1; // +1 CCW (left), -1 CW (right)

      // Centre of the arc: radius to the left (left turn) or right (right turn).
      const perpX = sign * -Math.sin(theta);
      const perpY = sign * Math.cos(theta);
      const cx = px + radius * perpX;
      const cy = py + radius * perpY;

      const startAngle = Math.atan2(py - cy, px - cx);
      const arcLen = radius * sweep;
      const steps = Math.max(
        1,
        Math.ceil((seg.angle || 0) / CORNER_STEP_DEG),
        Math.ceil(arcLen / CORNER_MAX_ARC), // dense samples on big-radius curves too
      );
      for (let k = 1; k <= steps; k++) {
        const frac = k / steps;
        const phi = startAngle + sign * sweep * frac;
        samples.push({
          pos: [cx + radius * Math.cos(phi), cy + radius * Math.sin(phi), 0],
          heading: theta + sign * sweep * frac,
          dist: startDist + arcLen * frac,
          segIndex,
        });
      }
      // Advance state to the arc end.
      const endPhi = startAngle + sign * sweep;
      px = cx + radius * Math.cos(endPhi);
      py = cy + radius * Math.sin(endPhi);
      theta += sign * sweep;
      dist += arcLen;
      spans.push({
        segIndex,
        kind: 'corner',
        cornerIndex: cornerOrdinal,
        dir: seg.dir,
        startDist,
        endDist: dist,
      });
      cornerOrdinal++;
    }
  });

  return { samples, spans, totalLength: dist };
}

export function computeClosure(samples: CenterlineSample[]): ClosureInfo {
  if (samples.length < 2) {
    return { gap: 0, headingOff: 0, closed: true };
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dx = last.pos[0] - first.pos[0];
  const dy = last.pos[1] - first.pos[1];
  const gap = Math.hypot(dx, dy);

  // Smallest absolute angular difference between end and start heading.
  let diff = (last.heading - first.heading) % (2 * Math.PI);
  if (diff > Math.PI) diff -= 2 * Math.PI;
  if (diff < -Math.PI) diff += 2 * Math.PI;
  const headingOff = Math.abs((diff * 180) / Math.PI);

  return {
    gap,
    headingOff,
    closed: gap < CLOSE_GAP_TOL && headingOff < CLOSE_HEADING_TOL,
  };
}

// Count corner segments (used to keep CornerConfig[] in sync).
export function countCorners(segments: Segment[]): number {
  return segments.filter((s) => s.kind === 'corner').length;
}
