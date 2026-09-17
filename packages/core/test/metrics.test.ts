import { describe, expect, it } from 'vitest';
import { FrameSampler, formatMarkdown, percentile } from '@core/bench/metrics';

describe('percentile', () => {
  it('returns the median for p50', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it('returns a low value for p5, not the max', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 5)).toBeLessThan(percentile(values, 50));
  });

  it('handles a single sample and an empty list', () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('FrameSampler', () => {
  it('converts frame deltas to FPS percentiles', () => {
    const s = new FrameSampler();
    s.pushDelta(16.7);
    s.pushDelta(16.7);
    s.pushDelta(33.3);
    const r = s.summary();
    expect(r.frames).toBe(3);
    expect(r.p50).toBeGreaterThan(29);
    expect(r.p50).toBeLessThan(61);
    expect(r.p5).toBeLessThanOrEqual(r.p50);
  });

  it('ignores a zero delta rather than reporting infinite FPS', () => {
    const s = new FrameSampler();
    s.pushDelta(0);
    s.pushDelta(16.7);
    expect(Number.isFinite(s.summary().p50)).toBe(true);
  });
});

describe('formatMarkdown', () => {
  it('emits a table row per measurement', () => {
    const md = formatMarkdown([
      { n: 1e6, loadMs: 900, decodeMs: 20, gridMs: 80, firstFrameMs: 120,
        fps: 60, frames: 180, fpsP5: 44, lassoMs: 9, heapMb: 210 }
    ]);
    expect(md.split('\n').length).toBeGreaterThanOrEqual(3);
    expect(md).toContain('1,000,000');
    expect(md).toContain('180');
  });

  it('prints n/a rather than NaN when the browser hides heap size', () => {
    const md = formatMarkdown([
      { n: 1000, loadMs: 1, decodeMs: 1, gridMs: 1, firstFrameMs: 1,
        fps: 60, frames: 180, fpsP5: 60, lassoMs: 1, heapMb: NaN }
    ]);
    expect(md).toContain('n/a');
  });

  it('prints n/a for a percentile that too few frames would make up', () => {
    const md = formatMarkdown([
      { n: 1e7, loadMs: 200, decodeMs: 12, gridMs: 50, firstFrameMs: 2600,
        fps: 2.7, frames: 8, fpsP5: null, lassoMs: 354, heapMb: 921 }
    ]);
    expect(md).toContain('n/a');
    expect(md).not.toContain('61');
  });
});
