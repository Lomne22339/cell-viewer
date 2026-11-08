import { describe, expect, it } from 'vitest';
import { lodPolicy } from '@core/render/lod';

const bounds: [number, number, number, number] = [-100, -100, 100, 100];
const base = { bounds, budget: 1_000_000, manual: null };

describe('lodPolicy', () => {
  it('draws everything when the dataset fits the budget', () => {
    expect(lodPolicy({ ...base, n: 200_000, zoom: 0 }).renderFraction).toBe(1);
  });

  it('subsamples when the dataset exceeds the budget at low zoom', () => {
    const p = lodPolicy({ ...base, n: 10_000_000, zoom: 0 });
    expect(p.renderFraction).toBeLessThan(1);
    expect(p.renderFraction * 10_000_000).toBeLessThanOrEqual(1_000_000 * 1.001);
  });

  it('raises the fraction as the viewport narrows', () => {
    const wide = lodPolicy({ ...base, n: 10_000_000, zoom: 0 });
    const tight = lodPolicy({ ...base, n: 10_000_000, zoom: 4 });
    expect(tight.renderFraction).toBeGreaterThan(wide.renderFraction);
  });

  it('never exceeds 1 or drops to 0', () => {
    for (const zoom of [-5, 0, 3, 12, 40]) {
      const p = lodPolicy({ ...base, n: 10_000_000, zoom });
      expect(p.renderFraction).toBeGreaterThan(0);
      expect(p.renderFraction).toBeLessThanOrEqual(1);
    }
  });

  it('honours a manual override exactly', () => {
    expect(lodPolicy({ ...base, n: 10_000_000, zoom: 0, manual: 0.25 }).renderFraction).toBe(0.25);
  });

  it('grows point radius as you zoom in, and caps it', () => {
    const wide = lodPolicy({ ...base, n: 1_000_000, zoom: 0 });
    const tight = lodPolicy({ ...base, n: 1_000_000, zoom: 6 });
    expect(tight.radius).toBeGreaterThan(wide.radius);
    expect(lodPolicy({ ...base, n: 1_000_000, zoom: 99 }).radius).toBeLessThanOrEqual(3.5);
  });
});
