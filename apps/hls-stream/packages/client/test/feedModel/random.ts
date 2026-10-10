/** A seeded random source, so every simulated run can be repeated exactly from its seed. */
export class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** Uniform in [0, 1), mulberry32. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  uniform(low: number, high: number): number {
    return low + (high - low) * this.next();
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** Standard normal, Box-Muller. */
  normal(): number {
    const u = Math.max(this.next(), Number.MIN_VALUE);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }

  /** Log-normal with the given median and the standard deviation of its logarithm. */
  logNormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.normal());
  }
}

/** The `p` quantile of `values`, nearest rank, or NaN for none. */
export function quantile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? Number.NaN : values.reduce((sum, value) => sum + value, 0) / values.length;
}
