import type { BridgeConfig } from '../types';
import type { CenterlineSample, Overlap } from './types';

// Intersection of segment (p1->p2) with (p3->p4) in 2D, or null. Returns the
// crossing point and the parametric t/u along each segment.
function segIntersect(
  p1: [number, number], p2: [number, number],
  p3: [number, number], p4: [number, number],
): { x: number; y: number; t: number; u: number } | null {
  const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null; // parallel
  const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / den;
  const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p1[0] + d1x * t, y: p1[1] + d1y * t, t, u };
}

// Find places where the centerline crosses over itself in plan view. Edges that
// are close together along the lap are skipped (those are just the road's own
// width, not a real overpass).
export function detectOverlaps(samples: CenterlineSample[]): Overlap[] {
  const found: Overlap[] = [];
  const minSeparation = 20; // m along the lap before a crossing counts
  const n = samples.length;
  for (let i = 0; i < n - 1; i++) {
    const a1: [number, number] = [samples[i].pos[0], samples[i].pos[1]];
    const a2: [number, number] = [samples[i + 1].pos[0], samples[i + 1].pos[1]];
    for (let j = i + 2; j < n - 1; j++) {
      if (Math.abs(samples[j].dist - samples[i].dist) < minSeparation) continue;
      const b1: [number, number] = [samples[j].pos[0], samples[j].pos[1]];
      const b2: [number, number] = [samples[j + 1].pos[0], samples[j + 1].pos[1]];
      const hit = segIntersect(a1, a2, b1, b2);
      if (!hit) continue;
      const dA = samples[i].dist + (samples[i + 1].dist - samples[i].dist) * hit.t;
      const dB = samples[j].dist + (samples[j + 1].dist - samples[j].dist) * hit.u;
      found.push({ distA: Math.min(dA, dB), distB: Math.max(dA, dB), x: hit.x, y: hit.y });
    }
  }
  // Merge near-duplicate detections (dense sampling can report a crossing twice).
  const merged: Overlap[] = [];
  for (const o of found) {
    const dup = merged.find((m) => Math.abs(m.distA - o.distA) < 10 && Math.abs(m.distB - o.distB) < 10);
    if (!dup) merged.push(o);
  }
  return merged;
}

function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

// Build a height(dist) function that lifts the "over" pass of each overlap into
// an overpass. `incline` controls ramp slope (steeper = shorter ramps).
export function makeBridgeHeightFn(
  overlaps: Overlap[],
  cfg: BridgeConfig,
  roadWidth: number,
): (dist: number) => number {
  if (!cfg.auto || overlaps.length === 0) return () => 0;

  const clearance = Math.max(1, cfg.clearance);
  const incline = Math.max(0.01, cfg.incline);
  const rampRun = clearance / incline;
  const flatHalf = roadWidth * 1.2; // flat span over the crossing

  // Raise the later pass (distB) of each crossing.
  const bumps = overlaps.map((o) => ({ center: o.distB }));

  return (dist: number): number => {
    let h = 0;
    for (const b of bumps) {
      const d = Math.abs(dist - b.center);
      if (d <= flatHalf) {
        h = Math.max(h, clearance);
      } else if (d <= flatHalf + rampRun) {
        h = Math.max(h, clearance * smoothstep(1 - (d - flatHalf) / rampRun));
      }
    }
    return h;
  };
}
