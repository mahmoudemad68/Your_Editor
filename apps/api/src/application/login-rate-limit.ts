/**
 * Process-local limit for credential endpoints. It does not coordinate across
 * API processes. Account lockout is the cross-process control and lives in the
 * user repository as one conditional SQL update. Entries are kept in least
 * recently used order, including denied attempts. Capacity evicts an old bucket
 * rather than denying every new credential identity. Eviction can forget a
 * process-local budget; persistent account lockout is never evicted here.
 */
export class LoginRateLimit {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  allow(key: string, now: number): boolean {
    this.sweep(now);
    const known = this.hits.get(key);
    const recent = (known ?? []).filter((at) => now - at < this.windowMs);
    if (known === undefined && this.hits.size >= this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    this.hits.delete(key);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  size(): number {
    return this.hits.size;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) {
      return;
    }
    this.lastSweep = now;
    for (const [key, times] of this.hits) {
      const recent = times.filter((at) => now - at < this.windowMs);
      if (recent.length === 0) {
        this.hits.delete(key);
      } else {
        this.hits.set(key, recent);
      }
    }
  }
}
