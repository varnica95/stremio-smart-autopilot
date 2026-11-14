/**
 * Token bucket. `acquire()` resolves when a token is available, so callers queue instead of failing.
 * Used for outbound calls to third-party APIs that publish request limits.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  /** Takes a token if one is available right now. */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    while (!this.tryAcquire()) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const waitMs = Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
      await new Promise((resolve) => setTimeout(resolve, Math.max(5, waitMs)));
    }
  }

  private refill(): void {
    const now = this.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.lastRefill = now;
  }
}

/** Per-key fixed-window limiter for inbound requests (e.g. per client IP). */
export class KeyedRateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const now = this.now();
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      if (this.windows.size > 10_000) this.prune(now);
      return true;
    }
    w.count += 1;
    return w.count <= this.maxPerWindow;
  }

  private prune(now: number): void {
    for (const [key, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(key);
  }
}
